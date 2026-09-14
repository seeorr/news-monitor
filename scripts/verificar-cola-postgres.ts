/**
 * SQL real de Postgres, exclusivamente local en WASM (PGlite de .cache).
 * No carga .env, no consulta DATABASE_URL y no modifica dependencias del paquete.
 * Preparación reproducible desde el repo, con cache y paquete en .cache:
 *   npm pack @electric-sql/pglite@0.5.8 --ignore-scripts --pack-destination .cache --cache .cache/npm
 *   mkdir .cache/pglite
 *   tar -xf .cache/electric-sql-pglite-0.5.8.tgz -C .cache/pglite
 *   npx tsx scripts/verificar-cola-postgres.ts
 * PGlite es monoconexión: valida SQL/constraints/transiciones, no competición
 * de sesiones reales de Neon. Esa comprobación queda pendiente en producción.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { neonQueueStore } from "../src/db/queue.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import { splitStatements } from "../src/lib/sql.ts";
import type { QueueCapture, QueueScore } from "../src/pipeline/queue.ts";

type LocalDatabase = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
};
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const t0 = "2026-09-10T10:00:00.000Z", t1 = "2026-09-10T11:00:00.000Z";
const scoring: QueueScore = { importance_score: 8, market_impact_score: 7, sentiment: "neutral",
  needs_alert: true, one_liner: "El IPC ha subido." };

function candidate(id: number, publisher = "publisher-a"): QueueCapture {
  return { publisher, event: {
    id: `local:${id}`, source: "rss", series_id: publisher, kind: "news",
    source_url: "https://example.test/news", title: `Consumer prices increase in region ${id}`,
    summary: "A public statistical release reports a change in prices.", country: "US",
    observed_at: "2026-09-10T09:00:00.000Z", retrieved_at: t0,
    actual: null, previous: null, consensus: null, unit: null, surprises: [], official: false, stale: false,
  } };
}

async function main(): Promise<void> {
  const checks: string[] = [];
  const runtimeArgument = process.argv.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length);
  const runtime = resolve(repo, runtimeArgument ?? ".cache/pglite/package/dist/index.js");
  const { PGlite } = await import(pathToFileURL(runtime).href) as { PGlite: new () => LocalDatabase };
  const db = new PGlite();
  const sql: Ejecutor = async (parts, ...values) => {
    const statement = parts.map((part, index) => index < values.length ? `${part}$${index + 1}` : part).join("");
    return (await db.query(statement, values)).rows;
  };
  const queue = neonQueueStore("unused-local-only", sql);
  try {
    // Todas las migraciones que dan forma a `capture_queue`, no solo la primera. Con
    // solo la creación, este script dejó de pasar el 11-09 —el código ya usaba
    // `fingerprint`, que añade revisiones_de_fuente— y nadie lo vio hasta que el
    // 14-09 empezó a correr en CI. Dos pasadas: siguen teniendo que ser idempotentes.
    const migraciones = ["20260910_capture_queue.sql", "20260910_news_control.sql",
      "20260911_exclusion_al_activar.sql", "20260911_revisiones_de_fuente.sql"];
    for (let pasada = 0; pasada < 2; pasada++) {
      for (const archivo of migraciones) {
        const migration = await readFile(join(repo, "neon/migrations", archivo), "utf8");
        for (const statement of splitStatements(migration)) await db.query(statement);
      }
    }
    checks.push("migration_idempotent");

    // Una tabla de entrega testigo, ajena a la cola: caducar processing no toca sending.
    await db.query("create table alert_deliveries (event_id text primary key, state text not null)");
    await db.query("insert into alert_deliveries values ('local:0', 'sending')");
    const rows = Array.from({ length: 31 }, (_, index) => candidate(index));
    assert.deepEqual(await queue.capture(rows, t0), { captured: 31, unique: 31, repeated: 0,
      bySource: { "rss:publisher-a": { captured: 31, unique: 31, repeated: 0 } } });
    const first = (await queue.listPending(t0)).slice(0, 12);
    const owned = await queue.claim(first.map((row) => row.id), { token: "first", now: t0, allOrNothing: true });
    assert.equal(owned.length, 12);
    await queue.finishBatch(owned.map((row) => ({ id: row.id,
      outcome: { state: "scored", score: scoring, needs_delivery: true } })), "first", t0);
    const reopened = neonQueueStore("unused-reopened", sql);
    await reopened.capture([], t1);
    assert.equal((await reopened.listPending(t1)).length, 19);
    assert.equal((await reopened.listDeliveryPending()).length, 12);
    checks.push("capture_31_capacity_12_reopen_empty_feed_19_pending");

    assert.deepEqual(await reopened.capture([rows[0]!, rows[0]!], t1), {
      captured: 2, unique: 0, repeated: 2,
      bySource: { "rss:publisher-a": { captured: 2, unique: 0, repeated: 2 } },
    });
    const original = (await reopened.listDeliveryPending()).find((row) => row.id === "local:0")!;
    assert.equal(original.capture_count, 3);
    assert.equal(original.first_captured_at, t0);
    assert.equal(original.publication_at, rows[0]!.event.observed_at);
    checks.push("repeat_preserves_score_snapshot_dates");

    const pair = (await queue.listPending(t1)).slice(0, 2);
    await queue.claim([pair[0]!.id], { token: "owner-one", now: t1 });
    assert.equal((await queue.claim(pair.map((row) => row.id),
      { token: "competitor", now: t1, allOrNothing: true })).length, 0);
    assert.equal((await queue.listPending(t1)).find((row) => row.id === pair[1]!.id)!.attempts, 0);
    await queue.claim([pair[1]!.id], { token: "owner-two", now: t1 });
    const groupOutcome = [
      { id: pair[0]!.id, outcome: { state: "scored" as const, score: scoring, needs_delivery: true } },
      { id: pair[1]!.id, outcome: { state: "discarded" as const, reason: "duplicate_story" as const } },
    ];
    await assert.rejects(queue.finishBatch(groupOutcome, "owner-one", t1), /processing_claim_lost/);
    const unchanged = await db.query("select state from capture_queue where id = any($1::text[])", [pair.map((row) => row.id)]);
    assert.equal(unchanged.rows.filter((row) => row.state === "processing").length, 2);
    checks.push("group_claim_and_finish_all_or_nothing");

    const recoveredAt = "2026-09-10T12:00:00.000Z";
    const reclaimed = await queue.claim(pair.map((row) => row.id), { token: "recovered", now: recoveredAt, allOrNothing: true });
    assert.equal(reclaimed.length, 2);
    assert.equal(reclaimed[0]!.reason, "processing_expired");
    await queue.finishBatch(groupOutcome, "recovered", recoveredAt);
    const delivery = await db.query("select state from alert_deliveries where event_id = 'local:0'");
    assert.equal(delivery.rows[0]!.state, "sending");
    checks.push("processing_lease_recovery_does_not_touch_delivery");

    const retry = (await queue.listPending(recoveredAt))[0]!;
    await queue.claim([retry.id], { token: "retry", now: recoveredAt });
    await queue.finish(retry.id, "retry", { state: "retryable_failed", reason: "scoring_failed" }, recoveredAt);
    assert.equal((await queue.listPending("2026-09-10T12:00:59.000Z")).some((row) => row.id === retry.id), false);
    assert.equal((await queue.listPending("2026-09-10T12:01:00.000Z")).some((row) => row.id === retry.id), true);
    await db.query("update capture_queue set attempts = 100 where id = $1", [retry.id]);
    await queue.claim([retry.id], { token: "retry-later", now: "2026-09-10T13:00:00.000Z" });
    await queue.finish(retry.id, "retry-later", { state: "retryable_failed", reason: "scoring_failed" }, "2026-09-10T13:00:00.000Z");
    const retryRow = await db.query("select next_attempt_at from capture_queue where id = $1", [retry.id]);
    assert.equal(new Date(retryRow.rows[0]!.next_attempt_at as string).toISOString(), "2026-09-10T19:00:00.000Z");
    checks.push("retry_backoff_and_six_hour_bound");

    await queue.capture(Array.from({ length: 510 }, (_, index) => candidate(1000 + index)), t0);
    await queue.capture([candidate(9999, "publisher-b")], t1);
    const fair = await queue.listPending(t1, 12);
    assert.equal(fair.length, 12);
    assert.equal(fair.some((row) => row.publisher === "publisher-b"), true);
    checks.push("fair_scan_before_limit_510_plus_one");

    const context = await queue.storyContext(rows[0]!.event);
    assert.equal(context.length, 542);
    assert.equal(context.some((row) => row.id === "local:0" && row.state === "scored"), true);
    assert.equal(context.some((row) => row.state === "discarded" && row.reason === "duplicate_story"), true);
    assert.equal(context.some((row) => row.id === "local:9999"), true);
    const outside = candidate(99990); outside.event.observed_at = "2026-09-08T09:00:00.000Z";
    const filing = candidate(99991); filing.event.kind = "filing";
    await queue.capture([outside, filing], t1);
    assert.equal((await queue.storyContext(rows[0]!.event)).length, 542);
    assert.equal((await queue.storyContext(filing.event)).length, 0);
    checks.push("story_context_beyond_scan_limit_with_scored_and_duplicates");

    const stats = await queue.stats("2026-09-10T14:00:00.000Z");
    const publisherA = stats.find((row) => row.source_key === "rss:publisher-a")!;
    assert.equal(publisherA.unique, 543);
    assert.equal(publisherA.captured, 545);
    assert.equal(publisherA.scored, 13);
    assert.equal(publisherA.discarded_by_reason.duplicate_story, 1);
    assert.equal(publisherA.retryable_failed, 1);
    assert.equal(publisherA.oldest_pending_age_hours, 4);
    await queue.completeDelivery("local:0");
    await queue.completeDelivery("local:0");
    assert.equal((await queue.listDeliveryPending()).some((row) => row.id === "local:0"), false);
    checks.push("source_stats_and_idempotent_finalization");

    await assert.rejects(db.query("update capture_queue set state = 'scored' where id = 'local:9999'"));
    await assert.rejects(db.query("update capture_queue set delivery_pending = true where id = 'local:9999'"));
    checks.push("database_constraints_reject_incoherent_states");

    const sizes = (await db.query(`select count(*)::int as rows,
      avg(pg_column_size(snapshot))::int as average_snapshot_bytes,
      avg(pg_column_size(q))::int as average_row_bytes,
      pg_total_relation_size('capture_queue')::bigint as table_and_indexes_bytes
      from capture_queue q`)).rows[0];
    await mkdir(join(repo, ".cache"), { recursive: true });
    await writeFile(join(repo, ".cache/verificacion-cola-postgres.json"), JSON.stringify({
      at: new Date().toISOString(), engine: "PGlite 0.5.8 (Postgres WASM, local monoconexión)",
      checks, checksPassed: checks.length, syntheticStorage: sizes,
      limitations: ["No valida concurrencia entre sesiones independientes de Neon.",
        "No aplica migraciones remotas ni mide datos o capacidad de producción.",
        "Almacenamiento medido con noticias sintéticas cortas; no extrapolar sin considerar resúmenes reales."],
    }, null, 2), "utf8");
    console.log(JSON.stringify({ code: "LOCAL_POSTGRES_QUEUE_OK", checks: checks.length }));
  } finally { await db.close(); }
}

main().catch(async (error: unknown) => {
  await mkdir(join(repo, ".cache"), { recursive: true });
  await writeFile(join(repo, ".cache/verificacion-cola-postgres-error.json"), JSON.stringify({
    at: new Date().toISOString(), error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  }, null, 2), "utf8");
  console.log(JSON.stringify({ code: "LOCAL_POSTGRES_QUEUE_FAILED" }));
  process.exitCode = 1;
});
