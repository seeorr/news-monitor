import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileQueueStore, MAX_RETRY_DELAY_MS, memoryQueueStore, prepareQueueCaptures, retryDelayMs,
  type QueueCapture, type QueueScore, type QueueStore,
} from "../src/pipeline/queue.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";

const t0 = "2026-09-10T10:00:00.000Z";
const t1 = "2026-09-10T11:00:00.000Z";
const t2 = "2026-09-10T12:00:00.000Z";
const score: QueueScore = { importance_score: 8, market_impact_score: 7,
  sentiment: "neutral", needs_alert: true, one_liner: "El IPC supera el dato anterior." };
const dirs: string[] = [];

function capture(index: number, overrides: Partial<QueueCapture> = {}): QueueCapture {
  return {
    publisher: "Editor A",
    event: { id: `rss:feed-a:${String(index).padStart(3, "0")}`, source: "rss", source_url: "https://example.test/story",
      series_id: "feed-a", kind: "news", title: `Inflation story ${index}`, summary: "Consumer prices rise.",
      country: "US", observed_at: "2026-09-10T09:30:00.000Z", retrieved_at: t0,
      actual: null, previous: null, consensus: null, unit: null, surprises: [], stale: false, official: false },
    ...overrides,
  };
}
function directory(): string {
  const base = join(process.cwd(), ".cache");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "queue-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function finishScored(store: QueueStore, id: string, token = "worker", needsDelivery = false) {
  await store.finish(id, token, { state: "scored", score, needs_delivery: needsDelivery }, t0);
}

describe("cola persistente: excedentes, reinicio y captura repetida", () => {
  it("guarda 31 antes del cupo de 12; al reiniciar con RSS vacío conserva los 19 excedentes", async () => {
    const dir = directory();
    const first = fileQueueStore(dir);
    const batch = Array.from({ length: 31 }, (_, index) => capture(index));
    expect(await first.capture(batch, t0)).toMatchObject({ captured: 31, unique: 31, repeated: 0 });
    const selected = (await first.listPending(t0)).slice(0, 12);
    const claimed = await first.claim(selected.map((row) => row.id), { token: "worker", now: t0 });
    for (const row of claimed) await finishScored(first, row.id);

    const restarted = fileQueueStore(dir);
    expect(await restarted.capture([], t1)).toMatchObject({ captured: 0, unique: 0 });
    const pending = await restarted.listPending(t1);
    expect(pending).toHaveLength(19);
    expect(pending.map((row) => row.id)).toEqual(batch.slice(12).map((item) => item.event.id));
    expect(pending[0]).toMatchObject({ state: "pending", attempts: 0, first_captured_at: t0,
      publication_at: "2026-09-10T09:30:00.000Z", event: batch[12]!.event });
    expect(await restarted.stats(t1)).toMatchObject([{ captured: 31, unique: 31, pending: 19,
      processed: 12, scored: 12, oldest_pending_age_hours: 1 }]);
  });

  it("repetir el lote no resetea puntuaciones, intentos, snapshot ni primera captura", async () => {
    const dir = directory();
    const store = fileQueueStore(dir);
    const first = capture(0);
    await store.capture([first], t0);
    await store.claim([first.event.id], { token: "worker", now: t0 });
    await finishScored(store, first.event.id, "worker", true);
    const later = { ...first, publisher: "Otro editor", event: { ...first.event, title: "Changed title", retrieved_at: t1 }, publication_at: t1 };
    expect(await fileQueueStore(dir).capture([later, later], t1)).toMatchObject({ captured: 2, unique: 0, repeated: 2 });
    expect(await fileQueueStore(dir).listPending(t2)).toEqual([]);
    expect(await fileQueueStore(dir).listDeliveryPending()).toMatchObject([{
      event: first.event, publisher: "Editor A", state: "scored", score, attempts: 1,
      first_captured_at: t0, last_captured_at: t1, capture_count: 3,
      publication_at: first.event.observed_at,
    }]);
  });

  it("deduplica ids dentro del lote y cuenta apariciones por fuente", async () => {
    const store = memoryQueueStore();
    const row = capture(0);
    expect(await store.capture([row, row, capture(1)], t0)).toEqual({ captured: 3, unique: 2, repeated: 1,
      bySource: { "rss:feed-a": { captured: 3, unique: 2, repeated: 1 } } });
    expect(await store.listPending(t0)).toHaveLength(2);
    expect(await store.stats(t1)).toMatchObject([{ captured: 3, unique: 2, pending: 2 }]);
  });

  it("capturar no da por procesado en SeenStore ni altera el registro de entregas", async () => {
    const queue = memoryQueueStore();
    const seen = memorySeenStore();
    const row = capture(0);
    await queue.capture([row], t0);
    expect(await seen.has(row.event.id)).toBe(false);
    expect(seen.entregas.size).toBe(0);
  });

  it("persiste descartes y su motivo al capturar, sin resucitarlos por repetición", async () => {
    const store = fileQueueStore(directory());
    await store.capture([capture(0, { decision: { state: "discarded", reason: "rules_low_signal" } }),
      capture(1, { decision: { state: "discarded", reason: "stale_at_capture" } })], t0);
    await store.capture([capture(0), capture(1)], t1);
    expect(await store.listPending(t1)).toEqual([]);
    expect(await store.stats(t1)).toMatchObject([{ captured: 4, unique: 2, pending: 0, processed: 2,
      discarded: 2, discarded_by_reason: { rules_low_signal: 1, stale_at_capture: 1 } }]);
  });

  it("un rechazo posterior no borra una candidata pendiente ya capturada", async () => {
    const store = memoryQueueStore();
    await store.capture([capture(0)], t0);
    await store.capture([capture(0, { decision: { state: "discarded", reason: "stale_at_capture" } })], t2);
    expect(await store.listPending(t2)).toMatchObject([{ state: "pending", first_captured_at: t0, reason: null }]);
  });

  it("mantiene separados publicación desconocida, primera captura y periodo macro", async () => {
    const macro = capture(0);
    macro.event.kind = "macro_release";
    macro.event.source = "fred";
    macro.event.observed_at = "2026-08-01";
    macro.publication_at = "2026-09-10T08:30:00Z";
    const row = prepareQueueCaptures([macro], t0)[0]!;
    expect(row).toMatchObject({ publication_at: "2026-09-10T08:30:00.000Z",
      data_period_at: "2026-08-01T00:00:00.000Z", first_captured_at: t0, source_key: "fred" });
    expect(prepareQueueCaptures([capture(1, { publication_at: null })], t0)[0]).toMatchObject({
      publication_at: null, data_period_at: null, first_captured_at: t0,
    });
    expect(prepareQueueCaptures([{ ...macro, data_period_at: null }], t0)[0]!.data_period_at).toBeNull();
  });

  it("valida todo el lote antes de escribir y no pierde los pendientes ante JSON corrupto", async () => {
    const dir = directory();
    const store = fileQueueStore(dir);
    const invalid = capture(1);
    invalid.event.title = "";
    await expect(async () => store.capture([capture(0), invalid], t0)).rejects.toThrow();
    expect(await store.listPending(t0)).toEqual([]);
    await store.capture([capture(0)], t0);
    writeFileSync(join(dir, "queue.json"), "{corrupt", "utf8");
    await expect(fileQueueStore(dir).listPending(t0)).rejects.toThrow();
    await expect(fileQueueStore(dir).capture([capture(1)], t0)).rejects.toThrow();
    expect(readFileSync(join(dir, "queue.json"), "utf8")).toBe("{corrupt");
  });

  it("un bloqueo huérfano falla cerrado sin borrar el lock ni modificar la cola", async () => {
    const dir = directory();
    const store = fileQueueStore(dir);
    await store.capture([capture(0)], t0);
    const original = readFileSync(join(dir, "queue.json"), "utf8");
    const orphan = JSON.stringify({ pid: 2147483647 });
    writeFileSync(join(dir, "queue.json.lock"), orphan, "utf8");
    await expect(store.capture([capture(1)], t1)).rejects.toThrow("queue_file_busy");
    expect(readFileSync(join(dir, "queue.json.lock"), "utf8")).toBe(orphan);
    expect(readFileSync(join(dir, "queue.json"), "utf8")).toBe(original);
  });
});

describe("reclamos, fallos y recuperación", () => {
  for (const implementation of ["memory", "file"] as const) {
    it(`${implementation}: contexto de historia cruza scanLimit e incluye puntuadas, en vuelo y duplicados`, async () => {
      const dir = implementation === "file" ? directory() : null;
      const store = dir ? fileQueueStore(dir) : memoryQueueStore();
      const batch = Array.from({ length: 510 }, (_, index) => capture(index));
      await store.capture(batch, t0);
      const old = capture(700); old.event.observed_at = "2026-09-08T09:30:00.000Z";
      const filing = capture(701); filing.event.kind = "filing";
      const macro = capture(702); macro.event.kind = "macro_release";
      await store.capture([old, filing, macro], t0);
      await store.claim(batch.slice(0, 6).map((item) => item.event.id), { token: "owner", now: t0 });
      await store.finishBatch([
        { id: batch[0]!.event.id, outcome: { state: "scored", score, needs_delivery: true } },
        { id: batch[2]!.event.id, outcome: { state: "retryable_failed", reason: "scoring_failed" } },
        { id: batch[3]!.event.id, outcome: { state: "discarded", reason: "duplicate_story" } },
        { id: batch[4]!.event.id, outcome: { state: "discarded", reason: "legacy_processed" } },
        { id: batch[5]!.event.id, outcome: { state: "discarded", reason: "rules_no_match" } },
      ], "owner", t0);
      const reopened = dir ? fileQueueStore(dir) : store;
      const context = await reopened.storyContext(batch[0]!.event);
      expect(context).toHaveLength(509);
      expect(context.find((row) => row.id === batch[0]!.event.id)).toMatchObject({ state: "scored" });
      expect(context.find((row) => row.id === batch[1]!.event.id)).toMatchObject({ state: "processing" });
      expect(context.find((row) => row.id === batch[2]!.event.id)).toMatchObject({ state: "retryable_failed" });
      expect(context.find((row) => row.id === batch[3]!.event.id)).toMatchObject({ reason: "duplicate_story" });
      expect(context.find((row) => row.id === batch[4]!.event.id)).toMatchObject({ reason: "legacy_processed" });
      expect(context.find((row) => row.id === batch[509]!.event.id)).toBeDefined();
      expect(context.every((row) => row.story_at === "2026-09-10T09:30:00.000Z")).toBe(true);
      expect(context.some((row) => [old.event.id, filing.event.id, macro.event.id, batch[5]!.event.id].includes(row.id))).toBe(false);
      expect(await reopened.storyContext(filing.event)).toEqual([]);
      expect(await reopened.storyContext(macro.event)).toEqual([]);
      const unknown = { ...batch[0]!.event, publication_at: null, observed_at: "unknown" };
      expect(await reopened.storyContext(unknown)).toEqual([]);
    });

    it(`${implementation}: más entradas de un editor que scanLimit no ocultan otro editor`, async () => {
      const store = implementation === "file" ? fileQueueStore(directory()) : memoryQueueStore();
      await store.capture(Array.from({ length: 510 }, (_, index) => capture(index)), t0);
      const other = capture(999, { publisher: "Editor B" });
      await store.capture([other], t1);
      const scanned = await store.listPending(t1, 12);
      expect(scanned).toHaveLength(12);
      expect(scanned[1]).toMatchObject({ id: other.event.id, publisher: "Editor B" });
      expect(scanned.filter((row) => row.publisher === "Editor A").map((row) => row.id))
        .toEqual(Array.from({ length: 11 }, (_, index) => capture(index).event.id));
    });

    it(`${implementation}: un grupo no se reclama parcialmente si otro worker posee el representante`, async () => {
      const store = implementation === "file" ? fileQueueStore(directory()) : memoryQueueStore();
      const first = capture(0), duplicate = capture(1);
      await store.capture([first, duplicate], t0);
      await store.claim([first.event.id], { token: "existing", now: t0 });
      expect(await store.claim([first.event.id, duplicate.event.id],
        { token: "competitor", now: t0, allOrNothing: true })).toEqual([]);
      expect(await store.listPending(t0)).toMatchObject([{ id: duplicate.event.id, state: "pending", attempts: 0 }]);
      expect(await store.claim([first.event.id, duplicate.event.id],
        { token: "recovery", now: t1, allOrNothing: true })).toHaveLength(2);
    });

    it(`${implementation}: dos consumidores concurrentes no reclaman el mismo trabajo`, async () => {
      const dir = implementation === "file" ? directory() : null;
      const a = dir ? fileQueueStore(dir) : memoryQueueStore();
      const b = dir ? fileQueueStore(dir) : a;
      const ids = [capture(0), capture(1), capture(2)].map((item) => item.event.id);
      await a.capture([capture(0), capture(1), capture(2)], t0);
      const claims = await Promise.all([a.claim(ids, { token: "worker-a", now: t0 }),
        b.claim(ids, { token: "worker-b", now: t0 })]);
      expect(claims.flat()).toHaveLength(3);
      expect(new Set(claims.flat().map((row) => row.id)).size).toBe(3);
      expect(claims.flat().every((row) => row.attempts === 1)).toBe(true);
      const all = await a.stats(t0);
      expect(all).toMatchObject([{ pending: 3, processing: 3, processed: 0 }]);
    });

    it(`${implementation}: cerrar un grupo es todo o nada si una lease ya no es propia`, async () => {
      const dir = implementation === "file" ? directory() : null;
      const store = dir ? fileQueueStore(dir) : memoryQueueStore();
      const first = capture(0), duplicate = capture(1);
      await store.capture([first, duplicate], t0);
      await store.claim([first.event.id], { token: "one", now: t0 });
      await store.claim([duplicate.event.id], { token: "two", now: t0 });
      await expect(store.finishBatch([
        { id: first.event.id, outcome: { state: "scored", score, needs_delivery: true } },
        { id: duplicate.event.id, outcome: { state: "discarded", reason: "duplicate_story" } },
      ], "one", t0)).rejects.toThrow("processing_claim_lost");
      expect(await store.listDeliveryPending()).toEqual([]);
      expect(await store.stats(t0)).toMatchObject([{ pending: 2, processing: 2, scored: 0, discarded: 0 }]);
      // Al recuperar las dos leases juntas, representante y duplicado cierran
      // en una sola escritura. No existe un instante con uno aún pendiente.
      await store.claim([first.event.id, duplicate.event.id], { token: "recovered", now: t1 });
      await store.finishBatch([
        { id: first.event.id, outcome: { state: "scored", score, needs_delivery: true } },
        { id: duplicate.event.id, outcome: { state: "discarded", reason: "duplicate_story" } },
      ], "recovered", t1);
      const reopened = dir ? fileQueueStore(dir) : store;
      expect(await reopened.listPending(t1)).toEqual([]);
      expect(await reopened.listDeliveryPending()).toMatchObject([{ id: first.event.id, score }]);
      expect(await reopened.stats(t1)).toMatchObject([{ pending: 0, scored: 1, discarded: 1,
        discarded_by_reason: { duplicate_story: 1 } }]);
    });
  }

  it("una lease caducada permite reintentar scoring pero no libera un sending de Telegram", async () => {
    const queue = memoryQueueStore();
    const seen = memorySeenStore();
    const id = capture(0).event.id;
    await queue.capture([capture(0)], t0);
    await queue.claim([id], { token: "old", now: t0, leaseMs: 60_000 });
    expect(await seen.claimAlert(id, { token: "telegram-original" })).toBe(true);
    expect(await queue.listPending("2026-09-10T10:00:59.000Z")).toEqual([]);
    const reclaimed = await queue.claim([id], { token: "new", now: t1 });
    expect(reclaimed).toMatchObject([{ attempts: 2, lease_token: "new", reason: "processing_expired" }]);
    await expect(queue.finish(id, "old", { state: "scored", score, needs_delivery: true }, t1)).rejects.toThrow("processing_claim_lost");
    expect(await seen.claimAlert(id, { token: "telegram-new" })).toBe(false);
    // Sin plazo: `sending` no se libera por tiempo, así que no tiene ninguno.
    expect(seen.entregas.get(id)).toEqual({ estado: "sending", token: "telegram-original", nextAttemptAt: null });
  });

  it("un worker no cierra después de su plazo aunque nadie haya reclamado todavía", async () => {
    const queue = memoryQueueStore();
    const id = capture(0).event.id;
    await queue.capture([capture(0)], t0);
    await queue.claim([id], { token: "old", now: t0, leaseMs: 60_000 });
    await expect(queue.finish(id, "old", { state: "discarded", reason: "duplicate_story" }, t1))
      .rejects.toThrow("processing_claim_lost");
    expect(await queue.listPending(t1)).toMatchObject([{ state: "processing" }]);
  });

  it("fallo aislado: una fila reintenta con backoff y las otras pueden terminar", async () => {
    const queue = fileQueueStore(directory());
    const id0 = capture(0).event.id, id1 = capture(1).event.id;
    await queue.capture([capture(0), capture(1)], t0);
    await queue.claim([id0, id1], { token: "worker", now: t0 });
    await queue.finish(id0, "worker", { state: "retryable_failed", reason: "scoring_failed" }, t0);
    await finishScored(queue, id1);
    expect(await queue.listPending("2026-09-10T10:00:59.000Z")).toEqual([]);
    expect(await queue.listPending("2026-09-10T10:01:00.000Z")).toMatchObject([{
      id: id0, state: "retryable_failed", reason: "scoring_failed", attempts: 1, next_attempt_at: "2026-09-10T10:01:00.000Z",
    }]);
    await queue.claim([id0], { token: "worker-two", now: t1 });
    await queue.finish(id0, "worker-two", { state: "retryable_failed", reason: "scoring_failed" }, t1);
    expect(await queue.listPending("2026-09-10T11:01:59.000Z")).toEqual([]);
    expect(await queue.listPending("2026-09-10T11:02:00.000Z")).toMatchObject([{ attempts: 2, first_captured_at: t0 }]);
    expect(await queue.stats(t2)).toMatchObject([{ pending: 1, retryable_failed: 1, scored: 1, oldest_pending_age_hours: 2 }]);
    expect(retryDelayMs(99)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("reanuda una entrega pendiente después del reinicio con el score guardado, sin repuntuar", async () => {
    const dir = directory();
    const first = fileQueueStore(dir);
    const id = capture(0).event.id;
    await first.capture([capture(0)], t0);
    await first.claim([id], { token: "worker", now: t0 });
    await finishScored(first, id, "worker", true);
    const restarted = fileQueueStore(dir);
    expect(await restarted.listPending(t1)).toEqual([]);
    expect(await restarted.listDeliveryPending()).toMatchObject([{ id, score, delivery_pending: true }]);
    await restarted.completeDelivery(id);
    await restarted.completeDelivery(id);
    expect(await fileQueueStore(dir).listDeliveryPending()).toEqual([]);
    expect(await fileQueueStore(dir).stats(t1)).toMatchObject([{ processed: 1, scored: 1, delivery_pending: 0 }]);
  });

  it("un snapshot leído no permite mutar el estado guardado y el escaneo limita por edad", async () => {
    const queue = memoryQueueStore();
    await queue.capture([capture(1)], t0);
    await queue.capture([capture(0)], t1);
    const rows = await queue.listPending(t1, 1);
    expect(rows.map((row) => row.id)).toEqual([capture(1).event.id]);
    rows[0]!.event.title = "Changed externally";
    expect((await queue.listPending(t1))[0]!.event.title).toBe(capture(1).event.title);
    await expect(async () => queue.listPending(t1, 0)).rejects.toThrow("invalid_queue_limit");
  });
});
