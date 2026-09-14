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
export type HealthState = "healthy" | "delayed" | "no_recent_execution" | "critical_source_failed" | "aged_queue" | "delivery_blocked"
  | "processing_paused" | "trigger_inactive" | "budget_exhausted" | "telegram_unconfigured" | "delivery_uncertain"
  | "execution_failed" | "execution_partial" | "circuit_unproven";
/** Vocabulario cerrado: se publica tal cual en la auditoría, sin prosa libre. */
export const HEALTH_STATE_MEANING: Record<HealthState, string> = {
  healthy: "captura, procesamiento, entrega y disparador automático acreditados en la ventana.",
  delayed: "la captura existe pero llega tarde respecto al SLO medido.",
  no_recent_execution: "no consta ninguna ejecución en la ventana de vigilancia.",
  critical_source_failed: "una fuente crítica falló y su último intento sigue fallando.",
  aged_queue: "hay trabajo pendiente más viejo que el límite de cola.",
  delivery_blocked: "hay entregas rechazadas o aplazadas cuyo plazo ya venció y requieren atención.",
  processing_paused: "captura viva y procesamiento parado a propósito (capture-only): no es un fallo.",
  trigger_inactive: "en la ventana solo hay ejecuciones manuales; el disparo automático no está demostrado.",
  budget_exhausted: "las reservas de IA del día UTC alcanzan el cupo diario configurado.",
  telegram_unconfigured: "faltan credenciales de Telegram y el modo vigente exige entregar.",
  delivery_uncertain: "hay entregas en 'uncertain'/'sending' pendientes de reconciliación humana.",
  execution_failed: "la última ejecución completada que incluía procesamiento falló; el estado agregado no identifica qué etapa causó el fallo.",
  execution_partial: "la última ejecución completada que incluía procesamiento terminó parcialmente; no acredita el procesamiento completo ni identifica la causa.",
  circuit_unproven: "faltan pruebas vigentes del circuito completo; la ausencia de otra incidencia no acredita salud.",
};
export interface HealthSignals {
  now: string; limits?: HealthLimits; oldestPendingAt?: string | null;
  blockedDeliveries?: number; rateCaptureBreaches?: number; rateAlertBreaches?: number;
  /** Volumen de la cola: `aged_queue` decía cuán viejo, no cuánto. */
  pendingItems?: number;
  /** Entregas en `uncertain`/`sending` (Agente 2). Por defecto 0: no se afirma. */
  uncertainDeliveries?: number;
  /** Último acuse `sent` verificado en el ledger; si falta, se deduce de `sent` de las ejecuciones. */
  deliveryConfirmedAt?: string | null;
  /** Histórico de filas que conservan ese motivo. No prueba agotamiento hoy. */
  budgetExhaustedItems?: number;
  /** Reservas reales de IA del día UTC y cupo vigente; sin ambos no se afirma agotamiento. */
  aiReservedToday?: number;
  aiCallsDay?: number;
  deferredDeliveries?: number;
  expiredDeferredDeliveries?: number;
  terminalDeliveries?: number;
  /** `undefined` = no comprobado. Solo `false` declara `telegram_unconfigured`. */
  telegramConfigured?: boolean;
}
export function evaluateHealth(runs: RunRecord[], options: HealthSignals) {
  const limits = options.limits ?? healthLimits();
  const age = (at: string | null | undefined) => at ? Math.max(0, (Date.parse(options.now) - Date.parse(at)) / 60_000) : Infinity;
  const finite = (minutes: number) => Number.isFinite(minutes) ? minutes : null;
  // Ventana de vigencia: pasada la cual una ejecución ya no prueba nada del
  // presente. Es el mismo umbral con el que se declara "no_recent_execution",
  // para no introducir una política nueva por la puerta de atrás.
  const live = (at: string | null | undefined) => Boolean(at) && Date.parse(at!) <= Date.parse(options.now) && age(at) <= limits.noExecutionMinutes;
  const records = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const captured = records.filter((run) => run.captureCompletedAt);
  const fast = captured.find((run) => run.criticalOk.includes("ecb-press") && !run.criticalFailed.length);
  const full = captured.find((run) => run.profile === "full" && run.sourcesFailed === 0);
  const states: HealthState[] = [];
  const noExecution = age(records[0]?.startedAt) > limits.noExecutionMinutes;
  const late = age(fast?.captureCompletedAt) > limits.fastMinutes || age(full?.captureCompletedAt) > limits.fullMinutes ||
    (options.rateCaptureBreaches ?? 0) > 0 || (options.rateAlertBreaches ?? 0) > 0;
  if (noExecution) states.push("no_recent_execution");
  else if (late) states.push("delayed");
  // Una caída persiste hasta una respuesta posterior de ESA fuente, no hasta
  // un process-only verde ni hasta una respuesta de otro feed. Pero solo
  // mientras siga siendo comprobable: si el último intento de esa fuente es más
  // viejo que la ventana de vigencia —porque el perfil vigente ya no la
  // incluye—, nadie está demostrando una caída en curso, y dejarla en rojo
  // eterniza una incidencia que pudo resolverse sola. Se sigue publicando en
  // `criticalStale`, así que no se oculta: se deja de afirmar lo que no consta.
  const lastSeen = (feed: typeof CRITICAL_FEEDS[number]) =>
    records.find((run) => run.criticalFailed.includes(feed) || run.criticalOk.includes(feed));
  const down = CRITICAL_FEEDS.filter((feed) => lastSeen(feed)?.criticalFailed.includes(feed));
  const failed = down.filter((feed) => live(lastSeen(feed)!.startedAt));
  const criticalStale = down.filter((feed) => !live(lastSeen(feed)!.startedAt));
  if (failed.length) states.push("critical_source_failed");
  const queueAge = age(options.oldestPendingAt);
  const aged = Boolean(options.oldestPendingAt) && queueAge > limits.queueMinutes;
  if (aged) states.push("aged_queue");
  const blocked = options.blockedDeliveries ?? 0, uncertain = options.uncertainDeliveries ?? 0;
  if (blocked > 0) states.push("delivery_blocked");

  // Disparador: quién pidió las ejecuciones, no cuántas hubo. Una batería de
  // pruebas manuales no demuestra que el cron esté vivo.
  const vivas = records.filter((run) => live(run.startedAt));
  const runsByTrigger = { external: 0, schedule: 0, manual: 0 };
  for (const run of vivas) runsByTrigger[run.trigger]++;
  const lastAutomatic = vivas.find((run) => run.trigger !== "manual");
  const triggerState = !vivas.length ? "absent" : lastAutomatic ? "automatic" : "manual_only";
  if (triggerState === "manual_only") states.push("trigger_inactive");

  // Procesamiento: solo lo acreditan los modos que procesan. Un capture-only
  // verde no dice absolutamente nada del paso siguiente.
  const processingRuns = records.filter((run) => run.mode !== "capture-only");
  const lastProcessing = processingRuns[0];
  // Un checkpoint running solo acredita que se inició el trabajo. Un nuevo
  // intento en curso no borra la evidencia vigente de su predecesor completado.
  const completedProcessing = processingRuns.find((run) => run.status !== "running" && run.endedAt !== null);
  const completedLive = live(completedProcessing?.endedAt);
  const inProgress = processingRuns.find((run) => run.status === "running" && live(run.startedAt));
  const pausedByMode = vivas.some((run) => run.mode === "capture-only");
  const captureState = noExecution ? "absent" : late ? "delayed" : "current";
  const processingState = completedLive ? completedProcessing!.status === "success" ? "current" : "unproven"
    : inProgress ? "running"
    : pausedByMode && captureState === "current" ? "paused"
      : vivas.length ? "delayed" : "absent";
  // Estos estados describen el RUN, nunca atribuyen su fallo al LLM, a fuentes
  // o a Telegram: RunRecord no contiene evidencia suficiente para esa inferencia.
  if (completedLive && completedProcessing!.status === "failed") states.push("execution_failed");
  if (completedLive && completedProcessing!.status === "partial") states.push("execution_partial");
  if (processingState === "paused") states.push("processing_paused");
  const budgetItems = options.budgetExhaustedItems ?? 0;
  const measuredBudget = options.aiReservedToday !== undefined && options.aiCallsDay !== undefined &&
    Number.isSafeInteger(options.aiReservedToday) && options.aiReservedToday >= 0 &&
    Number.isSafeInteger(options.aiCallsDay) && options.aiCallsDay >= 0;
  const budgetExhausted = measuredBudget ? options.aiReservedToday! >= options.aiCallsDay! : null;
  if (budgetExhausted) states.push("budget_exhausted");

  // Entrega: solo el acuse la acredita. Un modo que no entrega no puede
  // declarar que falte la configuración de un transporte que no va a usar.
  const deliveryRequired = processingRuns.some((run) => live(run.startedAt));
  const confirmedAt = options.deliveryConfirmedAt !== undefined ? options.deliveryConfirmedAt
    : vivas.find((run) => run.sent > 0)?.endedAt ?? vivas.find((run) => run.sent > 0)?.startedAt ?? null;
  const unconfigured = options.telegramConfigured === false && deliveryRequired;
  if (unconfigured) states.push("telegram_unconfigured");
  if (uncertain > 0) states.push("delivery_uncertain");
  const deliveryState = unconfigured ? "unconfigured" : uncertain > 0 ? "uncertain" : blocked > 0 ? "blocked"
    : live(confirmedAt) ? "confirmed" : "unproven";

  const fullCircuit = !states.length && triggerState === "automatic" && captureState === "current" &&
    processingState === "current" && deliveryState === "confirmed";
  return { states: states.length ? states : [fullCircuit ? "healthy" as const : "circuit_unproven" as const], criticalFailed: failed, criticalStale,
    fastAgeMinutes: finite(age(fast?.captureCompletedAt)), fullAgeMinutes: finite(age(full?.captureCompletedAt)),
    capture: { state: captureState, lastAt: captured[0]?.captureCompletedAt ?? null, ageMinutes: finite(age(captured[0]?.captureCompletedAt)),
      lastProfile: records[0]?.profile ?? null, lastMode: records[0]?.mode ?? null, lastTrigger: records[0]?.trigger ?? null },
    processing: { state: processingState, lastAt: lastProcessing?.startedAt ?? null, ageMinutes: finite(age(lastProcessing?.startedAt)),
      lastMode: lastProcessing?.mode ?? null, lastRunStatus: lastProcessing?.status ?? null,
      lastCompletedAt: completedProcessing?.endedAt ?? null, lastCompletedStatus: completedProcessing?.status ?? null,
      confirmedAt: completedLive && completedProcessing?.status === "success" ? completedProcessing.endedAt : null,
      inProgress: Boolean(inProgress), scored: vivas.reduce((n, run) => n + run.scored, 0) },
    delivery: { state: deliveryState, blocked, uncertain, confirmedAt, ageMinutes: finite(age(confirmedAt)),
      deferred: options.deferredDeliveries ?? 0, expiredDeferred: options.expiredDeferredDeliveries ?? 0,
      terminal: options.terminalDeliveries ?? 0,
      sent: vivas.reduce((n, run) => n + run.sent, 0), required: deliveryRequired },
    trigger: { state: triggerState, lastAutomaticAt: lastAutomatic?.startedAt ?? null,
      ageMinutes: finite(age(lastAutomatic?.startedAt)), runs: runsByTrigger },
    // Sin medida directa se usa el último checkpoint de la ejecución: es un dato
    // observado, no una estimación, y evita que el volumen dependa de que el
    // llamante se acuerde de pasarlo.
    queue: { pending: options.pendingItems ?? records[0]?.pendingAfter ?? null, oldestPendingAt: options.oldestPendingAt ?? null,
      ageMinutes: finite(queueAge), aged },
    budget: { exhausted: budgetExhausted, items: budgetItems, historicalItems: budgetItems,
      reservedToday: measuredBudget ? options.aiReservedToday! : null, dayLimit: measuredBudget ? options.aiCallsDay! : null,
      remainingToday: measuredBudget ? Math.max(0, options.aiCallsDay! - options.aiReservedToday!) : null },
    fullCircuit };
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

export const BUDGET_NOTICE_TEXT = "News Monitor: cupo diario de IA agotado. Las noticias esperan en la cola " +
  "y se puntúan al renovarse el cupo, a las 00:00 UTC. Este aviso sale una vez al día.";

/**
 * Cupo de IA agotado: un aviso privado por día UTC, enviado desde el propio ciclo.
 * No se delega en el vigilante horario: su cron pierde la mayoría de disparos y su
 * único aviso diario puede estar gastado en otro estado. Id propio en el mismo ledger.
 */
export async function sendBudgetNotice(options: {
  now: string; seen: Pick<SeenStore, "claimAlert" | "finishAlert">;
  send: (message: string) => Promise<"sent" | "rejected" | "uncertain">;
}): Promise<"blocked" | "sent" | "rejected" | "uncertain"> {
  const id = `operational-budget:${new Date(options.now).toISOString().slice(0, 10)}`, token = randomUUID();
  if (!await options.seen.claimAlert(id, { token })) return "blocked";
  let state: "sent" | "rejected" | "uncertain" = "uncertain";
  try { state = await options.send(BUDGET_NOTICE_TEXT); } catch { state = "uncertain"; }
  try { await options.seen.finishAlert(id, token, state); }
  catch { return "uncertain"; }
  return state;
}
