/** Captura durable primero; el presupuesto limita trabajo, nunca almacenamiento. */
import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "../schema/event.ts";
import { publisherForEvent } from "../sources/rss.ts";
import { recientes } from "./collect.ts";
import { applyRules, type RuleOptions } from "./rules.ts";
import { planQueue, type QueuePlanItem } from "./queue-plan.ts";
import { agrupar, sameStory } from "./agrupar.ts";
import type { QueueEntry, QueueScore, QueueStore } from "./queue.ts";

export async function captureCandidates(
  queue: QueueStore, events: NormalizedEvent[],
  options: RuleOptions & { now: string; maxAgeHours: number },
) {
  const fresh = new Set(recientes(events, { now: new Date(options.now), maxAgeHours: options.maxAgeHours }).map((e) => e.id));
  return queue.capture(events.map((event) => {
    const rule = applyRules(event, options);
    const reason = !fresh.has(event.id) ? "stale_at_capture" as const
      : rule.pass ? null : rule.reasonCode === "low_signal" ? "rules_low_signal" as const : "rules_no_match" as const;
    return { event, publisher: publisherForEvent(event),
      ...(reason ? { decision: { state: "discarded" as const, reason } } : {}) };
  }), options.now);
}

export function capturedEvent(entry: QueueEntry): NormalizedEvent {
  return { ...entry.event, publication_at: entry.publication_at,
    data_period_at: entry.data_period_at, first_captured_at: entry.first_captured_at };
}

export interface QueueProcessingOptions extends RuleOptions {
  maxScoring: number;
  scanLimit?: number;
  leaseMs?: number;
  groupThreshold?: number;
  maxPendingHours?: number;
  onDiscard?: (entry: QueueEntry, reason: "pending_expired") => Promise<void>;
  now?: () => string;
  hasProcessed: (id: string) => Promise<boolean>;
  score: (event: NormalizedEvent) => Promise<QueueScore>;
  onPlan?: (item: QueuePlanItem) => void;
  onFailure?: (entry: QueueEntry, error: unknown) => void;
  onScored?: (event: NormalizedEvent) => Promise<void>;
  enrich?: (event: NormalizedEvent) => Promise<NormalizedEvent>;
}

/** No vuelve a aplicar frescura a una candidata que ya entró en la cola. */
export async function processQueue(queue: QueueStore, options: QueueProcessingOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const pending = await queue.listPending(now(), options.scanLimit);
  const plan = planQueue(pending, { now: new Date(now()), limit: pending.length, capacity: options.maxScoring,
    watchlist: options.watchlist, groupThreshold: options.groupThreshold });
  let attempted = 0, scored = 0, failed = 0, discarded = 0;
  for (const item of plan) {
    if (attempted >= options.maxScoring) break;
    // El límite de planificación no corta la identidad de una historia. Busca
    // también copias fuera del escaneo y resultados de capturas anteriores.
    const peers = (await queue.storyContext(item.group.representante))
      .filter((row) => sameStory(item.group.representante, row.event, options.groupThreshold));
    const resolved = peers.some((row) => row.state === "scored" ||
      (row.state === "discarded" && ["duplicate_story", "legacy_processed"].includes(row.reason ?? "")));
    const candidates = [...new Map([...item.entries, ...peers].map((row) => [row.id, row])).values()]
      .filter((row) => row.state !== "scored" && row.state !== "discarded");
    const expanded = agrupar(candidates.map((row) => row.event), { umbral: options.groupThreshold })
      .find((group) => [group.representante, ...group.duplicados].some((e) => e.id === item.group.representante.id));
    if (!expanded) continue;
    const members = [expanded.representante, ...expanded.duplicados];
    const token = randomUUID();
    const owned = await queue.claim(members.map((row) => row.id), { token, now: now(), leaseMs: options.leaseMs, allOrNothing: true });
    if (owned.length === 0) continue;
    // Todo el grupo o nada: puntuar una copia sin su representante en vuelo
    // podría crear dos entregas con identificadores distintos.
    const representative = owned.find((row) => row.id === expanded.representante.id)!;
    if (options.maxPendingHours !== undefined && Date.parse(now()) >= Date.parse(representative.first_captured_at) + options.maxPendingHours * 3600_000) {
      await queue.finishBatch(owned.map((row) => ({ id: row.id, outcome: { state: "discarded", reason: "pending_expired" } })), token, now());
      for (const row of owned) await options.onDiscard?.(row, "pending_expired");
      discarded += owned.length; continue;
    }
    if (resolved || await options.hasProcessed(representative.id)) {
      await queue.finishBatch(owned.map((row) => ({ id: row.id,
        outcome: { state: "discarded", reason: resolved ? "duplicate_story" : "legacy_processed" } })), token, now());
      discarded += owned.length;
      continue;
    }
    options.onPlan?.(item);
    attempted++;
    let score: QueueScore;
    let enriched = capturedEvent(representative);
    try {
      if (options.enrich) enriched = await options.enrich(enriched);
      // El RSS oficial puede traer solo el título. Tras leer el comunicado,
      // comprobar otra vez: la prensa pudo haber entregado ya ese mismo hecho.
      const resolvedAfterEnrichment = enriched.summary !== representative.event.summary &&
        (await queue.storyContext(enriched)).some((row) => row.id !== representative.id && row.state === "scored" &&
          sameStory(enriched, row.event, options.groupThreshold));
      if (resolvedAfterEnrichment) {
        await queue.finishBatch(owned.map((row) => ({ id: row.id, outcome: { state: "discarded", reason: "duplicate_story",
          event: row.id === representative.id ? enriched : row.event } })), token, now());
        discarded += owned.length; attempted--; continue;
      }
      score = await options.score(enriched);
    }
    catch (error) {
      const budget = (error as { code?: string })?.code === "AI_BUDGET_EXHAUSTED";
      await queue.finishBatch(owned.map((row) => ({ id: row.id,
        outcome: { state: "retryable_failed", reason: budget ? "budget_exhausted" : "scoring_failed" } })), token, now());
      failed++;
      options.onFailure?.(representative, error);
      if (budget) break;
      continue;
    }
    // Representante + duplicados cambian juntos. Morir aquí no deja una copia
    // pendiente que pueda anunciarse en otra vuelta sin su representante.
    await queue.finishBatch(owned.map((row) => ({ id: row.id, outcome: row.id === representative.id
      ? { state: "scored", score, needs_delivery: true, event: enriched }
      : { state: "discarded", reason: "duplicate_story" } })), token, now());
    scored++;
    discarded += owned.length - 1;
    await options.onScored?.(enriched);
  }
  return { pending: pending.length, attempted, scored, failed, discarded };
}

/**
 * Finaliza también puntuaciones bajo umbral: primero proyecta en SeenStore.
 * Si falla la proyección o el análisis previo al reclamo, la nota sigue aquí.
 * `complete` significa que no queda reintento automático, no que Telegram envió.
 */
export async function deliverQueue(
  queue: QueueStore,
  options: { limit: number; excludeIds?: ReadonlySet<string>; deliver: (entry: QueueEntry) => Promise<{ complete: boolean; sent: boolean; failed?: boolean }>;
    onFailure?: (entry: QueueEntry, error: unknown) => void },
) {
  let sent = 0, failed = 0;
  // El conjunto puede crecer desde el callback; acotar el listado antes de entrar.
  const entries = (await queue.listDeliveryPending(options.limit + (options.excludeIds?.size ?? 0)))
    .filter((entry) => !options.excludeIds?.has(entry.id)).slice(0, options.limit);
  for (const entry of entries) {
    try {
      const result = await options.deliver(entry);
      if (result.complete) await queue.completeDelivery(entry.id);
      if (result.sent) sent++;
      if (result.failed) failed++;
    } catch (error) { failed++; options.onFailure?.(entry, error); }
  }
  return { sent, failed };
}
