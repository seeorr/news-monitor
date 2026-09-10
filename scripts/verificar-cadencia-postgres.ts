/** SQL real local, sin .env ni conexiones remotas. Requiere PGlite en .cache. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { splitStatements } from "../src/lib/sql.ts";
import { neonQueueStore } from "../src/db/queue.ts";
import { neonRunStore } from "../src/db/cadence.ts";
import { healthLimits, type RunRecord } from "../src/pipeline/cadence.ts";
import { readHealthMetrics } from "./auditar-salud.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";
const { PGlite } = await import(pathToFileURL(resolve(".cache/pglite/package/dist/index.js")).href);
const db = new PGlite();
const sql: Ejecutor = async (parts, ...values) => (await db.query(parts.map((part, index) => `${part}${index < values.length ? `$${index + 1}` : ""}`).join(""), values)).rows;
const checks: string[] = [];
try {
  const apply = async (path: string) => { for (const statement of splitStatements(await readFile(path, "utf8"))) await db.query(statement); };
  await apply("neon/migrations/20260910_capture_queue.sql");
  await db.query("create table alert_deliveries(event_id text primary key,state text,settled_at timestamptz)");
  await apply("neon/migrations/20260910_run_cadence.sql"); await apply("neon/migrations/20260910_run_cadence.sql");
  checks.push("additive_migration_idempotent");
  const queue = neonQueueStore("local-only", sql), runs = neonRunStore("local-only", sql);
  const at = "2026-09-10T12:23:00.000Z";
  const event: NormalizedEvent = { id: "ecb-local", source: "rss", series_id: "ecb-press", title: "Monetary policy decisions", summary: null,
    kind: "news", official: true, stale: false, source_url: "https://example.test/release", country: null, observed_at: "2026-09-10T12:15:00.000Z",
    retrieved_at: at, publication_at: "2026-09-10T12:15:00.000Z", actual: null, previous: null, consensus: null, unit: null, surprises: [] };
  const ordinary = Array.from({ length: 520 }, (_, n) => ({ publisher: "same", event: { ...event, id: `ordinary-${n}`, official: false, title: `Routine notice ${n}` } }));
  await queue.capture(ordinary, "2026-09-10T11:00:00.000Z"); await queue.capture([{ event, publisher: "ecb" }], at);
  assert.equal((await queue.listPending(at, 1))[0]!.id, event.id); checks.push("critical_before_sql_scan_limit_520");
  await queue.claim([event.id], { token: "local-token", now: at });
  await queue.finish(event.id, "local-token", { state: "scored", needs_delivery: true,
    event: { ...event, summary: "The ECB raises interest rates by 25 basis points. The deposit facility increases to 2.50%." },
    score: { importance_score: 8, market_impact_score: 8, sentiment: "neutral", needs_alert: true, one_liner: "Decisión de tipos." } }, "2026-09-10T12:24:00Z");
  const saved = (await queue.listDeliveryPending())[0]!;
  assert.ok(saved.event.summary?.includes("2.50%")); assert.equal(saved.first_captured_at, at);
  checks.push("atomic_enrichment_keeps_original_dates");
  await db.query("insert into alert_deliveries values ($1,'sent',$2)", [event.id,"2026-09-10T12:24:30Z"]);
  const timing = (await db.query("select * from monitor_event_timing where event_id=$1",[event.id])).rows[0];
  assert.equal(Number(timing.capture_minutes), 8); assert.equal(Number(timing.alert_minutes), 9.5);
  assert.equal(timing.data_period_at, null); checks.push("four_timestamps_and_latency_no_invented_period");
  const record: RunRecord = { id: randomUUID(), profile: "fast", trigger: "external", mode: "full", startedAt: at,
    endedAt: "2026-09-10T12:25:00.000Z", captureCompletedAt: at, status: "success", sourcesOk: 1, sourcesFailed: 0,
    captured: 1, unique: 1, criticalOk: ["ecb-press"], criticalFailed: [], pendingBefore: 520, pendingAfter: 520,
    oldestPendingAt: "2026-09-10T11:00:00.000Z", scored: 1, sent: 1 };
  await runs.put({ ...record, status: "running", endedAt: null }); await runs.put(record);
  assert.deepEqual(await neonRunStore("reopened-local",sql).recent("2026-09-10T00:00:00Z"),[record]);
  checks.push("persistent_run_checkpoint_and_reopen");
  await db.query("insert into alert_deliveries values ('uncertain-local','uncertain',now())");
  const metrics = await readHealthMetrics(sql,"2026-09-10T12:30:00Z","2026-09-10T00:00:00Z",healthLimits());
  assert.equal(metrics.blocked,1); assert.equal(metrics.capture_breaches,0); assert.equal(metrics.alert_breaches,0);
  checks.push("health_readonly_sql_and_uncertain_delivery");
  await queue.capture([{ publisher:"ecb", event:{...event,id:"historical",observed_at:"2026-08-01T12:15:00Z",publication_at:"2026-08-01T12:15:00Z"},
    decision:{state:"discarded",reason:"stale_at_capture"} }],at);
  const withoutHistorical = await readHealthMetrics(sql,"2026-09-10T12:30:00Z","2026-09-10T00:00:00Z",healthLimits());
  assert.equal(withoutHistorical.capture_breaches,0); assert.equal(withoutHistorical.alert_breaches,0);
  checks.push("historical_discard_does_not_create_false_slo_breach");
  await assert.rejects(db.query("insert into monitor_runs values ($1,now(),$2::jsonb)",[randomUUID(),JSON.stringify({...record,profile:"unknown"})]));
  checks.push("database_rejects_unknown_profile");
  // DDL inverso SOLO en esta base efímera. No destruye la cola ni el ledger.
  await db.query("drop view monitor_event_timing"); await db.query("drop index capture_queue_critical_pending"); await db.query("drop table monitor_runs");
  assert.equal((await queue.stats(at)).reduce((n,r)=>n+r.unique,0),522);
  assert.equal((await db.query("select count(*)::int as n from alert_deliveries")).rows[0].n,2);
  checks.push("rollback_preserves_queue_and_delivery_ledger");
  await writeFile(".cache/cadence-postgres-verification.json",JSON.stringify({ localOnly:true, checks },null,2));
  console.log(JSON.stringify({ code:"LOCAL_POSTGRES_CADENCE_OK",checks:checks.length }));
} finally { await db.close(); }
