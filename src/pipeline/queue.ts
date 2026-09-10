/**
 * Cola de captura y procesamiento. No es el registro de eventos procesados ni
 * el de entregas: capturar no marca SeenStore y una lease solo protege scoring.
 * Las entregas siguen protegidas exclusivamente por alert_deliveries.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NormalizedEvent } from "../schema/event.ts";
import { criticalMacro, rateFact } from "./critical-macro.ts";

export const QUEUE_STATES = ["pending", "processing", "scored", "discarded", "retryable_failed"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
export const QUEUE_REASONS = [
  "stale_at_capture", "rules_no_match", "rules_low_signal", "duplicate_story",
  "legacy_processed", "scoring_failed", "processing_expired", "analysis_failed", "delivery_failed", "budget_exhausted", "pending_expired",
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];
export const DEFAULT_PROCESSING_LEASE_MS = 15 * 60_000;
export const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;

/** Copia neutral del resultado necesario para reanudar sin volver a puntuar. */
export const QueueScore = z.object({
  importance_score: z.number().int().min(0).max(10),
  market_impact_score: z.number().int().min(0).max(10),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  needs_alert: z.boolean(),
  one_liner: z.string().max(200),
});
export type QueueScore = z.infer<typeof QueueScore>;

export interface QueueCapture {
  event: NormalizedEvent;
  /** Agrupa feeds de un editor; no debe ser el id de cada sección. */
  publisher: string;
  /** Null significa desconocida. Jamás se rellena con la captura. */
  publication_at?: string | null;
  /** Periodo del dato macro, que puede ser meses anterior a su publicación. */
  data_period_at?: string | null;
  decision?: { state: "discarded"; reason: QueueReason };
}

const Instant = z.string().refine((value) => Number.isFinite(Date.parse(value)), "fecha inválida");
const EntrySchema = z.object({
  id: z.string().min(1), event: NormalizedEvent,
  source_key: z.string().min(1), publisher: z.string().min(1),
  state: z.enum(QUEUE_STATES),
  publication_at: Instant.nullable(), data_period_at: Instant.nullable(),
  /** Ancla de agrupación de noticias; no reemplaza la publicación conocida. */
  story_at: Instant.nullable().default(null),
  first_captured_at: Instant, last_captured_at: Instant, capture_count: z.number().int().positive(),
  attempts: z.number().int().nonnegative(), next_attempt_at: Instant.nullable(),
  lease_token: z.string().nullable(), lease_until: Instant.nullable(),
  reason: z.enum(QUEUE_REASONS).nullable(), score: QueueScore.nullable(),
  processed_at: Instant.nullable(),
  /** Finalización pendiente: proyectar en events y decidir/registrar entrega. */
  delivery_pending: z.boolean(),
});
export type QueueEntry = z.infer<typeof EntrySchema>;

/** Valida snapshots reabiertos y respuestas del driver; nunca reinicia al fallar. */
export function parseQueueEntry(raw: unknown): QueueEntry {
  const row = EntrySchema.parse(raw);
  // JSON local anterior al campo aditivo: recuperar contexto sin perder cola.
  if (row.story_at === null) row.story_at = queueStoryAt({ ...row.event, publication_at: row.publication_at });
  if (row.id !== row.event.id || row.first_captured_at > row.last_captured_at ||
      (row.state === "processing" ? !row.lease_token || !row.lease_until : row.lease_token !== null || row.lease_until !== null) ||
      (row.state === "retryable_failed") !== (row.next_attempt_at !== null) ||
      (row.state === "scored") !== (row.score !== null) ||
      (row.state === "scored" || row.state === "discarded") !== (row.processed_at !== null) ||
      (row.delivery_pending && row.state !== "scored") ||
      ((row.state === "discarded" || row.state === "retryable_failed") && !row.reason)) {
    throw new Error("invalid_queue_state");
  }
  return row;
}

export type QueueOutcome =
  | { state: "scored"; score: QueueScore; needs_delivery: boolean; event?: NormalizedEvent }
  | { state: "discarded"; reason: QueueReason; event?: NormalizedEvent }
  | { state: "retryable_failed"; reason: QueueReason };

export interface QueueFinish { id: string; outcome: QueueOutcome }
export interface PreparedQueueFinish {
  event: NormalizedEvent | null;
  id: string;
  state: "scored" | "discarded" | "retryable_failed";
  score: QueueScore | null;
  reason: QueueReason | null;
  delivery_pending: boolean;
}

export function prepareQueueFinishes(items: readonly QueueFinish[]): PreparedQueueFinish[] {
  const ids = new Set<string>();
  return items.map(({ id, outcome }) => {
    if (!id || ids.has(id)) throw new Error("duplicate_or_empty_queue_finish");
    ids.add(id);
    const state = z.enum(["scored", "discarded", "retryable_failed"]).parse(outcome.state);
    const event = "event" in outcome && outcome.event ? NormalizedEvent.parse(outcome.event) : null;
    if (event && event.id !== id) throw new Error("queue_enrichment_identity_changed");
    return { id, state, event,
      score: outcome.state === "scored" ? QueueScore.parse(outcome.score) : null,
      reason: outcome.state === "scored" ? null : z.enum(QUEUE_REASONS).parse(outcome.reason),
      delivery_pending: outcome.state === "scored" && z.boolean().parse(outcome.needs_delivery),
    };
  });
}

export interface QueueClaim {
  token: string;
  now?: string;
  leaseMs?: number;
  /** Un grupo no se divide entre workers y produce dos representantes. */
  allOrNothing?: boolean;
}

export interface CaptureCounts {
  captured: number;
  unique: number;
  repeated: number;
  bySource: Record<string, { captured: number; unique: number; repeated: number }>;
}

export interface QueueSourceStats {
  source_key: string;
  publisher: string;
  /** Número acumulado de apariciones, incluidas las repetidas. */
  captured: number;
  unique: number;
  /** Todo trabajo sin terminar, incluyendo leases y reintentos no disponibles. */
  pending: number;
  processing: number;
  retryable_failed: number;
  scored: number;
  discarded: number;
  /** Puntuadas + descartadas. */
  processed: number;
  delivery_pending: number;
  oldest_pending_at: string | null;
  oldest_pending_age_hours: number;
  discarded_by_reason: Partial<Record<QueueReason, number>>;
}

export interface QueueStore {
  capture(inputs: readonly QueueCapture[], now?: string): Promise<CaptureCounts>;
  /** Trabajo reclamable en rondas por editor y antiguo primero dentro de cada uno. */
  listPending(now?: string, limit?: number): Promise<QueueEntry[]>;
  /** Contexto de historias ±24h, incluyendo en vuelo/finalizadas y sin scanLimit. */
  storyContext(event: NormalizedEvent): Promise<QueueEntry[]>;
  /** Compare-and-set por fila. Devuelve solo filas realmente reclamadas. */
  claim(ids: readonly string[], claim: QueueClaim): Promise<QueueEntry[]>;
  /** Un token antiguo no puede cerrar el trabajo reclamado por otro proceso. */
  finish(id: string, token: string, outcome: QueueOutcome, now?: string): Promise<void>;
  /** Representante puntuado y duplicados descartados se cierran juntos o nada. */
  finishBatch(items: readonly QueueFinish[], token: string, now?: string): Promise<void>;
  listDeliveryPending(limit?: number): Promise<QueueEntry[]>;
  /** Solo confirma la proyección de entrega; jamás reclama ni libera Telegram. */
  completeDelivery(id: string): Promise<void>;
  stats(now?: string): Promise<QueueSourceStats[]>;
}

export function queueSourceKey(event: NormalizedEvent): string {
  return event.source === "rss" ? `rss:${event.series_id ?? "unknown"}` : event.source;
}

export function queueStoryAt(event: NormalizedEvent): string | null {
  if (event.kind !== "news") return null;
  const value = event.publication_at ?? event.observed_at;
  return Number.isFinite(Date.parse(value)) ? queueInstant(value) : null;
}

export function queueStoryWindow(event: NormalizedEvent): { from: string; until: string } | null {
  const at = queueStoryAt(event) ?? (rateFact(event) ? queueInstant(event.data_period_at ?? event.observed_at) : null);
  if (at === null) return null;
  return { from: new Date(Date.parse(at) - 86_400_000).toISOString(),
    until: new Date(Date.parse(at) + 86_400_000).toISOString() };
}

export function queueInstant(value = new Date().toISOString()): string {
  return new Date(Instant.parse(value)).toISOString();
}

export function queueLimit(value = 500): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new Error("invalid_queue_limit");
  return value;
}

export function queueLease(claim: QueueClaim): { now: string; until: string; token: string } {
  const now = queueInstant(claim.now);
  const leaseMs = claim.leaseMs ?? DEFAULT_PROCESSING_LEASE_MS;
  if (!claim.token.trim() || !Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    throw new Error("invalid_processing_lease");
  }
  return { now, until: new Date(Date.parse(now) + leaseMs).toISOString(), token: claim.token };
}

export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.min(20, Math.max(0, attempts - 1)));
}

/** Dedupe intra-batch antes del INSERT: Postgres no actualiza dos veces una fila. */
export function prepareQueueCaptures(inputs: readonly QueueCapture[], now?: string): QueueEntry[] {
  const at = queueInstant(now);
  const rows = new Map<string, QueueEntry>();
  for (const input of inputs) {
    const event = NormalizedEvent.parse({ ...input.event, critical_macro: criticalMacro(input.event) });
    const prior = rows.get(event.id);
    if (prior) { prior.capture_count++; continue; }
    const nullableInstant = (value: string | null | undefined) => value == null ? null : queueInstant(value);
    const dated = input.event as NormalizedEvent & { publication_at?: string | null; data_period_at?: string | null };
    const publication = input.publication_at !== undefined ? input.publication_at
      : dated.publication_at !== undefined ? dated.publication_at
        : event.kind === "news" || event.kind === "filing" ? event.observed_at : null;
    const period = input.data_period_at !== undefined ? input.data_period_at
      : dated.data_period_at !== undefined ? dated.data_period_at
        : event.kind === "macro_release" ? event.observed_at : null;
    rows.set(event.id, EntrySchema.parse({
      id: event.id, event, source_key: queueSourceKey(event), publisher: input.publisher,
      state: input.decision?.state ?? "pending",
      publication_at: nullableInstant(publication),
      data_period_at: nullableInstant(period),
      story_at: queueStoryAt({ ...event, publication_at: publication }),
      first_captured_at: at, last_captured_at: at, capture_count: 1,
      attempts: 0, next_attempt_at: null, lease_token: null, lease_until: null,
      reason: input.decision?.reason ?? null, score: null,
      processed_at: input.decision ? at : null, delivery_pending: false,
    }));
  }
  return [...rows.values()];
}

export function captureCounts(
  inputRows: readonly QueueEntry[],
  resultRows: ReadonlyArray<{ id: string; capture_count: number; source_key: string }>,
): CaptureCounts {
  const out: CaptureCounts = { captured: 0, unique: 0, repeated: 0, bySource: {} };
  const results = new Map(resultRows.map((row) => [row.id, row]));
  for (const input of inputRows) {
    const result = results.get(input.id);
    if (!result) throw new Error("capture_ack_missing");
    const unique = result.capture_count === input.capture_count ? 1 : 0;
    const count = out.bySource[result.source_key] ??= { captured: 0, unique: 0, repeated: 0 };
    count.captured += input.capture_count;
    count.unique += unique;
    count.repeated += input.capture_count - unique;
    out.captured += input.capture_count;
    out.unique += unique;
    out.repeated += input.capture_count - unique;
  }
  return out;
}

export function queueIsAvailable(row: QueueEntry, now: string): boolean {
  return row.state === "pending" ||
    (row.state === "retryable_failed" && row.next_attempt_at !== null && row.next_attempt_at <= now) ||
    (row.state === "processing" && row.lease_until !== null && row.lease_until <= now);
}

export function emptySourceStats(source_key: string, publisher: string): QueueSourceStats {
  return { source_key, publisher, captured: 0, unique: 0, pending: 0, processing: 0,
    retryable_failed: 0, scored: 0, discarded: 0, processed: 0, delivery_pending: 0,
    oldest_pending_at: null, oldest_pending_age_hours: 0, discarded_by_reason: {} };
}

type Rows = Map<string, QueueEntry>;
type Access = <T>(fn: (rows: Rows) => T, write: boolean) => Promise<T>;
const clone = <T>(value: T): T => structuredClone(value);
const oldestFirst = (a: QueueEntry, b: QueueEntry) =>
  a.first_captured_at.localeCompare(b.first_captured_at) || a.id.localeCompare(b.id);

function scanFairly(rows: QueueEntry[], cap: number): QueueEntry[] {
  const publishers = new Map<string, QueueEntry[]>();
  for (const row of rows.sort(oldestFirst)) {
    const group = publishers.get(row.publisher) ?? [];
    group.push(row);
    publishers.set(row.publisher, group);
  }
  const ranked = [...publishers.values()].flatMap((group) => group.map((row, rank) => ({ row, rank })));
  return ranked.sort((a, b) => Number(criticalMacro(b.row.event)) - Number(criticalMacro(a.row.event)) || a.rank - b.rank || oldestFirst(a.row, b.row)).slice(0, cap).map(({ row }) => clone(row));
}

function storeWithAccess(access: Access): QueueStore {
  const finishBatch: QueueStore["finishBatch"] = (items, token, now) => {
    const at = queueInstant(now);
    const updates = prepareQueueFinishes(items);
    return access((rows) => {
      // Prevalidar todo antes de la primera mutación también en memoria.
      const targets = updates.map((update) => {
        const row = rows.get(update.id);
        if (!row || row.state !== "processing" || row.lease_token !== token || !row.lease_until || row.lease_until <= at) {
          throw new Error("processing_claim_lost");
        }
        return { row, update };
      });
      for (const { row, update } of targets) {
        if (update.event) row.event = { ...row.event, summary: update.event.summary };
        row.state = update.state;
        row.reason = update.reason;
        row.score = update.score;
        row.delivery_pending = update.delivery_pending;
        row.lease_token = null;
        row.lease_until = null;
        row.next_attempt_at = update.state === "retryable_failed"
          ? new Date(Date.parse(at) + retryDelayMs(row.attempts)).toISOString() : null;
        row.processed_at = update.state === "retryable_failed" ? null : at;
      }
    }, true);
  };
  return {
    capture(inputs, now) {
      const batch = prepareQueueCaptures(inputs, now);
      return access((rows) => {
        const results = batch.map((input) => {
          const existing = rows.get(input.id);
          if (existing) {
            existing.capture_count += input.capture_count;
            existing.last_captured_at = [existing.last_captured_at, input.last_captured_at].sort().at(-1)!;
            return existing;
          }
          rows.set(input.id, clone(input));
          return input;
        });
        return captureCounts(batch, results);
      }, true);
    },
    listPending(now, limit) {
      const at = queueInstant(now), cap = queueLimit(limit);
      return access((rows) => scanFairly([...rows.values()].filter((row) => queueIsAvailable(row, at)), cap), false);
    },
    storyContext(event) {
      const window = queueStoryWindow(event);
      if (!window) return Promise.resolve([]);
      const rate = rateFact(event);
      const from = rate ? new Date(Date.parse(window.from) - 14 * 86_400_000).toISOString() : window.from;
      const until = rate ? new Date(Date.parse(window.until) + 14 * 86_400_000).toISOString() : window.until;
      return access((rows) => [...rows.values()].filter((row) =>
        (row.story_at ?? (rate ? row.data_period_at : null)) !== null &&
        (row.story_at ?? row.data_period_at)! >= from && (row.story_at ?? row.data_period_at)! <= until &&
        (row.state !== "discarded" || row.reason === "duplicate_story" || row.reason === "legacy_processed"))
        .sort(oldestFirst).map(clone), false);
    },
    claim(ids, options) {
      const lease = queueLease(options);
      const unique = [...new Set(ids)];
      return access((rows) => {
        if (options.allOrNothing && unique.some((id) => {
          const row = rows.get(id);
          return !row || !queueIsAvailable(row, lease.now);
        })) return [];
        return unique.flatMap((id) => {
        const row = rows.get(id);
        if (!row || !queueIsAvailable(row, lease.now)) return [];
        if (row.state === "processing") row.reason = "processing_expired";
        row.state = "processing";
        row.attempts++;
        row.lease_token = lease.token;
        row.lease_until = lease.until;
        row.next_attempt_at = null;
        return [clone(row)];
        });
      }, true);
    },
    finish: (id, token, outcome, now) => finishBatch([{ id, outcome }], token, now),
    finishBatch,
    listDeliveryPending(limit) {
      const cap = queueLimit(limit);
      return access((rows) => [...rows.values()].filter((row) => row.state === "scored" && row.delivery_pending)
        .sort((a, b) => Number(criticalMacro(b.event)) - Number(criticalMacro(a.event)) || oldestFirst(a, b)).slice(0, cap).map(clone), false);
    },
    completeDelivery(id) {
      return access((rows) => {
        const row = rows.get(id);
        if (!row || row.state !== "scored") throw new Error("scored_queue_entry_missing");
        row.delivery_pending = false;
      }, true);
    },
    stats(now) {
      const at = queueInstant(now);
      return access((rows) => {
        const groups = new Map<string, QueueSourceStats>();
        for (const row of rows.values()) {
          const count = groups.get(row.source_key) ?? emptySourceStats(row.source_key, row.publisher);
          groups.set(row.source_key, count);
          count.captured += row.capture_count;
          count.unique++;
          if (row.state === "scored" || row.state === "discarded") {
            count.processed++;
            count[row.state]++;
          } else {
            count.pending++;
            if (row.state !== "pending") count[row.state]++;
            if (!count.oldest_pending_at || row.first_captured_at < count.oldest_pending_at) count.oldest_pending_at = row.first_captured_at;
          }
          if (row.delivery_pending) count.delivery_pending++;
          if (row.state === "discarded" && row.reason) count.discarded_by_reason[row.reason] = (count.discarded_by_reason[row.reason] ?? 0) + 1;
        }
        return [...groups.values()].sort((a, b) => a.source_key.localeCompare(b.source_key)).map((count) => ({
          ...count, oldest_pending_age_hours: count.oldest_pending_at
            ? Math.max(0, (Date.parse(at) - Date.parse(count.oldest_pending_at)) / 3_600_000) : 0,
        }));
      }, false);
    },
  };
}

/** Para pruebas sin disco, red ni modelo. Todas las operaciones son atómicas. */
export function memoryQueueStore(): QueueStore {
  const rows: Rows = new Map();
  return storeWithAccess(async (fn) => fn(rows));
}

/**
 * JSON local versionado. Rename atómico y bloqueo exclusivo entre instancias.
 * Un JSON corrupto falla cerrado: empezar vacío perdería pendientes silenciosamente.
 * Un bloqueo huérfano exige intervención con consumidores parados. No se retira
 * por PID ni edad: dos procesos recuperándolo podrían borrar un lock nuevo.
 */
export function fileQueueStore(stateDir: string): QueueStore {
  const path = join(stateDir, "queue.json");
  const lockPath = `${path}.lock`;
  const read = (): Rows => {
    if (!existsSync(path)) return new Map();
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = z.object({ version: z.literal(1), entries: z.array(z.unknown()) }).parse(raw);
    const entries = parsed.entries.map(parseQueueEntry);
    if (new Set(entries.map((row) => row.id)).size !== entries.length) throw new Error("duplicate_queue_entry");
    return new Map(entries.map((row) => [row.id, row]));
  };
  const acquire = async (): Promise<number> => {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 80; attempt++) {
      let fd: number;
      try {
        fd = openSync(lockPath, "wx");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Windows puede devolver acceso denegado mientras termina el borrado
        // del lock anterior o lo inspecciona el antivirus. Nunca es adquisición.
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid }), "utf8");
        fsyncSync(fd);
        return fd;
      } catch (err) {
        closeSync(fd);
        await unlinkWithRetry(lockPath);
        throw err;
      }
    }
    throw new Error("queue_file_busy");
  };
  const unlinkWithRetry = async (target: string): Promise<void> => {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { unlinkSync(target); return; }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt === 79) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };
  return storeWithAccess(async (fn, write) => {
    if (!write) return fn(read());
    const fd = await acquire();
    let temporary: string | null = null;
    try {
      const rows = read();
      const result = fn(rows);
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const out = openSync(temporary, "wx");
      try {
        writeFileSync(out, JSON.stringify({ version: 1, entries: [...rows.values()] }), "utf8");
        fsyncSync(out);
      } finally { closeSync(out); }
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, path); break; }
        catch (error) {
          if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      temporary = null;
      return result;
    } finally {
      closeSync(fd);
      await unlinkWithRetry(lockPath);
      if (temporary && existsSync(temporary)) await unlinkWithRetry(temporary);
    }
  });
}
