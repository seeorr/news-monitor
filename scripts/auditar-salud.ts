/** Solo SELECT por defecto. Aviso privado requiere --notify y habilitación explícita. */
import { neon } from "@neondatabase/serverless";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadDotEnv, loadConfig } from "../src/config.ts";
import { neonRunStore } from "../src/db/cadence.ts";
import { HEALTH_STATE_MEANING, evaluateHealth, healthLimits, sendOperationalNotice } from "../src/pipeline/cadence.ts";
import { neonSeenStore } from "../src/db/neon.ts";
import { sendTelegram } from "../src/notify/telegram.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
export async function readHealthMetrics(sql: Ejecutor, now: string, since: string, limits: ReturnType<typeof healthLimits>) {
  const rows = await sql`select
    (select min(first_captured_at) from capture_queue where state in ('pending','processing','retryable_failed')) as oldest,
    (select count(*)::int from alert_deliveries where state <> 'sent') as blocked,
    -- Bloqueada e incierta no son lo mismo: la incierta pudo salir y solo la
    -- libera una reconciliación humana. Contarlas juntas escondía cuál es cuál.
    (select count(*)::int from alert_deliveries where state in ('uncertain','sending')) as uncertain,
    (select max(settled_at) from alert_deliveries where state = 'sent') as delivered,
    -- Volumen, no solo antigüedad: 3 pendientes viejas y 3.000 no son la misma avería.
    (select count(*)::int from capture_queue where state in ('pending','processing','retryable_failed')) as pending,
    (select count(*)::int from capture_queue where state = 'retryable_failed' and reason = 'budget_exhausted') as budget,
    (select count(*)::int from monitor_event_timing t join capture_queue q on q.id=t.event_id
      where t.critical and t.first_captured_at >= ${since}::timestamptz and q.state <> 'discarded'
      and t.capture_minutes >= ${limits.rateCaptureMinutes}) as capture_breaches,
    (select count(*)::int from monitor_event_timing t join capture_queue q on q.id=t.event_id
      where t.critical and t.first_captured_at >= ${since}::timestamptz and q.state <> 'discarded'
      and (q.state <> 'scored' or q.delivery_pending or t.delivery_state is not null)
      and (t.alert_minutes >= ${limits.rateAlertMinutes} or (t.delivered_at is null and t.publication_at is not null
        and t.publication_at < ${now}::timestamptz - ${limits.rateAlertMinutes} * interval '1 minute'))) as alert_breaches` as Record<string, unknown>[];
  return rows[0]!;
}
export async function auditHealth() {
  loadDotEnv();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("health_database_required");
  const now = new Date().toISOString(), limits = healthLimits(process.env);
  const sql = neon(config.databaseUrl);
  const since = new Date(Date.parse(now) - 7 * 86_400_000).toISOString();
  const runs = await neonRunStore(config.databaseUrl).recent(since);
  const row = await readHealthMetrics(sql, now, since, limits);
  const instante = (value: unknown) => value == null ? null : new Date(String(value)).toISOString();
  const health = evaluateHealth(runs, { now, limits, oldestPendingAt: instante(row.oldest),
    blockedDeliveries: Number(row.blocked), rateCaptureBreaches: Number(row.capture_breaches), rateAlertBreaches: Number(row.alert_breaches),
    pendingItems: Number(row.pending), uncertainDeliveries: Number(row.uncertain), budgetExhaustedItems: Number(row.budget),
    deliveryConfirmedAt: instante(row.delivered),
    // Se comprueba que las credenciales existen; no se prueba el transporte ni
    // se envía nada: una auditoría de solo lectura no llama a Telegram.
    telegramConfigured: Boolean(config.telegramBotToken && config.telegramChatId) });
  // Agregados y vocabulario cerrado. Nada de ids, titulares, URLs ni SQL.
  // `meaning` explica cada estado publicado: quien lee la auditoría no tiene que
  // ir al código a averiguar qué significa `processing_paused`.
  return { code: "HEALTH_AUDIT", readOnly: true, noticesEnabled: false, at: now, limits, ...health,
    meaning: Object.fromEntries(health.states.map((state) => [state, HEALTH_STATE_MEANING[state]])),
    blocked: Number(row.blocked), captureBreaches: Number(row.capture_breaches), alertBreaches: Number(row.alert_breaches) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || (args.length === 1 && args[0] === "--notify");
  (valid ? auditHealth() : Promise.reject(new Error("invalid_health_arguments"))).then(async (report) => {
    const enabled = args.includes("--notify") && process.env.HEALTH_NOTICES_ENABLED === "true";
    let notice = "disabled";
    if (enabled) {
      const config = loadConfig();
      if (!config.databaseUrl || !config.telegramBotToken || !config.telegramChatId) throw new Error("health_notice_configuration_missing");
      notice = await sendOperationalNotice(report, { enabled, now: report.at, seen: neonSeenStore(config.databaseUrl),
        send: async (body) => (await sendTelegram(config.telegramBotToken!, config.telegramChatId!, body)).state });
    }
    console.log(JSON.stringify({ ...report, readOnly: !enabled, noticesEnabled: enabled, notice }, null, 2));
    process.exitCode = report.states.includes("healthy") ? 0 : 1;
  })
    .catch(() => { console.error(JSON.stringify({ code: "HEALTH_AUDIT_FAILED",
      readOnly: !(args.includes("--notify") && process.env.HEALTH_NOTICES_ENABLED === "true") })); process.exitCode = 1; });
}
