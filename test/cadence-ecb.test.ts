import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { captureCandidates, processQueue } from "../src/pipeline/queue-cycle.ts";
import { memoryQueueStore, fileQueueStore } from "../src/pipeline/queue.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";
import { memoryControlStore } from "../src/pipeline/control.ts";
import { deliverNews, type NewsDeliveryOptions } from "../src/pipeline/news-delivery.ts";
import { criticalMacro, rateFact } from "../src/pipeline/critical-macro.ts";
import { sameStory, relatedUpdate } from "../src/pipeline/agrupar.ts";
import { applyRules } from "../src/pipeline/rules.ts";
import { decideNews } from "../src/pipeline/news-policy.ts";
import { enrichEcbDecision, parseEcbDecision } from "../src/sources/ecb-release.ts";
import { parseFeed } from "../src/lib/feed.ts";
import { toEvents, FEEDS } from "../src/sources/rss.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";
import type { Scoring, CascadeDeps } from "../src/ai/cascade.ts";

const published = "2026-09-10T12:15:00.000Z", captured = "2026-09-10T12:23:20.000Z";
// Forma del RSS y párrafos mínimos contrastados contra el comunicado público.
// Los tiempos de ejecución, modelo y Telegram de estos tests son SIMULADOS.
const url = "https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.mp260910~314e508016.en.html";
const rss = `<rss><channel><item><title>Monetary policy decisions</title><link>${url}</link><guid>${url}</guid><pubDate>Thu, 10 Sep 2026 14:15:00 +0200</pubDate></item></channel></rss>`;
const html = `<main><h1>Monetary policy decisions</h1><p>The Governing Council today decided to raise the three key ECB interest rates by 25&nbsp;basis points.</p><p>The interest rates on the deposit facility, the main refinancing operations and the marginal lending facility will be increased to 2.50%, 2.65% and 2.90% respectively, with effect from 16 September 2026.</p></main>`;
const original = () => toEvents(parseFeed(rss), FEEDS["ecb-press"]!, { retrievedAt: captured })[0]!;
const enriched = (): NormalizedEvent => ({ ...original(), summary: parseEcbDecision(html) });
const press = (id = "press-copy", delta = 25, rate = "2.50"): NormalizedEvent => ({ ...original(), id,
  official: false, series_id: "yahoo-finance", source_url: "https://example.test/press",
  title: `ECB raises interest rates by ${delta} basis points`, summary: `The European Central Bank raises interest rates by ${delta} basis points. Its deposit facility rate increases to ${rate}%.` });
const scoring: Scoring = { importance_score: 8, market_impact_score: 8, needs_alert: true, sentiment: "neutral", one_liner: "El BCE eleva los tipos 25 puntos básicos; el depósito queda en el 2,50 %." };
const standard = (id: number): NormalizedEvent => ({ ...press(`ordinary-${id}`), title: `Copper production falls in district ${id}`,
  summary: `The operator confirms copper production fell in district ${id} because of maintenance.`, observed_at: "2026-09-10T09:00:00.000Z", publication_at: "2026-09-10T09:00:00.000Z" });
function delivery(extra: Partial<NewsDeliveryOptions> = {}): NewsDeliveryOptions {
  return { now: captured, queue: memoryQueueStore(), seen: memorySeenStore(), control: memoryControlStore(), deps: null,
    maxItems: 500, maxDeep: 1, maxPendingHours: 48, briefThreshold: 5, importantThreshold: 7, watchlistImportantThreshold: 6,
    briefHour: 6, briefDay: 24, importantHour: 3, importantDay: 12, batchSize: 3, briefIntervalMinutes: 60,
    canSend: true, send: vi.fn(async () => "sent" as const), ...extra };
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("test_network_forbidden"); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("regresión BCE, cola y reloj simulado", () => {
  it("RSS real sin entradilla pasa sin watchlist; enriquecer habilita evidencia suficiente", async () => {
    expect(original().summary).toBeNull(); expect(applyRules(original(), { watchlist: [] }).pass).toBe(true);
    expect(criticalMacro(original())).toBe(true);
    const get = vi.fn().mockResolvedValue(new Response(html));
    const event = await enrichEcbDecision(original(), get);
    expect(event.publication_at).toBe(published);
    expect(decideNews(event, scoring, { now: captured }).eligible.importantAlert).toBe(true);
    expect(rateFact(event)).toMatchObject({ rate: 2.5, delta: 25, bank: "ecb" });
    expect(get).toHaveBeenCalledTimes(1); expect(get.mock.calls[0]![1].redirect).toBe("error");
    expect(criticalMacro({ ...event, title: "Working paper on monetary transmission", summary: null })).toBe(false);
    expect(criticalMacro({ ...event, title: "ECB could raise interest rates tomorrow" })).toBe(false);
  });
  it("último ciclo 11:50, publicación 12:15, fast 12:23, entrega antes de 12:30 y cron sin duplicación", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(captured));
    const o = delivery();
    const score = vi.fn(async (_event: NormalizedEvent) => scoring);
    // 520 candidatas anteriores: el BCE debe entrar incluso antes del scanLimit.
    await o.queue.capture(Array.from({ length: 520 }, (_, id) => ({ event: standard(id), publisher: "yahoo" })), "2026-09-10T11:50:00.000Z");
    const captures = await Promise.all([captureCandidates(o.queue, [original()], { now: captured, maxAgeHours: 72 }),
      captureCandidates(o.queue, [original()], { now: captured, maxAgeHours: 72 })]);
    expect(captures.reduce((n, row) => n + row.unique, 0)).toBe(1);
    expect((await o.queue.listPending(captured, 12))[0]!.id).toBe(original().id);
    const get = vi.fn(async () => new Response(html));
    await processQueue(o.queue, { maxScoring: 1, scanLimit: 12, now: () => new Date().toISOString(), hasProcessed: o.seen.has,
      enrich: (event) => enrichEcbDecision(event, get), score });
    vi.setSystemTime(new Date("2026-09-10T12:24:10.000Z"));
    expect((await deliverNews({ ...o, now: new Date().toISOString(), onlyCritical: true })).sent).toBe(1);
    const row = (await o.queue.storyContext(enriched())).find((row) => row.id === original().id)!;
    expect(Date.parse(row.first_captured_at)).toBeLessThan(Date.parse("2026-09-10T12:25:00Z"));
    expect(Date.now()).toBeLessThan(Date.parse("2026-09-10T12:30:00Z"));
    expect(row.publication_at).toBe(published); expect(row.processed_at).toBe(captured);
    // Copia de prensa de la misma decisión, a las 12:37 en el respaldo interno.
    vi.setSystemTime(new Date("2026-09-10T12:37:00.000Z"));
    await captureCandidates(o.queue, [original(), press()], { now: new Date().toISOString(), maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, scanLimit: 12, now: () => new Date().toISOString(), hasProcessed: o.seen.has, score });
    await deliverNews({ ...o, now: new Date().toISOString(), onlyCritical: true });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(score.mock.calls.filter(([event]) => event.id === original().id)).toHaveLength(1);
    expect((await o.queue.storyContext(enriched())).find((row) => row.id === "press-copy")?.reason).toBe("duplicate_story");
  });
  it("fast persiste, reinicia full con RSS vacío; no pierde ni repuntúa", async () => {
    mkdirSync(".cache", { recursive: true }); const dir = mkdtempSync(join(".cache", "cadence-"));
    const first = fileQueueStore(dir);
    await captureCandidates(first, [enriched(), ...Array.from({ length: 14 }, (_, n) => standard(n))], { now: captured, maxAgeHours: 72 });
    const score = vi.fn(async () => scoring);
    await processQueue(first, { maxScoring: 1, now: () => captured, hasProcessed: async () => false, score });
    const full = fileQueueStore(dir); await captureCandidates(full, [], { now: captured, maxAgeHours: 72 });
    expect(await full.listPending(captured)).toHaveLength(14); expect(await full.listDeliveryPending()).toHaveLength(1);
    await captureCandidates(full, [enriched()], { now: captured, maxAgeHours: 72 });
    expect(score).toHaveBeenCalledTimes(1);
  });
  it("modelo fallido y enriquecimiento fallido conservan candidata reintentable", async () => {
    const queue = memoryQueueStore(), score = vi.fn().mockRejectedValue(new Error("simulated_model_failure"));
    await captureCandidates(queue, [original()], { now: captured, maxAgeHours: 72 });
    await processQueue(queue, { maxScoring: 1, now: () => captured, hasProcessed: async () => false,
      enrich: () => enrichEcbDecision(original(), vi.fn().mockResolvedValue(new Response("blocked", { status: 503 }))), score });
    expect(score).not.toHaveBeenCalled();
    const rows = await queue.listPending("2026-09-10T12:25:00Z"); expect(rows[0]?.state).toBe("retryable_failed");
    await processQueue(queue, { maxScoring: 1, now: () => "2026-09-10T12:25:00Z", hasProcessed: async () => false, enrich: async () => enriched(), score });
    expect((await queue.stats(captured))[0]?.retryable_failed).toBe(1);
  });
  it("prensa antes que el comunicado sin entradilla tampoco produce otra alerta", async () => {
    const o = delivery(), score = vi.fn(async () => scoring);
    await captureCandidates(o.queue, [press()], { now: captured, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score });
    await deliverNews(o);
    await captureCandidates(o.queue, [original()], { now: captured, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score, enrich: async () => enriched() });
    await deliverNews(o);
    expect(score).toHaveBeenCalledTimes(1); expect(o.send).toHaveBeenCalledTimes(1);
    const linked = (await o.queue.storyContext(enriched())).find((row) => row.id === original().id)!;
    expect(linked.reason).toBe("duplicate_story"); expect(sameStory(linked.event, press())).toBe(true);
  });
  it("serie ECBDFR posterior vincula el mismo hecho; otra decisión material permanece distinta", async () => {
    const series: NormalizedEvent = { ...enriched(), id: "fred:ECBDFR:2026-09-16", source: "fred", series_id: "ECBDFR", kind: "macro_release",
      title: "Tipo de depósito del BCE", summary: null, actual: 2.5, previous: 2.25, observed_at: "2026-09-16", data_period_at: "2026-09-16", publication_at: null };
    expect(sameStory(enriched(), press())).toBe(true); expect(sameStory(enriched(), series)).toBe(true);
    const changed = press("update", 50, "2.75");
    expect(sameStory(enriched(), changed)).toBe(false); expect(relatedUpdate(enriched(), changed)).toBe(true);
    const o = delivery(); await captureCandidates(o.queue, [enriched()], { now: captured, maxAgeHours: 72 });
    const score = vi.fn(async () => scoring);
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score });
    await deliverNews(o);
    await captureCandidates(o.queue, [series], { now: "2026-09-16T12:00:00Z", maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => "2026-09-16T12:00:00Z", hasProcessed: o.seen.has, score });
    expect(score).toHaveBeenCalledTimes(1);
    expect((await o.queue.storyContext(series)).find((row) => row.id === series.id)?.reason).toBe("duplicate_story");
  });
  it("entrega incierta no repite envío ni análisis; sin novedades no paga scoring", async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: { why_it_matters: "Puede afectar a los costes de financiación.", catalysts: [], risks: [], affected_assets: [], what_to_watch: [] }, stop_reason: "end_turn" });
    const deps = { client: { messages: { parse } }, modelScoring: "simulated", modelAnalysis: "simulated" } as unknown as CascadeDeps;
    const send = vi.fn(async () => "uncertain" as const), o = delivery({ deps, send });
    const score = vi.fn(async () => scoring);
    await captureCandidates(o.queue, [enriched()], { now: captured, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score });
    await Promise.all([deliverNews(o), deliverNews({ ...o, deps: null })]);
    const calls = parse.mock.calls.length;
    await captureCandidates(o.queue, [enriched()], { now: captured, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score });
    await deliverNews(o);
    expect(send).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledTimes(calls); expect(score).toHaveBeenCalledTimes(1);
    expect(await o.seen.alertState?.(original().id)).toBe("uncertain");
  });
  it("una actualización material genera una decisión nueva vinculada a la anterior", async () => {
    const o = delivery();
    await captureCandidates(o.queue, [enriched()], { now: captured, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => captured, hasProcessed: o.seen.has, score: async () => scoring });
    await deliverNews(o);
    const at = "2026-09-10T12:28:00.000Z", update = { ...press("material-update", 50, "2.75"), publication_at: at, observed_at: at };
    await captureCandidates(o.queue, [update], { now: at, maxAgeHours: 72 });
    await processQueue(o.queue, { maxScoring: 1, now: () => at, hasProcessed: o.seen.has,
      score: async () => ({ ...scoring, one_liner: "El BCE eleva los tipos 50 puntos básicos y sitúa el depósito en 2,75 %." }) });
    await deliverNews({ ...o, now: at });
    expect(o.send).toHaveBeenCalledTimes(2);
    expect(await o.control.getDecision(update.id)).toMatchObject({ level: "important", updateOf: { eventId: original().id } });
    expect(sameStory(enriched(), { ...press(), title: "Fed raises interest rates by 25 basis points", summary: "ECB deposit facility stays at 2.50%." })).toBe(false);
    expect(sameStory(enriched(), { ...press(), summary: `${press().summary} The ECB announces a new liquidity programme.` })).toBe(false);
  });
});
