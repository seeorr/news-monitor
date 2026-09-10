import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import type { Vigilado } from "../src/db/watchlist.ts";
import type { FeedItem } from "../src/lib/feed.ts";
import { sleep } from "../src/lib/concurrency.ts";
import { fetchText } from "../src/lib/http.ts";
import { collectEvents } from "../src/pipeline/collect.ts";

const mocks = vi.hoisted(() => ({ watchlist: vi.fn(), eurostat: vi.fn(), feed: vi.fn(), filings: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/db/watchlist.ts", async (original) => ({
  ...await original<typeof import("../src/db/watchlist.ts")>(), leerWatchlist: mocks.watchlist,
}));
vi.mock("../src/sources/eurostat.ts", async (original) => ({
  ...await original<typeof import("../src/sources/eurostat.ts")>(), fetchSerie: mocks.eurostat,
}));
vi.mock("../src/sources/rss.ts", async (original) => ({
  ...await original<typeof import("../src/sources/rss.ts")>(), fetchFeed: mocks.feed,
}));
vi.mock("../src/sources/sec-edgar.ts", async (original) => ({
  ...await original<typeof import("../src/sources/sec-edgar.ts")>(), fetchFilings: mocks.filings, resolveTickers: mocks.resolve,
}));

const retrievedAt = "2026-09-10T16:00:00Z";
const cfg = (changes: Partial<Config> = {}): Config => ({
  anthropicApiKey: null, fredApiKey: null, telegramBotToken: null, telegramChatId: null,
  telegramGroupChatId: null, databaseUrl: "postgres://synthetic.invalid/db", secUserAgent: "Synthetic test@example.invalid",
  secWatchlist: [], watchlist: [], feeds: ["fed-press", "ecb-press"], edgarForms: [],
  maxItemAgeHours: 72, maxScoringPerCycle: 12, maxDeepPerCycle: 3, agendaDias: 7,
  umbralAgrupacion: 0.6, modelScoring: "unused", modelAnalysis: "unused",
  deepAnalysisThreshold: 7, alertThreshold: 7, stateDir: ".cache/unused",
  sourceConcurrency: 3, sourceTimeoutMs: 100, collectionTimeoutMs: 1000, ...changes,
});
const company = (ticker: string, cik: string | null): Vigilado => ({
  ticker, nombre: "Synthetic company", cik, quoteSymbol: null,
  vigilarFilings: true, vigilarPrecio: false, umbralMovimiento: 3,
});
const item = (id: string): FeedItem => ({
  title: `Synthetic rate decision ${id}`, link: `https://example.invalid/${id}`, guid: id,
  date: "2026-09-10T15:00:00Z", summary: null, raw: "",
});
const filing = { accession: "0000123456-26-000001", formType: "8-K", formName: "Current report",
  filedAt: "2026-09-10T15:00:00Z", url: "https://example.invalid/filing", items: "2.02" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(retrievedAt));
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is prohibited in this test"); }));
  mocks.watchlist.mockResolvedValue([]);
  mocks.eurostat.mockRejectedValue(new Error("Synthetic source unavailable"));
  mocks.feed.mockResolvedValue([]);
  mocks.filings.mockResolvedValue([filing]);
  mocks.resolve.mockResolvedValue({ companies: [], unknown: [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("captura concurrente real", () => {
  it("fast incluye BCE aunque la selección explícita lo omita y excluye APIs pesadas", async () => {
    mocks.watchlist.mockResolvedValue([company("TEST", "0000123456")]);
    mocks.feed.mockImplementation(async (spec) => [item(spec.id)]);
    const work = collectEvents(cfg({ fredApiKey: "synthetic-unused", feeds: ["fed-press", "boe-news", "boj-news", "yahoo-finance", "investing-economy", "sec-press"] }),
      { retrievedAt, profile: "fast" });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.ok).toBe(5);
    expect(mocks.feed.mock.calls.map((call) => call[0].id)).toEqual(["ecb-press", "fed-press", "boe-news", "boj-news", "yahoo-finance"]);
    expect(mocks.eurostat).not.toHaveBeenCalled(); expect(mocks.filings).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("limita trabajo a tres fuentes y serializa las escrituras tempranas", async () => {
    let active = 0;
    let peak = 0;
    const capture = async () => { peak = Math.max(peak, ++active); await sleep(10); active--; };
    mocks.eurostat.mockImplementation(async () => { await capture(); return { geo: "EA21", obs: [{ date: "2026-09-01", value: 2 }] }; });
    mocks.feed.mockImplementation(async (spec) => { await capture(); return [item(spec.id)]; });
    let writing = 0;
    let writesPeak = 0;
    const saved: string[] = [];
    const work = collectEvents(cfg(), { retrievedAt, onCollected: async (events) => {
      writesPeak = Math.max(writesPeak, ++writing);
      await sleep(5);
      saved.push(...events.map((e) => e.id));
      writing--;
    } });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(peak).toBe(3);
    expect(writesPeak).toBe(1);
    expect(result.ok).toBe(6);
    expect(result.failures).toEqual([]);
    expect(result.events).toHaveLength(6);
    expect(new Set(saved).size).toBe(6);
    expect(saved.sort()).toEqual(result.events.map((e) => e.id).sort());
  });

  it("un feed colgado aborta su HTTP y conserva el lote sano ya persistido", async () => {
    let pendingSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation((_url, init) => {
      pendingSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    mocks.feed.mockImplementation(async (spec) => {
      if (spec.id === "fed-press") { await fetchText("https://hang.invalid"); return []; }
      return [item(spec.id)];
    });
    const saved: string[] = [];
    const work = collectEvents(cfg(), { retrievedAt, onCollected: async (events) => { saved.push(...events.map((e) => e.id)); } });
    await vi.advanceTimersByTimeAsync(50);
    expect(saved).toHaveLength(1);
    await vi.runAllTimersAsync();
    const result = await work;
    expect(pendingSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(1);
    expect(result.events.map((e) => e.id)).toEqual(saved);
    expect(result.failures).toContainEqual({ source: "rss:fed-press", detail: "SOURCE_TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("el plazo global cancela activos y declara los pendientes sin arrancarlos", async () => {
    mocks.eurostat.mockImplementation(() => new Promise(() => {}));
    const work = collectEvents(cfg({ collectionTimeoutMs: 30, feeds: ["not-registered"] }), { retrievedAt });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(mocks.eurostat).toHaveBeenCalledTimes(3);
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(4);
    expect(result.failures.every((f) => f.detail === "COLLECTION_TIMEOUT")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un fallo al guardar se propaga y no se presenta como fuente caída", async () => {
    mocks.eurostat.mockResolvedValue({ geo: "EA21", obs: [{ date: "2026-09-01", value: 2 }] });
    const storageError = new Error("Synthetic storage failure");
    const lines: string[] = [];
    let writes = 0;
    const work = collectEvents(cfg({ feeds: ["not-registered"] }), { retrievedAt, log: (line) => lines.push(line), onCollected: async () => {
      writes++;
      throw storageError;
    } });
    const assertion = expect(work).rejects.toBe(storageError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(writes).toBe(1);
    expect(lines.map((line) => JSON.parse(line)).filter((line) => line.code === "SOURCE_FAILED")).toEqual([]);
    expect(mocks.feed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("full persiste el BCE antes de esperar APIs macro lentas", async () => {
    mocks.eurostat.mockImplementation(() => new Promise(() => {}));
    mocks.feed.mockImplementation(async (spec) => [item(spec.id)]);
    const saved: string[] = [];
    const work = collectEvents(cfg(), { retrievedAt, profile: "full", onCollected: async (events) => { saved.push(...events.map((e) => e.series_id!)); } });
    await vi.advanceTimersByTimeAsync(5);
    expect(saved).toContain("ecb-press");
    expect(mocks.feed.mock.calls[0]![0].id).toBe("ecb-press");
    await vi.runAllTimersAsync();
    expect((await work).ok).toBe(2);
  });

  it("una empresa SEC fallida no borra los documentos de otra", async () => {
    mocks.watchlist.mockResolvedValue([company("FAIL", "0000123456"), company("GOOD", "0000654321")]);
    mocks.filings.mockImplementation(async (company) => {
      if (company.ticker === "FAIL") throw new Error("Synthetic SEC error");
      return [filing];
    });
    const saved: string[] = [];
    const work = collectEvents(cfg({ feeds: ["not-registered"] }), { retrievedAt,
      onCollected: async (events) => { saved.push(...events.map((e) => e.id)); } });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.series_id).toBe("GOOD");
    expect(saved).toEqual([result.events[0]!.id]);
    expect(result.failures).toContainEqual({ source: "sec-edgar:#1", detail: "SOURCE_FAILED" });
    expect(JSON.stringify(result.failures)).not.toContain('"FAIL"');
  });

  it("un mapa de tickers fallido no impide capturar empresas con CIK guardado", async () => {
    mocks.watchlist.mockResolvedValue([company("UNKNOWN", null), company("KNOWN", "0000654321")]);
    mocks.resolve.mockRejectedValue(new Error("Synthetic ticker map failure"));
    const work = collectEvents(cfg({ feeds: ["not-registered"] }), { retrievedAt });
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.series_id).toBe("KNOWN");
    expect(mocks.filings).toHaveBeenCalledTimes(1);
    expect(result.failures).toContainEqual({ source: "sec-edgar:#1", detail: "SOURCE_FAILED" });
  });
});
