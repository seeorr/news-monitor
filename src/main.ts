/** Captura durable → reglas → cola por editor y antigüedad → puntuación → entrega.
 * --capture-only guarda sin modelos ni Telegram; --process-only consume la cola.
 * --dry usa memoria y no envía, pero puede llamar al modelo. --force permite reenvío.
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  analyzeEvent,
  FabricationError,
  scoreEvent,
  Scoring,
  type Analysis,
  type CascadeDeps,
} from "./ai/cascade.ts";
import { loadConfig, loadDotEnv, missingVars, type Config } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { sameStory, tambienLoCuentan, type Grupo } from "./pipeline/agrupar.ts";
import { collectEvents, watchlistEfectiva, recientes } from "./pipeline/collect.ts";
import { neonQueueStore } from "./db/queue.ts";
import { fileQueueStore, memoryQueueStore, type QueueStore } from "./pipeline/queue.ts";
import { captureCandidates, capturedEvent, processQueue, deliverQueue } from "./pipeline/queue-cycle.ts";
import { createLogger, type LogFields, type LogStage } from "./lib/log.ts";
import { applyRules, mereceAlerta } from "./pipeline/rules.ts";
import {
  fileSeenStore, type EstadoEntrega, type Puntuacion, type SeenStore,
} from "./pipeline/seen.ts";

import { formatAlert, sendTelegram } from "./notify/telegram.ts";
import type { NormalizedEvent } from "./schema/event.ts";
import { neonControlStore } from "./db/control.ts";
import { BudgetExhausted, fileControlStore, memoryControlStore, type AiRecord } from "./pipeline/control.ts";
import { decideNews } from "./pipeline/news-policy.ts";
import { deliverNews } from "./pipeline/news-delivery.ts";

// Seguro desde el arranque, incluso antes de cargar configuración y watchlist.
const log = createLogger();
let stage: LogStage = "startup";

async function main(): Promise<number> {
  loadDotEnv();
  const mode = process.env["MONITOR_MODE"]?.trim() || "full";
  if (!["full", "capture-only", "process-only"].includes(mode)) throw new Error("invalid_cycle_mode");
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const captureOnly = process.argv.includes("--capture-only") || mode === "capture-only";
  const processOnly = process.argv.includes("--process-only") || mode === "process-only";
  if ((captureOnly && (processOnly || force)) || (processOnly && (dry || force))) throw new Error("incompatible_cycle_modes");
  const config = loadConfig();
  log("CYCLE_START", { stage });
  for (const variable of missingVars(config)) {
    log("CONFIG_MISSING", { stage, variable: variable.name as LogFields["variable"] });
  }
  const seen = abrirEstado(config);
  // --dry conserva el contrato: no escribe, pero sí puede llamar al modelo.
  // --force trabaja sobre una captura explícita efímera, sin reabrir la cola.
  const queue: QueueStore = dry || force ? memoryQueueStore()
    : config.databaseUrl ? neonQueueStore(config.databaseUrl) : fileQueueStore(config.stateDir);
  const levels = config.newsDeliveryMode === "two-level";
  const control = dry || !levels ? memoryControlStore() : config.databaseUrl ? neonControlStore(config.databaseUrl) : fileControlStore(config.stateDir);
  const retrievedAt = new Date().toISOString();
  let watchlist = processOnly ? await watchlistEfectiva(config) : [];
  let sourceFailure = false;
  if (!processOnly) {
    stage = "collect";
    const collected = await collectEvents(config, { retrievedAt, logger: log,
      onCollected: async (events, source) => {
        stage = "persist";
        const counts = await captureCandidates(queue, events, { now: new Date().toISOString(),
          maxAgeHours: config.maxItemAgeHours, watchlist: source.vigilados });
        if (levels && !dry) for (const event of events) {
          // No sobrescribir una decisión ya puntuada por una mera recaptura.
          if (!await control.getDecision(event.id)) await control.putDecision(event.id,
            decideNews(event, null, { now: retrievedAt, watchlist: source.vigilados, maxPendingHours: config.maxPendingHours, maxItemAgeHours: config.maxItemAgeHours }));
        }
        log("QUEUE_CAPTURE", { stage: "persist", source: source.source, feed: source.feed,
          captured: counts.captured, unique: counts.unique });
      },
    });
    watchlist = collected.vigilados;
    sourceFailure = collected.ok === 0;
    if (sourceFailure) log("NO_SOURCES", { stage, failed: collected.failures.length });
    if (collected.failures.length > 0) log("SOURCES_PARTIAL", { stage, failed: collected.failures.length, ok: collected.ok });
    // Capturadas/únicas salen del acuse de la cola, nunca se infieren de seen.
    const fresh = recientes(collected.events, { now: new Date(retrievedAt), maxAgeHours: config.maxItemAgeHours });
    const candidates = fresh.filter((event) => applyRules(event, { watchlist }).pass);
    log("FRESHNESS", { stage: "freshness", total: collected.events.length, count: fresh.length });
    log("RULES", { stage: "rules", count: candidates.length, discarded: fresh.length - candidates.length });
    for (const event of fresh) {
      log("RULE_REASON", { stage: "rules", source: event.source,
        feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
        reason: applyRules(event, { watchlist }).reasonCode, count: 1 });
    }
  }
  if (captureOnly) {
    log("CAPTURE_ONLY", { stage: "persist" });
    await reportQueue(queue);
    return sourceFailure ? 1 : 0;
  }
  const deps: CascadeDeps | null = config.anthropicApiKey ? {
    client: new Anthropic({ apiKey: config.anthropicApiKey, timeout: 60_000, maxRetries: 0 }),
    modelScoring: config.modelScoring, modelAnalysis: config.modelAnalysis,
    onFabrication: (attempt, violations) => log("FABRICATION_RETRY", { stage: "analysis", attempt, count: violations.length }),
    onScoringSummaryFallback: () => log("SCORING_SUMMARY_FALLBACK", { stage: "scoring" }),
  } : null;
  if (deps && levels) {
    const requests = new Map<string, Omit<AiRecord, "inputTokens" | "outputTokens" | "result" | "costUsd">>();
    deps.beforeRequest = async (info) => {
      const id = randomUUID();
      const reservation = await control.reserve({ id, resource: "ai", units: 1, now: new Date().toISOString(), dayLimit: config.aiCallsDay ?? 120 });
      if (!reservation.allowed) throw new BudgetExhausted(reservation.nextAt);
      const record = { ...info, provider: "anthropic" };
      requests.set(id, record);
      await control.recordAi(id, { ...record, inputTokens: null, outputTokens: null, costUsd: null, result: "uncertain" });
      return id;
    };
    deps.afterRequest = async (id, result) => {
      const meta = requests.get(id)!;
      const inputPrice = meta.stage === "scoring" ? config.aiScoringInputUsd : config.aiAnalysisInputUsd;
      const outputPrice = meta.stage === "scoring" ? config.aiScoringOutputUsd : config.aiAnalysisOutputUsd;
      const costUsd = inputPrice == null || outputPrice == null || result.inputTokens === null || result.outputTokens === null ? null
        : (result.inputTokens * inputPrice + result.outputTokens * outputPrice) / 1_000_000;
      await control.recordAi(id, { ...meta, ...result, costUsd });
    };
  }
  let profundos = 0, deepAttempts = 0;
  const attemptedDelivery = new Set<string>();
  const deliver = (limit: number) => deliverQueue(queue, { limit, excludeIds: attemptedDelivery,
    deliver: async (entry) => {
      attemptedDelivery.add(entry.id);
      const scoring = Scoring.parse(entry.score);
      const duplicateEvents = (await queue.storyContext(entry.event))
        .filter((row) => row.id !== entry.id && row.reason === "duplicate_story" &&
          sameStory(entry.event, row.event, config.umbralAgrupacion)).map(capturedEvent);
      const resultado = await procesar({ representante: capturedEvent(entry), duplicados: duplicateEvents }, {
        config, deps, seen, dry, force, scoring,
        analisisProfundo: deepAttempts < config.maxDeepPerCycle,
        onDeepAttempt: () => { deepAttempts++; },
      });
      if (resultado.deep) profundos++;
      return { complete: resultado.complete !== false, sent: resultado.enviada, failed: resultado.fallida };
    },
    onFailure: (entry, error) => log("EVENT_FAILED", { stage, source: entry.event.source, error }),
  });
  // Primero lo ya puntuado: un ciclo lento no puede posponer indefinidamente
  // entregas anteriores detrás de doce nuevas llamadas al modelo.
  const before = levels ? { sent: 0, failed: 0 } : await deliver(config.maxScoringPerCycle);
  const attemptedLevels = new Set<string>();
  let remainingDeepLevels = config.maxDeepPerCycle;
  const sendTwoLevels = async () => { const result = await deliverNews({ now: new Date().toISOString(), deps, queue, control, seen, watchlist,
    briefHour: config.briefNewsHour ?? 6, briefDay: config.briefNewsDay ?? 24,
    importantHour: config.importantNewsHour ?? 3, importantDay: config.importantNewsDay ?? 12,
    batchSize: config.briefBatchSize ?? 3, briefIntervalMinutes: config.briefIntervalMinutes ?? 60,
    maxPendingHours: config.maxPendingHours ?? 48, maxDeep: remainingDeepLevels, excludeIds: attemptedLevels,
    briefThreshold: config.briefNewsThreshold ?? 5, importantThreshold: config.alertThreshold,
    watchlistImportantThreshold: config.watchlistImportantThreshold ?? 6,
    canSend: Boolean(config.telegramBotToken && config.telegramChatId), dry, force,
    maxItems: config.queueScanLimit ?? 500,
    send: async (body) => {
      const result = await sendTelegram(config.telegramBotToken!, config.telegramChatId!, body);
      return result.state;
    }, afterSent: async (body, event) => {
      log("ALERT_SENT", { stage: "persist", source: event.source });
      await copiarAlGrupo(config, event, body);
    }, onFailure: (error) => log("EVENT_FAILED", { stage: "telegram", error }),
  }); remainingDeepLevels -= result.deep; return result; };
  const beforeLevels = levels ? await sendTwoLevels() : { sent: 0, failed: 0, deep: 0 };
  if (!deps) log("SCORING_UNAVAILABLE", { stage: "scoring" });
  const processing = deps ? await processQueue(queue, {
    maxScoring: config.maxScoringPerCycle, scanLimit: config.queueScanLimit,
    leaseMs: config.processingLeaseMs, groupThreshold: config.umbralAgrupacion, watchlist,
    maxPendingHours: levels ? config.maxPendingHours ?? 48 : undefined,
    onDiscard: async (entry) => { if (!dry) await control.putDecision(entry.id, decideNews(capturedEvent(entry), null,
      { now: new Date().toISOString(), watchlist, maxPendingHours: config.maxPendingHours })); },
    hasProcessed: (id) => { stage = "dedupe"; return force ? Promise.resolve(false) : seen.has(id); },
    score: (event) => { stage = "scoring"; return scoreEvent(event, deps); },
    onPlan: (item) => log("QUEUE_PLAN", { stage: "scoring", source: item.group.representante.source,
      feed: item.group.representante.source === "rss" ? item.group.representante.series_id ?? undefined : undefined,
      priority: item.reason, publisher: item.publisher, points: item.points, agePoints: item.agePoints }),
    onFailure: (entry, error) => log("EVENT_FAILED", { stage: "scoring", source: entry.event.source, error }),
  }) : { pending: 0, attempted: 0, discarded: 0, scored: 0, failed: 0 };
  log("DEDUPE", { stage: "dedupe", discarded: processing.discarded, count: processing.scored });
  if (processing.attempted >= config.maxScoringPerCycle) log("SCORING_LIMIT", { stage: "scoring", count: processing.attempted });
  const remaining = config.maxScoringPerCycle - attemptedDelivery.size;
  const after = !levels && remaining > 0 ? await deliver(remaining) : { sent: 0, failed: 0 };
  const afterLevels = levels ? await sendTwoLevels() : { sent: 0, failed: 0, deep: 0 };
  const delivery = { sent: before.sent + after.sent + beforeLevels.sent + afterLevels.sent,
    failed: before.failed + after.failed + beforeLevels.failed + afterLevels.failed };
  profundos += beforeLevels.deep + afterLevels.deep;
  await reportQueue(queue);
  const failed = processing.failed + delivery.failed;
  log("CYCLE_END", { stage: "cycle", sent: delivery.sent, deep: profundos, failed });
  return sourceFailure || !deps || (failed > 0 && delivery.sent === 0) ? 1 : 0;
}

async function reportQueue(queue: QueueStore): Promise<void> {
  for (const row of await queue.stats()) {
    const [source, feed] = row.source_key.split(":");
    log("QUEUE_STATS", { stage: "persist", source: source as LogFields["source"], feed,
      captured: row.captured, unique: row.unique, pending: row.pending, processing: row.processing,
      scored: row.scored, discarded: row.discarded, processed: row.processed,
      retryable: row.retryable_failed, deliveryPending: row.delivery_pending,
      oldestHours: Math.floor(row.oldest_pending_age_hours) });
    for (const [reason, count] of Object.entries(row.discarded_by_reason)) {
      log("QUEUE_DISCARDED", { stage: "persist", source: source as LogFields["source"], feed,
        queueReason: reason as LogFields["queueReason"], count });
    }
  }
}

interface ProcesarDeps {
  scoring: Scoring;
  config: Config;
  deps: CascadeDeps | null;
  seen: SeenStore;
  dry: boolean;
  /** `--force`: reclama la entrega aunque ya tenga dueño. Lo pide una persona. */
  force: boolean;
  analisisProfundo: boolean;
  onDeepAttempt: () => void;
}

/**
 * `fallida` no es lo contrario de `enviada`: un evento que no llega al umbral no
 * se envía y no ha fallado nada. Marca las alertas que sí se compusieron y no se
 * pudieron dar por entregadas, que son las que hay que mirar.
 */
interface Resultado {
  enviada: boolean;
  deep: boolean;
  fallida?: boolean;
  complete?: boolean;
}

async function procesar(
  grupo: Grupo,
  { config, deps, seen, dry, force, analisisProfundo, scoring, onDeepAttempt }: ProcesarDeps,
): Promise<Resultado> {
  const event = grupo.representante;
  stage = "scoring";
  log("SCORED", { stage, source: event.source, feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
    importance: scoring.importance_score, impact: scoring.market_impact_score });

  const puntuacion: Puntuacion = {
    importance: scoring.importance_score,
    impact: scoring.market_impact_score,
    sentiment: scoring.sentiment,
    oneLiner: scoring.one_liner,
  };

  if (!mereceAlerta(event, scoring, config.alertThreshold)) {
    log("ALERT_SKIPPED", { stage, source: event.source, feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
      importance: scoring.importance_score, impact: scoring.market_impact_score });
    stage = "persist";
    if (!dry) await marcarGrupo(seen, grupo, puntuacion);
    return { enviada: false, deep: false };
  }

  // Una recuperación tras el envío no vuelve a pagar análisis ni libera el
  // reclamo existente. La comprobación final atómica sigue siendo claimAlert.
  const priorDelivery = !dry && !force ? await seen.alertState?.(event.id) : null;
  if (priorDelivery) {
    stage = "persist";
    await marcarGrupo(seen, grupo, puntuacion);
    log("ALERT_BLOCKED", { stage, source: event.source });
    return { enviada: false, deep: false, fallida: priorDelivery !== "sent" };
  }
  if (!dry && (!config.telegramBotToken || !config.telegramChatId)) {
    // Proyectar la nota tampoco depende de las credenciales de Telegram.
    await marcarGrupo(seen, grupo, puntuacion);
    log("TELEGRAM_MISSING", { stage: "telegram" });
    return { enviada: false, deep: false, complete: false, fallida: true };
  }

  let analysis: Analysis | null = null;
  if (scoring.importance_score >= config.deepAnalysisThreshold && analisisProfundo && deps) {
    try {
      stage = "analysis";
      onDeepAttempt();
      analysis = await analyzeEvent(event, deps);
      log("ANALYSIS_OK", { stage, source: event.source });
    } catch (err) {
      // Que el modelo se invente una cifra no puede tumbar el ciclo: se manda la
      // alerta corta, que es cierta, en vez de callarse. Cualquier otro error sí
      // sube: un fallo de red o de credenciales no debe pasar desapercibido.
      if (!(err instanceof FabricationError)) throw err;
      log("ANALYSIS_FALLBACK", { stage, source: event.source });
    }
  } else if (scoring.importance_score >= config.deepAnalysisThreshold) {
    log("ANALYSIS_LIMIT", { stage: "analysis", source: event.source });
  }

  stage = "format";
  const text = formatAlert(event, scoring, analysis, { tambien: tambienLoCuentan(grupo) });
  log("ALERT_READY", { stage, source: event.source });

  const deep = analysis !== null;

  if (dry) {
    log("DRY_RUN", { stage });
    return { enviada: false, deep };
  }
  // Sin credenciales no se reclama nada: el evento vuelve entero en la siguiente
  // vuelta, que es lo que se quiere cuando falta una variable de entorno.
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("TELEGRAM_MISSING", { stage: "telegram" });
    return { enviada: false, deep, complete: false, fallida: true };
  }

  // ── Reclamar, enviar, cerrar ───────────────────────────────────────────────
  // El orden es el arreglo entero. Antes se enviaba y se registraba después, así
  // que morir en los quince segundos de red de Telegram dejaba el registro vacío
  // y la vuelta siguiente escribía otra vez al teléfono de alguien: el índice
  // único de `alerts` impide duplicar la fila, no retirar un mensaje entregado.
  //
  // Es el mismo patrón que ya usa el resumen matinal en `src/pipeline/brief.ts`.
  stage = "persist";
  const token = randomUUID();
  const reclamada = await seen.claimAlert(event.id, { token, force });

  // Marcar va justo después del reclamo y **pase lo que pase con él**. Si el
  // reclamo es ajeno y el evento se quedara sin marcar, volvería cada media hora
  // a puntuarse con Haiku para chocar otra vez contra el mismo reclamo.
  await marcarGrupo(seen, grupo, puntuacion);

  if (!reclamada) {
    // Ni en vuelo, ni entregada, ni en duda: nada de eso se reenvía solo.
    log("ALERT_BLOCKED", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }

  stage = "telegram";
  let estado: EstadoEntrega;
  try {
    estado = (await sendTelegram(config.telegramBotToken, config.telegramChatId, text)).state;
  } catch {
    // Timeout, DNS, socket cortado. Pudo llegar: no se sabe y no se finge saber.
    estado = "uncertain";
  }

  stage = "persist";
  try {
    // `analysis` viaja entero a la base, además de formateado dentro de `text`.
    // Antes solo iba la prosa: se pagaba Opus por un análisis que la base no
    // podía consultar y la ficha de detalle no tenía de dónde sacar
    // catalizadores, riesgos ni activos afectados.
    //
    // Solo se escribe si Telegram lo aceptó, porque `alerts` significa lo que de
    // verdad salió y el dashboard lo lee con ese significado.
    if (estado === "sent") {
      await seen.saveAlert(event, { ...puntuacion, deep, body: text, analysis });
    }
    await seen.finishAlert(event.id, token, estado);
  } catch {
    // Se perdió el acuse de Neon. La entrega se queda en `sending` y nadie la
    // libera: preferible una alerta sin cerrar a una alerta repetida. No se
    // cuenta como enviada aunque saliera, porque lo que no se pudo registrar no
    // se puede afirmar.
    log("ALERT_RECORD_FAILED", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }

  if (estado !== "sent") {
    log(estado === "rejected" ? "ALERT_REJECTED" : "ALERT_UNCERTAIN", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }
  log("ALERT_SENT", { stage, source: event.source });

  await copiarAlGrupo(config, event, text);
  return { enviada: true, deep };
}

/**
 * La misma alerta, íntegra, al grupo compartido.
 *
 * **El grupo ve exactamente lo mismo que el chat privado**, y eso incluye los
 * movimientos de precio y los documentos ante la SEC de la watchlist, que solo
 * existen porque esos valores están vigilados. Es decisión explícita de Alberto,
 * tomada con la fuga delante: el sistema revela **qué** empresas sigue, no
 * **cuánto** tiene en cada una, y esa asimetría le vale.
 *
 * Se dice aquí porque es justo el tipo de cosa que dentro de seis meses parece
 * un descuido. No lo es. Si algún día deja de valer, el sitio donde filtrar es
 * este, y el criterio defendible sería "solo lo que el monitor habría marcado
 * con la watchlist vacía".
 *
 * Va al final, después de que la entrega privada esté cerrada, y sigue ahí por lo
 * mismo de siempre: si el proceso muere durante estos quince segundos de red, la
 * alerta privada ya está entregada y anotada, y no se repite en la vuelta
 * siguiente. El grupo es el destino secundario y paga él ese riesgo —no tiene
 * reclamo propio, así que un `--force` le manda una copia otra vez—.
 *
 * Nada de lo que ocurra aquí puede tumbar el ciclo ni tocar el resultado de la
 * alerta privada, que es la que importa: se registra qué pasó y se sigue. Un
 * fallo se reintenta solo si el evento vuelve a alertar, cosa que no pasará —el
 * registro de vistos ya lo tiene—, así que un rechazo del grupo es una alerta
 * perdida **para el grupo** y hay que poder verlo en el log.
 */
async function copiarAlGrupo(config: Config, event: NormalizedEvent, text: string): Promise<void> {
  if (!config.telegramGroupChatId || !config.telegramBotToken) return;
  try {
    const copia = await sendTelegram(config.telegramBotToken, config.telegramGroupChatId, text);
    log(copia.ok ? "GROUP_SENT" : "GROUP_REJECTED", { stage: "telegram", source: event.source });
  } catch (err) {
    log("GROUP_FAILED", { stage: "telegram", source: event.source, error: err });
  }
}

/**
 * El grupo entero queda registrado, no solo el que se anunció.
 *
 * Si los duplicados no se marcan, vuelven en la vuelta siguiente sin su
 * representante —que ya está visto— y entonces sí se puntúan y se anuncian por
 * separado. El agrupamiento habría servido para retrasar el ruido quince
 * minutos.
 *
 * En el camino de la alerta esto ocurre **antes** de enviar, y no después como
 * antes: marcar es barato y reversible, enviar no. Lo caro es lo que tiene que
 * quedarse para el final.
 */
async function marcarGrupo(seen: SeenStore, grupo: Grupo, puntuacion: Puntuacion): Promise<void> {
  await seen.mark(grupo.representante, puntuacion);
  await marcarDuplicados(seen, grupo);
}

/**
 * Los duplicados se marcan **sin** nota. Se parecen al representante lo bastante
 * para no anunciarse dos veces, pero nadie los ha puntuado: copiarle la suya
 * sería inventar una nota que ningún modelo dio.
 */
async function marcarDuplicados(seen: SeenStore, grupo: Grupo): Promise<void> {
  for (const duplicado of grupo.duplicados) await seen.mark(duplicado);
}

/** El archivo local no sobrevive a un job de Actions: en producción manda Neon. */
function abrirEstado(config: Config): SeenStore {
  stage = "persist";
  if (config.databaseUrl) {
    log("STATE_OPEN", { stage, source: "neon" });
    return neonSeenStore(config.databaseUrl);
  }
  log("STATE_OPEN", { stage, source: "file" });
  return fileSeenStore(config.stateDir);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log("UNHANDLED", { stage, error: err });
    process.exit(1);
  });
