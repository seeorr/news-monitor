import { randomUUID } from "node:crypto";
import { analyzeEvent, type CascadeDeps, type Scoring } from "../ai/cascade.ts";
import { formatImportant, formatInteresting, formatNewsBatch } from "../notify/news-formats.ts";
import { RETRY_AFTER_POR_DEFECTO_MS } from "../notify/telegram.ts";
import type { QueueEntry, QueueStore } from "./queue.ts";
import type { EstadoEntrega, EntregaReclamada, ResultadoEnvio, SeenStore, Puntuacion } from "./seen.ts";
import type { ControlStore } from "./control.ts";
import { decideNews, type NewsDecision } from "./news-policy.ts";
import { capturedEvent } from "./queue-cycle.ts";
import type { RuleOptions } from "./rules.ts";
import { relatedUpdate } from "./agrupar.ts";
import { criticalMacro } from "./critical-macro.ts";
export type NewsDeliveryOptions = RuleOptions & {
  now: string; deps: CascadeDeps | null; queue: QueueStore; control: ControlStore; seen: SeenStore;
  briefHour: number; briefDay: number; importantHour: number; importantDay: number;
  batchSize: number; briefIntervalMinutes: number; maxPendingHours: number; maxDeep: number;
  briefThreshold: number; importantThreshold: number; watchlistImportantThreshold: number;
  canSend: boolean; dry?: boolean; force?: boolean; maxItems: number;
  /**
   * Devolver el estado a secas sigue valiendo y significa lo de siempre. Con
   * `ResultadoEnvio` entero se distingue ademas un 429 —que se puede reintentar
   * porque consta que Telegram no acepto nada— de un 400, que no vuelve jamas.
   */
  send: (body: string) => Promise<EstadoEntrega | ResultadoEnvio>;
  onFailure?: (error: unknown) => void;
  /**
   * La copia al destino secundario. Su desenlace es **suyo**: lo que devuelva
   * —o lance— no toca el de la alerta privada, que a estas alturas ya esta
   * entregada y anotada. Sin valor de vuelta no se anota nada, que es lo que
   * habia hasta ahora.
   */
  afterSent?: (body: string, event: QueueEntry["event"]) => Promise<EstadoEntrega | ResultadoEnvio | void>;
  excludeIds?: Set<string>;
  onlyCritical?: boolean;
};
type Ready = { entry: QueueEntry; decision: NewsDecision; scoring: Scoring };
export async function deliverNews(options: NewsDeliveryOptions) {
  const { queue, control, seen } = options;
  const candidates = (await queue.listDeliveryPending(options.maxItems)).filter((entry) => !options.excludeIds?.has(entry.id) && (!options.onlyCritical || criticalMacro(entry.event)));
  const brief: Ready[] = [];
  const important: Ready[] = [];
  let sent = 0, failed = 0, deep = 0, groupSent = 0, groupFailed = 0, telegramUnconfigured = false;
  for (const entry of candidates) {
    const event = capturedEvent(entry), scoring = entry.score as Scoring;
    const decision: NewsDecision = decideNews(event, scoring, options);
    if (decision.level === "important") {
      const previous = (await queue.storyContext(event)).filter((row) => row.id !== entry.id && row.state === "scored" && relatedUpdate(row.event, event));
      for (const row of previous) {
        if (await seen.alertState?.(row.id) === "sent") {
          decision.updateOf = { eventId: row.id, sourceUrl: row.event.source_url,
            previousFact: row.score!.one_liner, change: scoring.one_liner };
          decision.reasons.push("material_update_of_delivered_story"); break;
        }
      }
    }
    if (!options.dry) {
      await control.putDecision(entry.id, decision);
      await seen.mark(event, points(scoring));
    }
    if (!decision.eligible.telegramBrief && !decision.eligible.importantAlert) {
      if (!options.dry) await queue.completeDelivery(entry.id);
      continue;
    }
    const entrega = await estadoEntrega(entry.id);
    if (entrega && !options.force) {
      // `deferred` es lo unico que vuelve, y no antes de su plazo. El resto
      // —en vuelo, entregada, rechazada o en duda— cierra la cola aqui.
      if (entrega.estado === "deferred") {
        if (entrega.nextAttemptAt && Date.parse(entrega.nextAttemptAt) > Date.parse(options.now)) continue;
      } else {
        if (!options.dry) await queue.completeDelivery(entry.id);
        if (entrega.estado !== "sent") failed++;
        continue;
      }
    }
    const item: Ready = { entry, decision, scoring };
    // Un breve cuya redaccion no se puede respaldar con cifras del original
    // lanza `short_fact_not_supported`, y eso esta bien: el guardarrail
    // antifabricacion hace su trabajo. Lo que estaba mal era CUANDO se
    // descubria. `f7e6b00` ya evito que arrastrara al lote entero, pero la
    // comprobacion seguia dentro del lote ya recortado por `batchSize`: tres
    // irredactables por delante llenaban el lote, se apartaban las tres y el
    // ciclo terminaba sin mandar nada, con las sanas intactas detras. Y como
    // seguian `delivery_pending`, volvian a encabezar la cola en cada vuelta:
    // el mismo fallo determinista, para siempre, hasta caducar a las 48 h.
    //
    // Se comprueba aqui, antes de repartir en niveles, y el que no se puede
    // redactar se cierra explicitamente. `formatInteresting` sirve de criba
    // tambien para el nivel importante: `formatImportant` exige exactamente el
    // mismo respaldo de la frase, y su degradacion es este mismo formato.
    try { formatInteresting(capturedEvent(entry), scoring); }
    catch (error) { failed++; options.onFailure?.(error); await cerrarSinEntregar(item, "deferred_content_unsupported_fact"); continue; }
    (decision.level === "important" ? important : brief).push(item);
  }
  // Sin credenciales no hay entrega posible, y callarlo deja la cola creciendo
  // en silencio hasta que todo caduca. Se anota en cada candidata y se dice.
  if (!options.canSend && !options.dry && (important.length || brief.length)) {
    telegramUnconfigured = true;
    for (const item of [...important, ...brief]) {
      options.excludeIds?.add(item.entry.id);
      await anotar(item, "telegram_unconfigured", null);
    }
    options.onFailure?.(new Error("telegram_unconfigured"));
    return { sent, failed, deep, groupSent, groupFailed, telegramUnconfigured };
  }
  // La cuota de importantes no depende de cuándo se envió el último boletín.
  for (const item of important) {
    try {
      options.excludeIds?.add(item.entry.id);
      if (!options.canSend || options.dry) continue;
      const reservation = await control.reserve({ id: `news:${randomUUID()}`, resource: "important", units: 1,
        now: options.now, hourLimit: options.importantHour, dayLimit: options.importantDay });
      if (!reservation.allowed) { await anotar(item, `deferred_quota_${reservation.reason}`, reservation.nextAt); continue; }
      const event = capturedEvent(item.entry);
      let analysis = null;
      if (options.deps && item.decision.relevance.evidence === "sufficient" && deep < options.maxDeep) {
        deep++;
        try { analysis = await analyzeEvent(event, options.deps); }
        catch (error) { options.onFailure?.(error); }
      }
      let body: string;
      try { body = analysis ? formatImportant(event, item.scoring, analysis) : formatInteresting(event, item.scoring); }
      catch { analysis = null; body = formatInteresting(event, item.scoring); }
      if (!analysis) {
        item.decision.reasons.push("important_degraded_to_supported_brief");
        // Se guarda en el propio item: lo que se persista despues —un
        // aplazamiento, el desenlace del grupo— no puede borrar este formato.
        item.decision = { ...item.decision, deliveryFormat: "brief_fallback" } as NewsDecision;
        await control.putDecision(item.entry.id, item.decision);
      }
      if (item.decision.updateOf) body = `Actualización material de una noticia anterior\nAntes: ${item.decision.updateOf.previousFact}\nAhora: ${item.decision.updateOf.change}\n\n${body}`;
      await sendItems([item], body, Boolean(analysis), analysis);
    } catch (error) { failed++; options.onFailure?.(error); }
  }
  if (brief.length && options.canSend && !options.dry) {
    // Cada intento reserva de nuevo; un fallo previo no salta la cuota de mañana.
    // La idempotencia de red pertenece al reclamo durable POR NOTICIA.
    let items = brief.slice(0, Math.min(options.batchSize, options.briefHour, options.briefDay));
    for (const item of items) options.excludeIds?.add(item.entry.id);
    if (!items.length) {
      for (const item of brief) await anotar(item, "deferred_quota_brief_disabled", null);
      return { sent, failed, deep, groupSent, groupFailed, telegramUnconfigured };
    }
    try {
      while (items.length) {
        let body: string;
        // Cada breve ya viene comprobado uno a uno desde el reparto de niveles.
        // Aqui solo puede fallar lo que depende del lote: la longitud total.
        // Un lote demasiado largo se reduce; si ni una sola cabe, se cierra ella
        // y no el canal —y se cierra de verdad, porque recortar un unico breve
        // que no cabe da el mismo resultado en cada ciclo—.
        try { body = formatNewsBatch(items.map((i) => ({ event: capturedEvent(i.entry), scoring: i.scoring }))); }
        catch (error) {
          options.onFailure?.(error);
          const solo = items.length === 1 ? items[0] : undefined;
          if (solo) { failed++; await cerrarSinEntregar(solo, "deferred_content_too_long"); break; }
          items = items.slice(0, -1); continue;
        }
        const reservation = await control.reserve({ id: `batch:${randomUUID()}`, resource: "brief", units: items.length,
          now: options.now, hourLimit: options.briefHour, dayLimit: options.briefDay,
          minimumIntervalMs: options.briefIntervalMinutes * 60_000 });
        if (reservation.allowed) { await sendItems(items, body, false, null); break; }
        for (const item of items) await anotar(item, `deferred_quota_${reservation.reason}`, reservation.nextAt);
        if (reservation.reason === "interval" || items.length === 1) break;
        items = items.slice(0, -1);
      }
    } catch (error) { failed++; options.onFailure?.(error); }
  }
  return { sent, failed, deep, groupSent, groupFailed, telegramUnconfigured };

  /** Estado durable de la entrega, con el plazo si lo tiene. */
  async function estadoEntrega(id: string): Promise<EntregaReclamada | null> {
    if (seen.alertDelivery) return seen.alertDelivery(id);
    const estado = await seen.alertState?.(id);
    return estado ? { estado, nextAttemptAt: null } : null;
  }

  /** Deja escrito por que no salio, sin cerrar nada. `razon` ya viene con su prefijo. */
  async function anotar(item: Ready, razon: string, nextAt: string | null) {
    if (options.dry) return;
    item.decision = { ...item.decision, reasons: [...item.decision.reasons, razon], nextAt } as NewsDecision;
    await control.putDecision(item.entry.id, item.decision);
  }

  /**
   * Cierra una noticia que no se puede redactar: no salio nada y no va a salir.
   *
   * Reintentarla no es que sea caro, es que es imposible: la entrada del formato
   * son el evento y su puntuacion, y las dos son las mismas en cada ciclo. Lo
   * unico que cambiaria el resultado seria volver a puntuar, y esta ruta no
   * puntua. Asi que se cierra explicitamente **y distinto de entregado**: se
   * escribe `undeliverable` en la maquina de estados de la entrega —que no es
   * `sent` y no escribe `alerts`— y se suelta `delivery_pending`, que es lo que
   * la sacaba de la cabeza de la cola. La noticia no se borra ni se marca como
   * enviada: sigue entera en la cola, puntuada, con su motivo al lado.
   */
  async function cerrarSinEntregar(item: Ready, razon: string) {
    if (options.dry) return;
    await anotar(item, razon, null);
    // Antes de soltar la cola: si el proceso muere en medio, la vuelta siguiente
    // encuentra el cierre puesto y termina el trabajo. Al reves lo perderia.
    await seen.markUndeliverable?.(item.entry.id);
    await queue.completeDelivery(item.entry.id);
  }
  async function sendItems(items: Ready[], body: string, isDeep: boolean, analysis: Awaited<ReturnType<typeof analyzeEvent>> | null) {
    const owned: { item: Ready; token: string }[] = [];
    for (const item of items) {
      const token = randomUUID();
      if (await seen.claimAlert(item.entry.id, { token, force: options.force, now: options.now })) owned.push({ item, token });
    }
    if (!owned.length) return;
    // Si otro consumidor reclamó una parte, nunca incluirla en el mensaje.
    if (owned.length !== items.length) body = formatNewsBatch(owned.map(({ item }) => ({ event: capturedEvent(item.entry), scoring: item.scoring })));
    let resultado: ResultadoEnvio;
    try {
      const respuesta = await options.send(body);
      resultado = typeof respuesta === "string" ? { state: respuesta } : respuesta;
    } catch { resultado = { state: "uncertain" }; }
    // Cuatro desenlaces, y solo uno vuelve solo. `sent` escribe `alerts`. Un
    // rechazo recuperable —429, y nada mas— se aplaza con su plazo, porque
    // Telegram ha dicho por escrito que no acepto nada y reintentar no puede
    // duplicar. Un rechazo permanente y un resultado incierto se cierran, y el
    // incierto ademas se queda bloqueado hasta que lo mire una persona:
    // `uncertain` y `sending` NO se liberan por tiempo, jamas.
    const aplazable = resultado.state === "rejected" && resultado.rejection === "recoverable";
    const nextAttemptAt = aplazable
      ? new Date(Date.parse(options.now) + (resultado.retryAfterMs ?? RETRY_AFTER_POR_DEFECTO_MS)).toISOString() : null;
    for (const { item, token } of owned) {
      // Si falla cualquiera de estas escrituras, su claim sending persiste y
      // nadie reenvía automáticamente el mensaje de resultado incierto.
      if (resultado.state === "sent") await seen.saveAlert(capturedEvent(item.entry), { ...points(item.scoring), deep: isDeep, body, analysis });
      await seen.finishAlert(item.entry.id, token, aplazable ? "deferred" : resultado.state, nextAttemptAt);
      // Una entrega aplazada sigue pendiente en la cola a proposito: es la unica
      // forma de que la vuelta siguiente la vuelva a coger sin `--force`.
      if (aplazable) await anotar(item, "deferred_transport_rate_limited", nextAttemptAt);
      else await queue.completeDelivery(item.entry.id);
    }
    if (resultado.state !== "sent") { failed++; return; }
    sent++;
    // Destino secundario solo después de cerrar el acuse privado, y con su
    // propio desenlace: que el grupo rechace la copia no cambia nada de la
    // alerta privada, que ya esta entregada y anotada. Hasta ahora los dos
    // fallos posibles del grupo —rechazo y caida— se tragaban en el mismo
    // `catch` y quedaban indistinguibles entre si y del privado.
    if (!options.afterSent) return;
    let etiqueta: string | null = null;
    try {
      const copia = await options.afterSent(body, owned[0]!.item.entry.event);
      const estadoCopia = typeof copia === "string" ? copia : copia?.state;
      etiqueta = estadoCopia ? `group_copy_${estadoCopia}` : null;
    } catch (error) { options.onFailure?.(error); etiqueta = "group_copy_failed"; }
    if (!etiqueta) return;
    if (etiqueta === "group_copy_sent") groupSent++; else groupFailed++;
    for (const { item } of owned) await anotar(item, etiqueta, null);
  }
}
function points(scoring: Scoring): Puntuacion {
  return { importance: scoring.importance_score, impact: scoring.market_impact_score, sentiment: scoring.sentiment, oneLiner: scoring.one_liner };
}
