import { randomUUID } from "node:crypto";
import { analyzeEvent, type CascadeDeps, type Scoring } from "../ai/cascade.ts";
import { formatImportant, formatInteresting, formatNewsBatch } from "../notify/news-formats.ts";
import type { QueueEntry, QueueStore } from "./queue.ts";
import type { SeenStore, Puntuacion } from "./seen.ts";
import type { ControlStore } from "./control.ts";
import { decideNews, type NewsDecision } from "./news-policy.ts";
import { capturedEvent } from "./queue-cycle.ts";
import type { RuleOptions } from "./rules.ts";
import { relatedUpdate } from "./agrupar.ts";
export type NewsDeliveryOptions = RuleOptions & {
  now: string; deps: CascadeDeps | null; queue: QueueStore; control: ControlStore; seen: SeenStore;
  briefHour: number; briefDay: number; importantHour: number; importantDay: number;
  batchSize: number; briefIntervalMinutes: number; maxPendingHours: number; maxDeep: number;
  briefThreshold: number; importantThreshold: number; watchlistImportantThreshold: number;
  canSend: boolean; dry?: boolean; force?: boolean; maxItems: number;
  send: (body: string) => Promise<"sent" | "rejected" | "uncertain">;
  onFailure?: (error: unknown) => void;
  afterSent?: (body: string, event: QueueEntry["event"]) => Promise<void>;
  excludeIds?: Set<string>;
};
type Ready = { entry: QueueEntry; decision: NewsDecision; scoring: Scoring };
export async function deliverNews(options: NewsDeliveryOptions) {
  const { queue, control, seen } = options;
  const candidates = (await queue.listDeliveryPending(options.maxItems)).filter((entry) => !options.excludeIds?.has(entry.id));
  const brief: Ready[] = [];
  const important: Ready[] = [];
  let sent = 0, failed = 0, deep = 0;
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
    const state = await seen.alertState?.(entry.id);
    if (state && !options.force) {
      if (!options.dry) await queue.completeDelivery(entry.id);
      if (state !== "sent") failed++;
      continue;
    }
    (decision.level === "important" ? important : brief).push({ entry, decision, scoring });
  }
  // La cuota de importantes no depende de cuándo se envió el último boletín.
  for (const item of important) {
    try {
      options.excludeIds?.add(item.entry.id);
      if (!options.canSend || options.dry) continue;
      const reservation = await control.reserve({ id: `news:${randomUUID()}`, resource: "important", units: 1,
        now: options.now, hourLimit: options.importantHour, dayLimit: options.importantDay });
      if (!reservation.allowed) { await defer(item, reservation.reason, reservation.nextAt); continue; }
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
        await control.putDecision(item.entry.id, { ...item.decision, deliveryFormat: "brief_fallback" } as NewsDecision);
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
      for (const item of brief) await defer(item, "brief_disabled", null);
      return { sent, failed, deep };
    }
    try {
      while (items.length) {
        const body = formatNewsBatch(items.map((i) => ({ event: capturedEvent(i.entry), scoring: i.scoring })));
        const reservation = await control.reserve({ id: `batch:${randomUUID()}`, resource: "brief", units: items.length,
          now: options.now, hourLimit: options.briefHour, dayLimit: options.briefDay,
          minimumIntervalMs: options.briefIntervalMinutes * 60_000 });
        if (reservation.allowed) { await sendItems(items, body, false, null); break; }
        for (const item of items) await defer(item, reservation.reason, reservation.nextAt);
        if (reservation.reason === "interval" || items.length === 1) break;
        items = items.slice(0, -1);
      }
    } catch (error) { failed++; options.onFailure?.(error); }
  }
  return { sent, failed, deep };

  async function defer(item: Ready, reason: string, nextAt: string | null) {
    await control.putDecision(item.entry.id, { ...item.decision, reasons: [...item.decision.reasons, `deferred_${reason}`], nextAt } as NewsDecision);
  }
  async function sendItems(items: Ready[], body: string, isDeep: boolean, analysis: Awaited<ReturnType<typeof analyzeEvent>> | null) {
    const owned: { item: Ready; token: string }[] = [];
    for (const item of items) {
      const token = randomUUID();
      if (await seen.claimAlert(item.entry.id, { token, force: options.force })) owned.push({ item, token });
    }
    if (!owned.length) return;
    // Si otro consumidor reclamó una parte, nunca incluirla en el mensaje.
    if (owned.length !== items.length) body = formatNewsBatch(owned.map(({ item }) => ({ event: capturedEvent(item.entry), scoring: item.scoring })));
    let state: "sent" | "rejected" | "uncertain";
    try { state = await options.send(body); } catch { state = "uncertain"; }
    for (const { item, token } of owned) {
      // Si falla cualquiera de estas escrituras, su claim sending persiste y
      // nadie reenvía automáticamente el mensaje de resultado incierto.
      if (state === "sent") await seen.saveAlert(capturedEvent(item.entry), { ...points(item.scoring), deep: isDeep, body, analysis });
      await seen.finishAlert(item.entry.id, token, state);
      await queue.completeDelivery(item.entry.id);
    }
    if (state === "sent") {
      sent++;
      // Destino secundario solo después de cerrar el acuse privado.
      try { await options.afterSent?.(body, owned[0]!.item.entry.event); }
      catch (error) { options.onFailure?.(error); }
    } else failed++;
  }
}
function points(scoring: Scoring): Puntuacion {
  return { importance: scoring.importance_score, impact: scoring.market_impact_score, sentiment: scoring.sentiment, oneLiner: scoring.one_liner };
}
