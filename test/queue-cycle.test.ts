import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCandidates, deliverQueue, processQueue } from "../src/pipeline/queue-cycle.ts";
import { fileQueueStore, memoryQueueStore, type QueueScore } from "../src/pipeline/queue.ts";
import { planQueue } from "../src/pipeline/queue-plan.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const now = "2026-09-10T12:00:00.000Z";
const later = "2026-09-14T12:00:00.000Z";
const score: QueueScore = { importance_score: 4, market_impact_score: 3,
  sentiment: "neutral", needs_alert: false, one_liner: "Dato confirmado." };
function event(id: number, feed = "yahoo-finance", extras: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { id: `rss:${feed}:${id}`, source: "rss", source_url: `https://example.test/${id}`,
    kind: "news", title: `Inflation report ${id}`, summary: null, country: "US", series_id: feed,
    observed_at: now, retrieved_at: now, actual: null, previous: null, consensus: null,
    unit: null, surprises: [], stale: false, official: false, ...extras };
}
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() {
  mkdirSync(".cache", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".cache", "queue-cycle-"));
  dirs.push(dir); return dir;
}
const capture = (queue: ReturnType<typeof memoryQueueStore>, events: NormalizedEvent[], at = now) =>
  captureCandidates(queue, events, { now: at, maxAgeHours: 72 });

describe("ciclo de cola con persistencia real y modelos doblados", () => {
  it("agrupa una copia fuera de las 500 pendientes y otra capturada después de puntuar", async () => {
    const queue = memoryQueueStore();
    const original = event(999, "a", { title: "Consumer prices rise 3 percent as inflation accelerates" });
    const hidden = { ...original, id: "rss:zzz:copy", series_id: "zzz" };
    await queue.capture([original, ...Array.from({ length: 500 }, (_, id) => event(id, "z"))]
      .map((e) => ({ event: e, publisher: "same-publisher" })), now);
    await queue.capture([{ event: hidden, publisher: "same-publisher" }], "2026-09-10T12:00:01.000Z");
    expect((await queue.listPending(now, 500)).map((row) => row.id)).not.toContain(hidden.id);
    const scoring = vi.fn().mockResolvedValue(score);
    const options = { maxScoring: 1, scanLimit: 500, score: scoring, hasProcessed: async () => false,
      now: () => "2026-09-10T12:00:01.000Z" };
    await processQueue(queue, options);
    expect(scoring).toHaveBeenCalledTimes(1);
    expect((await queue.storyContext(original)).find((row) => row.id === hidden.id))
      .toMatchObject({ state: "discarded", reason: "duplicate_story" });
    const late = { ...original, id: "rss:new:late", series_id: "new" };
    await queue.capture([{ event: late, publisher: "another-publisher" }], "2026-09-10T12:00:02.000Z");
    await processQueue(queue, { ...options, maxScoring: 12 });
    expect(scoring.mock.calls.filter(([e]) => e.title === original.title)).toHaveLength(1);
    expect((await queue.storyContext(original)).find((row) => row.id === late.id))
      .toMatchObject({ state: "discarded", reason: "duplicate_story" });
    expect((await queue.listDeliveryPending()).filter((row) => row.event.title === original.title)).toHaveLength(1);
  });
  it("31 > 12, reinicio, RSS ya sin excedentes y cuatro días después: procesa los 19 pendientes sin revalorar los 12", async () => {
    const path = directory(), seen = memorySeenStore();
    let queue = fileQueueStore(path);
    const events = Array.from({ length: 31 }, (_, id) => event(id));
    const scoring = vi.fn().mockResolvedValue(score);
    const options = { maxScoring: 12, score: scoring, hasProcessed: seen.has, now: () => now };
    await capture(queue, events);
    expect(await processQueue(queue, options)).toMatchObject({ attempted: 12, scored: 12 });
    const first = await queue.listDeliveryPending();
    expect(first).toHaveLength(12);
    expect(await queue.listPending(now)).toHaveLength(19);
    expect(await seen.has(first[0]!.id)).toBe(false);
    // Simula muerte antes de proyectar puntuaciones. Se reinician los lectores.
    queue = fileQueueStore(path);
    await capture(queue, [], later);
    await deliverQueue(queue, { limit: 12, deliver: async (entry) => {
      await seen.mark(entry.event); return { complete: true, sent: false };
    } });
    expect(scoring).toHaveBeenCalledTimes(12);
    expect(await seen.has(first[0]!.id)).toBe(true);
    await processQueue(queue, { ...options, now: () => later });
    await processQueue(fileQueueStore(path), { ...options, now: () => later });
    expect(scoring).toHaveBeenCalledTimes(31);
    expect(new Set(scoring.mock.calls.map(([e]) => e.id)).size).toBe(31);
    expect(await queue.listPending(later)).toHaveLength(0);
    expect(await capture(queue, events, later)).toMatchObject({ unique: 0, repeated: 31 });
    await processQueue(queue, { ...options, now: () => later });
    expect(scoring).toHaveBeenCalledTimes(31);
    expect(await queue.stats(later)).toMatchObject([{ unique: 31, captured: 62, pending: 0, scored: 31 }]);
  });

  it("puntuar falla en una noticia: conserva el snapshot para reintentar y procesa la siguiente", async () => {
    const queue = memoryQueueStore();
    await capture(queue, [event(1), event(2)]);
    const scoring = vi.fn().mockRejectedValueOnce(new Error("red")).mockResolvedValue(score);
    expect(await processQueue(queue, { maxScoring: 12, score: scoring, hasProcessed: async () => false, now: () => now }))
      .toMatchObject({ attempted: 2, failed: 1, scored: 1 });
    expect(await queue.listPending(now)).toHaveLength(0);
    expect(await queue.listPending("2026-09-10T12:01:00.000Z")).toHaveLength(1);
    expect(await queue.stats(now)).toMatchObject([{ pending: 1, retryable_failed: 1, scored: 1 }]);
  });

  it("entrega pendiente se reanuda sin scoring, y un reclamo sending no se libera por antigüedad", async () => {
    const queue = memoryQueueStore(), seen = memorySeenStore();
    await capture(queue, [event(1)]);
    const scoring = vi.fn().mockResolvedValue(score);
    await processQueue(queue, { maxScoring: 12, score: scoring, hasProcessed: seen.has, now: () => now });
    const deliver = vi.fn().mockRejectedValueOnce(new Error("Neon temporal")).mockImplementation(async (entry) => {
      const allowed = await seen.claimAlert(entry.id, { token: "second" });
      expect(allowed).toBe(false); return { complete: true, sent: false };
    });
    await seen.claimAlert(event(1).id, { token: "first" });
    expect(await deliverQueue(queue, { limit: 12, deliver })).toEqual({ sent: 0, failed: 1 });
    await processQueue(queue, { maxScoring: 12, score: scoring, hasProcessed: seen.has, now: () => later });
    await deliverQueue(queue, { limit: 12, deliver });
    expect(scoring).toHaveBeenCalledTimes(1);
    expect(await queue.listDeliveryPending()).toEqual([]);
    expect(seen.entregas.get(event(1).id)?.estado).toBe("sending");
  });

  it("guarda descartes con motivo antes del presupuesto y agrupa copias de la misma historia", async () => {
    const queue = memoryQueueStore();
    await capture(queue, [event(1), event(2, "cnbc-markets", { title: event(1).title }),
      event(3, "yahoo-finance", { title: "Welcome offer sign-up bonus" }),
      event(4, "yahoo-finance", { observed_at: "2026-08-01" }),
      event(5, "yahoo-finance", { title: "Local town celebrates its anniversary" })]);
    const scoring = vi.fn().mockResolvedValue(score);
    await processQueue(queue, { maxScoring: 12, score: scoring, hasProcessed: async () => false, now: () => now });
    expect(scoring).toHaveBeenCalledTimes(1);
    const stats = await queue.stats(now);
    expect(stats.reduce((n, row) => n + row.discarded, 0)).toBe(4);
    expect(stats.find((row) => row.source_key === "rss:yahoo-finance")?.discarded_by_reason)
      .toMatchObject({ stale_at_capture: 1, rules_low_signal: 1, rules_no_match: 1 });
    expect(await queue.listDeliveryPending()).toHaveLength(1);
  });
});

describe("reparto por editor y envejecimiento", () => {
  it.each([1, 2, 3])("cupo %i reserva la capacidad para noticias mientras una rutina espera", async (capacity) => {
    const queue = memoryQueueStore();
    await queue.capture([{ event: event(1, "central", { official: true, title: "Governor appointment" }), publisher: "central" }], now);
    await queue.capture(Array.from({ length: 4 }, (_, id) => ({ event: event(id + 100), publisher: "press" })), later);
    const plan = planQueue(await queue.listPending(later), { now: new Date(later), limit: capacity });
    expect(plan.every((item) => item.reason !== "routine_official")).toBe(true);
  });
  it("seis editores oficiales rutinarios juntos tampoco acaparan el cupo", async () => {
    const queue = memoryQueueStore();
    await queue.capture(Array.from({ length: 30 }, (_, id) => ({
      event: event(id, `central-${id % 6}`, { official: true, title: `Governor speech on inflation ${id}` }),
      publisher: `central-${id % 6}`,
    })), now);
    await queue.capture(Array.from({ length: 24 }, (_, id) => ({ event: event(100 + id), publisher: "press" })), now);
    const scored: NormalizedEvent[] = [];
    await processQueue(queue, { maxScoring: 12, hasProcessed: async () => false, now: () => now,
      score: async (e) => { scored.push(e); return score; } });
    expect(scored).toHaveLength(12);
    expect(scored.filter((e) => e.official).length).toBeLessThanOrEqual(3);
    expect(scored.filter((e) => !e.official).length).toBeGreaterThanOrEqual(9);
  });
  it("nueve feeds de un editor no ganan nueve turnos y un oficial rutinario no desplaza la noticia material", async () => {
    const queue = memoryQueueStore();
    await queue.capture(Array.from({ length: 24 }, (_, id) => ({ event: event(id, `section-${id % 9}`), publisher: "one-publisher" })), now);
    await queue.capture(Array.from({ length: 8 }, (_, id) => ({ event: event(100 + id, "material"), publisher: "other" })), now);
    await queue.capture([{ event: event(200, "central", { official: true, title: "Governor appointment and conference speech" }), publisher: "central" }], now);
    const plan = planQueue(await queue.listPending(now), { now: new Date(now), limit: 12 });
    expect(new Set(plan.slice(0, 2).map((item) => item.publisher))).toEqual(new Set(["one-publisher", "other"]));
    expect(plan[2]?.publisher).toBe("central");
    const counts = Object.fromEntries(["one-publisher", "other", "central"].map((publisher) => [publisher, plan.filter((item) => item.publisher === publisher).length]));
    expect(counts.central).toBe(1);
    expect([counts["one-publisher"], counts.other].sort()).toEqual([5, 6]);
    expect(plan.find((item) => item.publisher === "central")).toMatchObject({ reason: "routine_official", base: 0 });
  });

  it("el tiempo de espera sin techo termina adelantando a una novedad prioritaria", async () => {
    const queue = memoryQueueStore();
    await queue.capture([{ event: event(1, "central", { official: true, title: "Governor appointment" }), publisher: "central" }], now);
    await queue.capture([{ event: event(2, "central", { official: true, title: "CPI inflation rises 2 percent" }), publisher: "central" }], later);
    const plan = planQueue(await queue.listPending(later), { now: new Date(later), limit: 1, capacity: 12 });
    expect(plan[0]).toMatchObject({ reason: "routine_official", agePoints: 16, points: 16 });
    expect(plan[0]?.group.representante.id).toBe(event(1, "central").id);
  });
});
