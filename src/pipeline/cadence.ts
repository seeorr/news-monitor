import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { SeenStore } from "./seen.ts";
import { PROFILES, TRIGGERS } from "./profile.ts";
import type { QueueSourceStats } from "./queue.ts";
export const CRITICAL_FEEDS = ["ecb-press", "fed-press", "boe-news", "boe-publications", "boj-news"] as const;
const instant = z.iso.datetime();
const count = z.number().int().nonnegative();
export const RunRecord = z.object({
  id: z.uuid(), profile: z.enum(PROFILES), trigger: z.enum(TRIGGERS),
  mode: z.enum(["full", "capture-only", "process-only"]),
  startedAt: instant, endedAt: instant.nullable(), captureCompletedAt: instant.nullable(),
  status: z.enum(["running", "success", "partial", "failed"]),
  sourcesOk: count, sourcesFailed: count, captured: count, unique: count,
  criticalOk: z.array(z.enum(CRITICAL_FEEDS)), criticalFailed: z.array(z.enum(CRITICAL_FEEDS)),
  pendingBefore: count, pendingAfter: count, oldestPendingAt: instant.nullable(),
  scored: count, sent: count,
});
export type RunRecord = z.infer<typeof RunRecord>;
export interface RunStore { put(record: RunRecord): Promise<void>; recent(since: string): Promise<RunRecord[]> }
export function queueSnapshot(rows: QueueSourceStats[]) {
  return { pending: rows.reduce((n, row) => n + row.pending, 0),
    oldest: rows.map((row) => row.oldest_pending_at).filter((v): v is string => v !== null).sort()[0] ?? null };
}
export interface HealthLimits { fastMinutes: number; fullMinutes: number; noExecutionMinutes: number;
  queueMinutes: number; rateCaptureMinutes: number; rateAlertMinutes: number }
export function healthLimits(env: Record<string, string | undefined> = {}): HealthLimits {
  const number = (key: string, fallback: number) => {
    const value = env[key] ? Number(env[key]) : fallback;
    if (!Number.isFinite(value) || value <= 0 || value > 10080) throw new Error("invalid_health_limit");
    return value;
  };
  return { fastMinutes: number("HEALTH_FAST_MINUTES", 15), fullMinutes: number("HEALTH_FULL_MINUTES", 45),
    noExecutionMinutes: number("HEALTH_NO_EXECUTION_MINUTES", 90), queueMinutes: number("HEALTH_QUEUE_MINUTES", 120),
    rateCaptureMinutes: number("HEALTH_RATE_CAPTURE_MINUTES", 10), rateAlertMinutes: number("HEALTH_RATE_ALERT_MINUTES", 15) };
}
export type HealthState = "healthy" | "delayed" | "no_recent_execution" | "critical_source_failed" | "aged_queue" | "delivery_blocked";
export function evaluateHealth(runs: RunRecord[], options: { now: string; limits?: HealthLimits; oldestPendingAt?: string | null;
  blockedDeliveries?: number; rateCaptureBreaches?: number; rateAlertBreaches?: number }) {
  const limits = options.limits ?? healthLimits();
  const age = (at: string | null | undefined) => at ? Math.max(0, (Date.parse(options.now) - Date.parse(at)) / 60_000) : Infinity;
  const records = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const captured = records.filter((run) => run.captureCompletedAt);
  const fast = captured.find((run) => run.criticalOk.includes("ecb-press") && !run.criticalFailed.length);
  const full = captured.find((run) => run.profile === "full" && run.sourcesFailed === 0);
  const states: HealthState[] = [];
  if (age(records[0]?.startedAt) > limits.noExecutionMinutes) states.push("no_recent_execution");
  else if (age(fast?.captureCompletedAt) > limits.fastMinutes || age(full?.captureCompletedAt) > limits.fullMinutes ||
      (options.rateCaptureBreaches ?? 0) > 0 || (options.rateAlertBreaches ?? 0) > 0) states.push("delayed");
  // Una caída persiste hasta una respuesta posterior de ESA fuente, no hasta
  // un process-only verde ni hasta una respuesta de otro feed.
  const failed = CRITICAL_FEEDS.filter((feed) => records.find((run) => run.criticalFailed.includes(feed) || run.criticalOk.includes(feed))?.criticalFailed.includes(feed));
  if (failed.length) states.push("critical_source_failed");
  if (options.oldestPendingAt && age(options.oldestPendingAt) > limits.queueMinutes) states.push("aged_queue");
  if ((options.blockedDeliveries ?? 0) > 0) states.push("delivery_blocked");
  return { states: states.length ? states : ["healthy" as const], criticalFailed: failed,
    fastAgeMinutes: Number.isFinite(age(fast?.captureCompletedAt)) ? age(fast?.captureCompletedAt) : null,
    fullAgeMinutes: Number.isFinite(age(full?.captureCompletedAt)) ? age(full?.captureCompletedAt) : null };
}
/** Preparado, sin transporte real ni habilitación por entorno implícita. */
export async function privateHealthNotice(health: ReturnType<typeof evaluateHealth>, options: {
  enabled: boolean; send: (message: string) => Promise<void>;
}): Promise<boolean> {
  if (!options.enabled || health.states.every((state) => state === "healthy")) return false;
  await options.send(`News Monitor · salud: ${health.states.join(", ")}. Revisar el informe privado de cadencia.`);
  return true;
}

/** Canal operativo separado del contenido financiero: máximo un intento por
 * día UTC, protegido por el mismo ledger, sin guardar un falso evento de mercado. */
export async function sendOperationalNotice(health: ReturnType<typeof evaluateHealth>, options: {
  enabled: boolean; now: string; seen: Pick<SeenStore, "claimAlert" | "finishAlert">;
  send: (message: string) => Promise<"sent" | "rejected" | "uncertain">;
}): Promise<"disabled" | "healthy" | "blocked" | "sent" | "rejected" | "uncertain"> {
  if (!options.enabled) return "disabled";
  if (health.states.every((state) => state === "healthy")) return "healthy";
  const id = `operational-health:${new Date(options.now).toISOString().slice(0,10)}`, token = randomUUID();
  if (!await options.seen.claimAlert(id, { token })) return "blocked";
  let state: "sent" | "rejected" | "uncertain" = "uncertain";
  try {
    await privateHealthNotice(health, { enabled: true, send: async (body) => { state = await options.send(body); } });
  } catch { state = "uncertain"; }
  try { await options.seen.finishAlert(id, token, state); }
  catch { return "uncertain"; } // sending queda bloqueado si falta el acuse.
  return state;
}
