/** Contratos SQL sin red. No equivalen a una ejecución contra Postgres real. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Ejecutor } from "../src/db/cliente.ts";
import { neonQueueStore } from "../src/db/queue.ts";
import { prepareQueueCaptures, type QueueCapture, type QueueScore } from "../src/pipeline/queue.ts";
import { splitStatements } from "../src/lib/sql.ts";

const t0 = "2026-09-10T10:00:00.000Z";
const t1 = "2026-09-10T11:00:00.000Z";
const input: QueueCapture = {
  publisher: "Example Publisher",
  publication_at: "2026-09-10T09:00:00.000Z",
  event: { id: "rss:feed:1", source: "rss", source_url: "https://example.test/story", series_id: "feed",
    kind: "news", title: "Inflation rises", summary: "Consumer prices rise.", country: "US",
    observed_at: "2026-09-10T09:00:00.000Z", retrieved_at: t0,
    actual: null, previous: null, consensus: null, unit: null, surprises: [], stale: false, official: false },
};
const score: QueueScore = { importance_score: 8, market_impact_score: 7,
  sentiment: "neutral", needs_alert: true, one_liner: "Sube el IPC." };

function probe(result: unknown = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let response = result;
  const sql: Ejecutor = async (parts, ...values) => { calls.push({ text: parts.join(" ? ").replace(/\s+/g, " ").trim(), values }); return response; };
  return { calls, sql, respond: (value: unknown) => { response = value; } };
}
function dbRow(overrides: Record<string, unknown> = {}) {
  const row = prepareQueueCaptures([input], t0)[0]!;
  return { ...row, event: undefined, snapshot: row.event, ...overrides };
}

describe("cola Neon: contratos de consultas parametrizadas", () => {
  it("captura 40 titulares en un INSERT sin escribir events ni entregas y deduplica dentro del lote", async () => {
    const batch = Array.from({ length: 40 }, (_, index) => ({ ...input, event: { ...input.event, id: `rss:feed:${index}` } }));
    const ack = batch.map((row) => ({ id: row.event.id, source_key: "rss:feed", capture_count: 1 }));
    ack[0]!.capture_count = 2;
    const p = probe(ack);
    const counts = await neonQueueStore("unused", p.sql).capture([...batch, batch[0]!], t0);
    expect(counts).toMatchObject({ captured: 41, unique: 40, repeated: 1 });
    expect(p.calls).toHaveLength(1);
    const call = p.calls[0]!;
    expect(call.text).toContain("jsonb_to_recordset");
    const payload = JSON.parse(call.values[0] as string) as Array<{ capture_count: number }>;
    expect(payload).toHaveLength(40);
    expect(payload[0]!.capture_count).toBe(2);
    expect(call.text).not.toContain(input.event.title);
    expect(call.text).not.toMatch(/\b(?:events|alert_deliveries)\b/);
    const updates = call.text.split("on conflict (id) do update set")[1]!;
    expect(updates).toContain("last_captured_at = greatest");
    expect(updates).toContain("capture_count = capture_queue.capture_count + excluded.capture_count");
    expect(updates).not.toMatch(/(?:snapshot|first_captured_at|publication_at|data_period_at|state|score)\s*=/);
  });

  it("cuenta capturas repetidas sin confundirlas con nuevas aunque dos ciclos coincidan", async () => {
    const p = probe([{ id: input.event.id, source_key: "rss:feed", capture_count: 9 }]);
    expect(await neonQueueStore("unused", p.sql).capture([input], t0)).toMatchObject({ captured: 1, unique: 0, repeated: 1 });
    p.respond([]);
    await expect(neonQueueStore("unused", p.sql).capture([input], t0)).rejects.toThrow("capture_ack_missing");
  });

  it("backlog lee snapshots y tres estados recuperables, sin depender de RSS ni events", async () => {
    const p = probe([dbRow({ first_captured_at: new Date(t0), last_captured_at: new Date(t0) })]);
    const rows = await neonQueueStore("unused", p.sql).listPending(t1, 75);
    expect(rows).toMatchObject([{ id: input.event.id, event: input.event, first_captured_at: t0, publication_at: input.publication_at }]);
    expect(p.calls[0]!.text).toContain("state = 'pending'");
    expect(p.calls[0]!.text).toContain("next_attempt_at <=");
    expect(p.calls[0]!.text).toContain("lease_until <=");
    expect(p.calls[0]!.text).toContain("order by first_captured_at, id");
    expect(p.calls[0]!.values.at(-1)).toBe(75);
  });

  it("contexto de historia usa el índice temporal sin límite de 500 e incluye trabajo finalizado", async () => {
    const p = probe([dbRow({ state: "scored", score, processed_at: t0, delivery_pending: true })]);
    const store = neonQueueStore("unused", p.sql);
    expect(await store.storyContext(input.event)).toMatchObject([{ state: "scored", story_at: input.publication_at }]);
    expect(p.calls[0]!.text).toContain("story_at between");
    expect(p.calls[0]!.text).toContain("'duplicate_story', 'legacy_processed'");
    expect(p.calls[0]!.text).not.toMatch(/\blimit\b/i);
    expect(p.calls[0]!.values).toEqual(["2026-09-09T09:00:00.000Z", "2026-09-11T09:00:00.000Z"]);
    expect(await store.storyContext({ ...input.event, kind: "filing" })).toEqual([]);
    expect(p.calls).toHaveLength(1);
  });

  it("reclama con bloqueo de filas y skip locked, conserva el orden del plan", async () => {
    const rowA = dbRow({ state: "processing", lease_token: "worker", lease_until: t1, attempts: 1 });
    const rowB = { ...rowA, id: "rss:feed:2", snapshot: { ...input.event, id: "rss:feed:2" } };
    const p = probe([rowB, rowA]);
    const result = await neonQueueStore("unused", p.sql).claim([input.event.id, "rss:feed:2"], { token: "worker", now: t0 });
    expect(result.map((row) => row.id)).toEqual([input.event.id, "rss:feed:2"]);
    expect(p.calls[0]!.text).toContain("for update skip locked");
    expect(p.calls[0]!.text).toContain("attempts = q.attempts + 1");
    expect(p.calls[0]!.text).not.toContain("alert_deliveries");
  });

  it("cierra representante y duplicados en una sentencia condicionada al grupo completo", async () => {
    const p = probe([{ id: input.event.id }, { id: "duplicate" }]);
    const store = neonQueueStore("unused", p.sql);
    await store.finishBatch([
      { id: input.event.id, outcome: { state: "scored", score, needs_delivery: true } },
      { id: "duplicate", outcome: { state: "discarded", reason: "duplicate_story" } },
    ], "worker", t0);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.text).toContain("for update of q");
    expect(p.calls[0]!.text).toContain("q.state = 'processing' and q.lease_token =");
    expect(p.calls[0]!.text).toContain("q.lease_until >");
    expect(p.calls[0]!.text).toContain("(select count(*) from owned) =");
    expect(p.calls[0]!.values.at(-1)).toBe(2);
    const payload = JSON.parse(p.calls[0]!.values[0] as string);
    expect(payload).toEqual([
      { id: input.event.id, state: "scored", score, reason: null, delivery_pending: true, event: null },
      { id: "duplicate", state: "discarded", score: null, reason: "duplicate_story", delivery_pending: false, event: null },
    ]);
    p.respond([]);
    await expect(store.finish(input.event.id, "old", { state: "scored", score, needs_delivery: true }, t0))
      .rejects.toThrow("processing_claim_lost");
  });

  it("reintenta con retraso acotado y nunca recicla tokens de entrega", async () => {
    const p = probe([{ id: input.event.id }]);
    await neonQueueStore("unused", p.sql).finish(input.event.id, "worker", { state: "retryable_failed", reason: "scoring_failed" }, t0);
    expect(p.calls[0]!.text).toContain("least(21600, 60 * power(2, least(20, greatest(0, q.attempts - 1))))");
    expect(p.calls[0]!.text).toContain("lease_token = null, lease_until = null");
    expect(p.calls[0]!.text).not.toContain("alert_deliveries");
  });

  it("solo admite scores válidos y motivos cerrados antes de tocar la base", async () => {
    const p = probe([{ id: input.event.id }]);
    const store = neonQueueStore("unused", p.sql);
    await expect(store.finish(input.event.id, "worker", { state: "scored", score: { ...score, importance_score: 8.5 }, needs_delivery: true }, t0)).rejects.toThrow();
    await expect(store.finishBatch([
      { id: input.event.id, outcome: { state: "scored", score, needs_delivery: true } },
      { id: input.event.id, outcome: { state: "discarded", reason: "duplicate_story" } },
    ], "worker", t0)).rejects.toThrow("duplicate_or_empty_queue_finish");
    expect(p.calls).toHaveLength(0);
  });

  it("reabre finalización con score persistido y solo borra su flag al confirmar", async () => {
    const p = probe([dbRow({ state: "scored", score, processed_at: t0, delivery_pending: true })]);
    const store = neonQueueStore("unused", p.sql);
    expect(await store.listDeliveryPending()).toMatchObject([{ score, delivery_pending: true }]);
    p.respond([{ id: input.event.id }]);
    await store.completeDelivery(input.event.id);
    expect(p.calls[1]!.text).toContain("set delivery_pending = false");
    expect(p.calls[1]!.text).not.toContain("alert_deliveries");
  });

  it("métricas agrupan fuente, edad y motivos; bigint no se confunde con cero", async () => {
    const p = probe([{ source_key: "rss:feed", publisher: "Example Publisher", captured: "42000", unique: 300,
      pending: 21, processing: 1, retryable_failed: 3, scored: 200, discarded: 79, processed: 279,
      delivery_pending: 2, oldest_pending_at: t0, discarded_by_reason: { rules_no_match: 79 } }]);
    expect(await neonQueueStore("unused", p.sql).stats(t1)).toEqual([{
      source_key: "rss:feed", publisher: "Example Publisher", captured: 42000, unique: 300,
      pending: 21, processing: 1, retryable_failed: 3, scored: 200, discarded: 79, processed: 279,
      delivery_pending: 2, oldest_pending_at: t0, oldest_pending_age_hours: 1, discarded_by_reason: { rules_no_match: 79 },
    }]);
    expect(p.calls[0]!.text).toContain("group by q.source_key");
  });

  it("migración local no altera ni libera events/entregas y exige coherencia de estados", () => {
    const migration = readFileSync(new URL("../neon/migrations/20260910_capture_queue.sql", import.meta.url), "utf8");
    const statements = splitStatements(migration);
    expect(statements).toHaveLength(5);
    expect(statements.every((statement) => /^create (?:table|index) if not exists capture_queue/i.test(statement))).toBe(true);
    expect(statements.join("\n")).not.toMatch(/\b(?:events|alert_deliveries)\b/);
    expect(migration).toContain("check ((state = 'scored') = (score is not null))");
    expect(migration).toContain("check (not delivery_pending or state = 'scored')");
  });
});
