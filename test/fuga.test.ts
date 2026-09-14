import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import type { Vigilado } from "../src/db/watchlist.ts";
import type { CascadeDeps } from "../src/ai/cascade.ts";
import type { LogCode, LogFields } from "../src/lib/log.ts";
import { memoryQueueStore } from "../src/pipeline/queue.ts";
import { memoryControlStore } from "../src/pipeline/control.ts";

// Solo datos inventados. Se ejecutan main, collect, normalizadores y logger reales.
// Los dobles se limitan a las fronteras de servicios: no red, LLM ni escrituras.
const mocks = vi.hoisted(() => ({
  config: vi.fn(), dotenv: vi.fn(), watchlist: vi.fn(), quote: vi.fn(),
  filings: vi.fn(), resolve: vi.fn(), feed: vi.fn(), fred: vi.fn(), eurostat: vi.fn(),
  score: vi.fn(), analyze: vi.fn(), send: vi.fn(), state: vi.fn(), queue: vi.fn(),
  control: vi.fn(),
  seen: { has: vi.fn(), mark: vi.fn(), saveAlert: vi.fn(), claimAlert: vi.fn(), finishAlert: vi.fn() },
}));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(),
  loadConfig: mocks.config, loadDotEnv: mocks.dotenv,
}));
vi.mock("../src/db/watchlist.ts", async (original) => ({
  ...await original<typeof import("../src/db/watchlist.ts")>(), leerWatchlist: mocks.watchlist,
}));
vi.mock("../src/sources/mercado.ts", async (original) => ({
  ...await original<typeof import("../src/sources/mercado.ts")>(), fetchCotizacion: mocks.quote,
}));
vi.mock("../src/sources/sec-edgar.ts", async (original) => ({
  ...await original<typeof import("../src/sources/sec-edgar.ts")>(),
  fetchFilings: mocks.filings, resolveTickers: mocks.resolve,
}));
vi.mock("../src/sources/rss.ts", async (original) => ({
  ...await original<typeof import("../src/sources/rss.ts")>(), fetchFeed: mocks.feed,
}));
vi.mock("../src/sources/fred.ts", async (original) => ({
  ...await original<typeof import("../src/sources/fred.ts")>(), fetchObservations: mocks.fred,
}));
// Eurostat es publica y no lleva clave, asi que no hay variable que la apague:
// su frontera de red se dobla aqui como la de las demas. Por defecto rechaza,
// que es lo que hace la red en este archivo, y asi el ciclo corre con las mismas
// fuentes que antes mas cuatro caidas.
vi.mock("../src/sources/eurostat.ts", async (original) => ({
  ...await original<typeof import("../src/sources/eurostat.ts")>(), fetchSerie: mocks.eurostat,
}));
vi.mock("../src/ai/cascade.ts", async (original) => ({
  ...await original<typeof import("../src/ai/cascade.ts")>(),
  scoreEvent: mocks.score, analyzeEvent: mocks.analyze,
}));
vi.mock("../src/notify/telegram.ts", async (original) => ({
  ...await original<typeof import("../src/notify/telegram.ts")>(), sendTelegram: mocks.send,
}));
vi.mock("../src/db/neon.ts", () => ({ neonSeenStore: mocks.state }));
vi.mock("../src/db/queue.ts", () => ({ neonQueueStore: mocks.queue }));
vi.mock("../src/db/control.ts", () => ({ neonControlStore: mocks.control }));
vi.mock("../src/pipeline/queue.ts", async (original) => ({
  ...await original<typeof import("../src/pipeline/queue.ts")>(), fileQueueStore: mocks.queue,
}));
vi.mock("../src/pipeline/seen.ts", async (original) => ({
  ...await original<typeof import("../src/pipeline/seen.ts")>(), fileSeenStore: mocks.state,
}));

const PRIVATE = "^INDX A.C GLOBX.DE North Example Holdings 0000123456";
const URL = "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/doc.htm";
const SECRET = "clave-sintetica-no-publicable";
const payload = `${PRIVATE} ${URL} ${SECRET}`;
const vigilado = (ticker = "A.C"): Vigilado => ({
  ticker, nombre: "North Example Holdings", cik: "0000123456", quoteSymbol: "^INDX",
  vigilarFilings: false, vigilarPrecio: true, vigilarNoticias: true, umbralMovimiento: 3,
});
const config = (): Config => ({
  anthropicApiKey: SECRET, fredApiKey: null, telegramBotToken: SECRET,
  telegramChatId: SECRET, telegramGroupChatId: SECRET,
  databaseUrl: `postgres://user:${SECRET}@invalid.test/db`,
  secUserAgent: SECRET, secWatchlist: [], watchlist: [], feeds: [payload], edgarForms: [],
  maxItemAgeHours: 72, maxScoringPerCycle: 12, maxDeepPerCycle: 3, agendaDias: 7,
  umbralAgrupacion: 0.6, modelScoring: SECRET, modelAnalysis: SECRET,
  deepAnalysisThreshold: 7, alertThreshold: 7, stateDir: payload,
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Red no autorizada en fuga.test"); }));
  mocks.config.mockReturnValue(config());
  mocks.watchlist.mockResolvedValue([vigilado()]);
  mocks.quote.mockResolvedValue({ symbol: "^INDX", currency: "USD", price: 110,
    previousClose: 100, sessionDate: new Date().toISOString() });
  mocks.resolve.mockResolvedValue({ companies: [], unknown: [PRIVATE] });
  mocks.filings.mockResolvedValue([]);
  mocks.feed.mockResolvedValue([]);
  mocks.eurostat.mockRejectedValue(Object.assign(new Error(payload), { query: payload }));
  mocks.state.mockReturnValue(mocks.seen);
  mocks.queue.mockReturnValue(memoryQueueStore());
  mocks.control.mockReturnValue(memoryControlStore());
  mocks.seen.has.mockResolvedValue(false);
  mocks.score.mockResolvedValue({ importance_score: 8, market_impact_score: 8,
    sentiment: "bullish", needs_alert: true, one_liner: `Prosa scoring ${payload}` });
  mocks.analyze.mockResolvedValue({ why_it_matters: `Prosa profunda ${payload}`,
    catalysts: [payload], risks: [payload], affected_assets: [], what_to_watch: [payload] });
  mocks.seen.claimAlert.mockResolvedValue(true);
  mocks.send.mockResolvedValue({ ok: true, state: "sent" });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sinFugas(lines: string[]) {
  const text = lines.join("\n");
  for (const value of ["^INDX", "A.C", "GLOBX.DE", "North Example Holdings", "0000123456",
    "123456", "sec.gov", SECRET, "Prosa scoring", "Prosa profunda", "MARKET ALERT"]) {
    expect(text).not.toContain(value);
  }
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
}

async function ejecutarMain(dry = true) {
  const salida: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => salida.push(args.map(String).join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...args) => salida.push(args.map(String).join(" ")));
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "main.ts", ...(dry ? ["--dry"] : [])]);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  await import("../src/main.ts");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  expect(error).not.toHaveBeenCalled();
  sinFugas(salida);
  return { records: salida.map((line) => JSON.parse(line)), exit };
}

describe("perfil del punto de entrada real", () => {
  it("desconocido falla antes de estado, fuentes, modelos y Telegram", async () => {
    vi.stubEnv("MONITOR_PROFILE", "unknown-private-profile");
    const result = await ejecutarMain(false);
    expect(result.exit).toHaveBeenCalledWith(1);
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled(); expect(mocks.feed).not.toHaveBeenCalled();
    expect(mocks.score).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(JSON.stringify(result.records)).not.toContain("unknown-private-profile");
  });
  it("fast capture-only real no modelos ni Telegram y conserva cola", async () => {
    vi.stubEnv("MONITOR_PROFILE", "fast"); vi.stubEnv("MONITOR_MODE", "capture-only");
    const result = await ejecutarMain(false);
    expect(result.records).toContainEqual(expect.objectContaining({ code: "CYCLE_START", profile: "fast" }));
    expect(mocks.eurostat).not.toHaveBeenCalled(); expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.score).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe.each(["true", ""])("logger real, GITHUB_ACTIONS=%s", (actions) => {
  it("solo publica vocabulario permitido, sin depender de la watchlist", async () => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    const { createLogger } = await import("../src/lib/log.ts");
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    for (const value of [payload, `(^INDX), /%5EINDX?token=${SECRET}`, new Error(payload),
      { ticker: "^INDX", empresa: "North Example Holdings", nested: { url: URL, key: SECRET } }]) {
      // Simula un llamante JS o un cast: no basta con que el tipo sea cerrado.
      log(value as LogCode, { source: payload, stage: payload, title: payload,
        body: payload, count: SECRET } as unknown as LogFields);
    }
    log("SOURCE_OK", { source: "yahoo", stage: "collect", index: 1, count: 2 });
    sinFugas(lines);
    expect(lines.slice(0, 4).map((line) => JSON.parse(line))).toEqual(Array(4).fill({ code: "LOG_SUPPRESSED" }));
    expect(JSON.parse(lines[4]!)).toEqual({ code: "SOURCE_OK", source: "yahoo",
      stage: "collect", index: 1, count: 2 });
  });

  it("descarta Error, objetos anidados, ciclos y hooks sin ejecutarlos", async () => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    const { createLogger } = await import("../src/lib/log.ts");
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    const hook = vi.fn(() => { throw new Error(payload); });
    const nested: Record<string, unknown> = { url: URL, secret: SECRET, toJSON: hook, toString: hook };
    nested.self = nested;
    Object.defineProperty(nested, "status", { get: hook });
    const error = Object.assign(new Error(payload, { cause: nested }), { body: payload, code: payload });
    log("SOURCE_FAILED", { stage: "collect", error });
    log("UNHANDLED", { stage: "startup", error: nested });
    log("UNHANDLED", nested as LogFields);
    sinFugas(lines);
    expect(hook).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0]!)).toEqual({ code: "SOURCE_FAILED", stage: "collect", error: "UNKNOWN" });
  });

  it("conserva HTTP y códigos SQL/red permitidos; ignora mensajes y códigos arbitrarios", async () => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    const { createLogger } = await import("../src/lib/log.ts");
    const { HttpError } = await import("../src/lib/http.ts");
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log("SOURCE_FAILED", { error: new HttpError(payload, 503, payload), source: "fred", stage: "collect" });
    log("WATCHLIST_FAILED", { error: Object.assign(new Error(payload), { code: "42P01" }) });
    log("SOURCE_FAILED", { error: { code: "ETIMEDOUT", message: payload } });
    log("SOURCE_FAILED", { error: { status: SECRET, code: SECRET, body: payload } });
    // El código de proveedor solo sale si está en la lista cerrada, aunque llegue en un objeto ajeno.
    log("LLM_PROVIDER_FAILED", { provider: "groq", error: { status: 400, providerCode: "context_length_exceeded", message: payload } });
    log("LLM_PROVIDER_FAILED", { provider: "groq", error: { status: 400, providerCode: SECRET } });
    sinFugas(lines);
    expect(JSON.parse(lines[0]!)).toEqual({ code: "SOURCE_FAILED", source: "fred", stage: "collect", error: "HTTP", status: 503 });
    expect(JSON.parse(lines[1]!).error).toBe("42P01");
    expect(JSON.parse(lines[2]!).error).toBe("ETIMEDOUT");
    expect(JSON.parse(lines[3]!).error).toBe("UNKNOWN");
    expect(JSON.parse(lines[4]!)).toEqual({ code: "LLM_PROVIDER_FAILED", provider: "groq", error: "HTTP", status: 400, providerCode: "context_length_exceeded" });
    expect(JSON.parse(lines[5]!)).toEqual({ code: "LLM_PROVIDER_FAILED", provider: "groq", error: "HTTP", status: 400 });
  });

  it("solo acepta nombres de configuración del enum y conteos enteros", async () => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    const { createLogger } = await import("../src/lib/log.ts");
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log("CONFIG_MISSING", { variable: "DATABASE_URL", count: 1 });
    log("CONFIG_MISSING", { variable: payload, count: NaN, total: Infinity,
      failed: -1, index: 1.2, body: payload } as unknown as LogFields);
    sinFugas(lines);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { code: "CONFIG_MISSING", variable: "DATABASE_URL", count: 1 },
      { code: "CONFIG_MISSING" },
    ]);
  });
});

describe("bordes reales de collect", () => {
  it("protege el fallo SQL antes de conocer la lista y usa el respaldo", async () => {
    const { watchlistEfectiva } = await import("../src/pipeline/collect.ts");
    mocks.watchlist.mockRejectedValue(Object.assign(new Error(payload), { code: "28P01", query: payload }));
    const lines: string[] = [];
    const cfg = { ...config(), watchlist: ["^INDX"] };
    const result = await watchlistEfectiva(cfg, (line) => lines.push(line));
    expect(result[0]?.ticker).toBe("^INDX");
    sinFugas(lines);
    expect(JSON.parse(lines[0]!)).toEqual({ code: "WATCHLIST_FAILED", source: "neon", stage: "watchlist", error: "28P01" });
  });

  it("protege errores Yahoo y EDGAR y conserva una fuente sana", async () => {
    const { collectEvents } = await import("../src/pipeline/collect.ts");
    const { HttpError } = await import("../src/lib/http.ts");
    mocks.watchlist.mockResolvedValue([{ ...vigilado(), vigilarFilings: true }, vigilado("A.C")]);
    mocks.filings.mockRejectedValue(new HttpError(payload, 403, payload));
    mocks.quote.mockRejectedValueOnce({ response: payload, ticker: "^INDX", cause: new Error(payload) });
    const lines: string[] = [];
    const result = await collectEvents(config(), { retrievedAt: new Date().toISOString(), log: (line) => lines.push(line) });
    sinFugas(lines);
    // Las cuatro caidas de Eurostat se suman a las dos de siempre y ninguna se
    // lleva por delante la fuente sana. Los ordinales son los de la lista de
    // tareas: Eurostat ocupa del 1 al 4 porque va antes de los feeds.
    expect(result.ok).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.failures).toHaveLength(6);
    expect(JSON.stringify(result.failures)).not.toContain(SECRET);
    expect(lines.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      { code: "SOURCE_FAILED", source: "eurostat", stage: "collect", index: 1, error: "UNKNOWN" },
      { code: "SOURCE_FAILED", source: "sec-edgar", stage: "collect", index: 5, error: "HTTP", status: 403 },
      { code: "SOURCE_FAILED", source: "yahoo", stage: "collect", index: 6, error: "UNKNOWN" },
      { code: "SOURCE_OK", source: "yahoo", stage: "collect", index: 7, count: 1 },
    ]));
  });

  /**
   * El fallo de Eurostat que este proyecto teme no es una caida: es un 200 con
   * cero filas. Sale en el log con su codigo y sin una sola palabra del mensaje,
   * que es lo que permite distinguir "no responde" de "responde y no trae nada"
   * sin abrir un boquete en el vocabulario cerrado del logger.
   */
  it("dice en el log que Eurostat respondió vacío, y solo eso", async () => {
    const { collectEvents } = await import("../src/pipeline/collect.ts");
    const { EurostatError } = await import("../src/sources/eurostat.ts");
    mocks.watchlist.mockResolvedValue([]);
    mocks.eurostat.mockRejectedValue(new EurostatError("EUROSTAT_EMPTY", payload));
    const lines: string[] = [];
    await collectEvents(config(), { retrievedAt: new Date().toISOString(), log: (line) => lines.push(line) });
    sinFugas(lines);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      { code: "SOURCE_FAILED", source: "eurostat", stage: "collect", index: 1, error: "EUROSTAT_EMPTY" },
    );
  });

  it("solo cuenta los símbolos SEC desconocidos", async () => {
    const { collectEvents } = await import("../src/pipeline/collect.ts");
    mocks.watchlist.mockResolvedValue([{ ...vigilado(), cik: null, vigilarFilings: true, vigilarPrecio: false }]);
    const lines: string[] = [];
    await collectEvents(config(), { retrievedAt: new Date().toISOString(), log: (line) => lines.push(line) });
    sinFugas(lines);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ code: "SEC_UNKNOWN", source: "sec-edgar", stage: "collect", count: 1 });
  });
});

describe("consola del main real", () => {
  it("dos niveles: main persiste decisión y envía breve; grupo después del acuse", async () => {
    mocks.config.mockReturnValue({ ...config(), newsDeliveryMode: "two-level", feeds: ["cnbc-markets"] });
    mocks.watchlist.mockResolvedValue([]);
    mocks.feed.mockResolvedValue([{ title: "Copper production falls during maintenance", link: "https://example.test/copper", guid: "copper", date: new Date().toISOString(), summary: null, raw: "<item/>" }]);
    mocks.score.mockResolvedValue({ importance_score: 5, market_impact_score: 5, sentiment: "neutral", needs_alert: false, one_liner: "La producción de cobre cae durante el mantenimiento." });
    const { exit } = await ejecutarMain(false);
    expect(exit).toHaveBeenCalledWith(0); expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.seen.finishAlert.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[1]!);
    const event = mocks.score.mock.calls[0]![0];
    expect(await mocks.control.mock.results[0]!.value.getDecision(event.id)).toMatchObject({ level: "brief" });
  });
  it("cupo de IA agotado: el ciclo no falla, conserva la noticia y avisa una vez por el privado", async () => {
    mocks.config.mockReturnValue({ ...config(), newsDeliveryMode: "two-level", feeds: ["cnbc-markets"] });
    mocks.watchlist.mockResolvedValue([]);
    mocks.feed.mockResolvedValue([{ title: "Copper production falls during maintenance", link: "https://example.test/copper", guid: "copper", date: new Date().toISOString(), summary: null, raw: "<item/>" }]);
    mocks.score.mockRejectedValue(Object.assign(new Error("ai_budget_exhausted"), { code: "AI_BUDGET_EXHAUSTED" }));
    const { BUDGET_NOTICE_TEXT } = await import("../src/pipeline/cadence.ts");
    const { records, exit } = await ejecutarMain(false);
    // Código 0: el workflow no entra en «Avisar del fallo», que avisaba en cada ciclo.
    expect(exit).toHaveBeenCalledWith(0);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![1]).toBe(SECRET); // chat privado, nunca el grupo
    expect(mocks.send.mock.calls[0]![2]).toBe(BUDGET_NOTICE_TEXT);
    expect(mocks.seen.claimAlert).toHaveBeenCalledWith(expect.stringMatching(/^operational-budget:\d{4}-\d{2}-\d{2}$/), expect.anything());
    expect(records).toContainEqual({ code: "AI_BUDGET_NOTICE", stage: "telegram", sent: 1 });
    expect(records).toContainEqual(expect.objectContaining({ code: "EVENT_FAILED", stage: "scoring", error: "AI_BUDGET_EXHAUSTED" }));
    expect(records).toContainEqual(expect.objectContaining({ code: "CYCLE_END", failed: 0 }));
    const queue = mocks.queue.mock.results[0]!.value;
    expect((await queue.stats()).reduce((n: number, row: { retryable_failed: number }) => n + row.retryable_failed, 0)).toBe(1);
  });
  it.each(["true", ""])("no imprime título, alerta ni prosa en --dry (Actions=%s)", async (actions) => {
    vi.stubEnv("GITHUB_ACTIONS", actions);
    const { records, exit } = await ejecutarMain();
    expect(mocks.score).toHaveBeenCalledTimes(1);
    expect(mocks.score.mock.calls[0]?.[0].title).toContain("A.C");
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
    expect(records).toContainEqual({ code: "ALERT_READY", source: "yahoo", stage: "format" });
    expect(records).toContainEqual({ code: "DRY_RUN", stage: "format" });
    expect(exit).toHaveBeenCalledWith(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.seen.saveAlert).not.toHaveBeenCalled();
    expect(mocks.seen.mark).not.toHaveBeenCalled();
  });

  it("no imprime un documento SEC con ^, nombre con espacios y CIK en URL", async () => {
    mocks.watchlist.mockResolvedValue([{ ...vigilado("^INDX"), vigilarFilings: true, vigilarPrecio: false }]);
    mocks.filings.mockResolvedValue([{ accession: "000012345626000001", formType: "8-K",
      formName: payload, filedAt: new Date().toISOString(), url: URL, items: payload }]);
    const { records, exit } = await ejecutarMain();
    expect(mocks.score.mock.calls[0]?.[0]).toMatchObject({ source_url: URL, title: expect.stringContaining("^INDX"),
      summary: expect.stringContaining("North Example Holdings") });
    expect(records).toContainEqual({ code: "ALERT_READY", source: "sec-edgar", stage: "format" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("indica todas las variables faltantes, nunca sus valores", async () => {
    mocks.config.mockReturnValue({ ...config(), anthropicApiKey: null, fredApiKey: null,
      telegramBotToken: null, telegramChatId: null, databaseUrl: null, secUserAgent: null });
    const { records } = await ejecutarMain();
    expect(records.filter((r) => r.code === "CONFIG_MISSING")).toEqual(
      ["FRED_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DATABASE_URL", "SEC_USER_AGENT"]
        .map((variable) => ({ code: "CONFIG_MISSING", stage: "startup", variable })),
    );
  });

  it("tapa violaciones y FabricationError sin perder el diagnóstico de degradación", async () => {
    const { FabricationError } = await import("../src/ai/cascade.ts");
    mocks.analyze.mockImplementation(async (_event, deps: CascadeDeps) => {
      deps.onFabrication?.(1, [payload]);
      throw new FabricationError(payload, [payload]);
    });
    const { records, exit } = await ejecutarMain();
    expect(records).toContainEqual({ code: "FABRICATION_RETRY", stage: "analysis", count: 1, attempt: 1 });
    expect(records).toContainEqual({ code: "ANALYSIS_FALLBACK", source: "yahoo", stage: "analysis" });
    expect(records).toContainEqual({ code: "ALERT_READY", source: "yahoo", stage: "format" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([new Error(payload), { message: payload, nested: { token: SECRET } }])(
    "protege errores por evento y termina con código de fallo", async (error) => {
      mocks.score.mockRejectedValue(error);
      const { records, exit } = await ejecutarMain();
      expect(records).toContainEqual({ code: "EVENT_FAILED", source: "yahoo", stage: "scoring", error: "UNKNOWN" });
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("protege el catch final antes de cargar configuración", async () => {
    mocks.dotenv.mockImplementation(() => { throw new Error(payload); });
    const { records, exit } = await ejecutarMain();
    expect(records).toEqual([{ code: "UNHANDLED", stage: "startup", error: "UNKNOWN" }]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.watchlist).not.toHaveBeenCalled();
  });

  it("protege el catch final en dedupe ante errores de objetos SQL", async () => {
    mocks.seen.has.mockRejectedValue({ code: "42P01", query: payload, detail: payload });
    const { records, exit } = await ejecutarMain();
    expect(records).toContainEqual({ code: "UNHANDLED", stage: "dedupe", error: "42P01" });
    expect(exit).toHaveBeenCalledWith(1);
  });

  // La descripción de un rechazo la escribe Telegram y puede llevar dentro el
  // texto del mensaje. El código del log dice qué pasó; la descripción no sale.
  it("protege la descripción de rechazo de Telegram (doble sin red)", async () => {
    mocks.send.mockResolvedValue({ ok: false, state: "rejected", description: payload });
    const { records, exit } = await ejecutarMain(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[2]).toContain("Prosa profunda");
    expect(records).toContainEqual({ code: "ALERT_REJECTED", source: "yahoo", stage: "persist" });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.seen.saveAlert).not.toHaveBeenCalled();
    // El rechazo queda cerrado en la entrega: ni se reenvía ni se pierde.
    expect(mocks.seen.finishAlert.mock.calls[0]?.[2]).toBe("rejected");
  });
});

describe("copia al grupo compartido", () => {
  // Este es el caso que revela la cartera: un movimiento de precio solo existe
  // porque ese valor esta vigilado. Va al grupo por decision explicita de
  // Alberto, y el test lo fija para que dejar de hacerlo tenga que ser un
  // cambio deliberado y no un efecto colateral.
  it("un movimiento de precio de la watchlist tambien se copia al grupo", async () => {
    mocks.send.mockResolvedValue({ ok: true, state: "sent" });
    const { records, exit } = await ejecutarMain(false);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const [privado, grupo] = mocks.send.mock.calls;
    expect(privado?.[1]).toBe(SECRET); // TELEGRAM_CHAT_ID
    expect(grupo?.[1]).toBe(SECRET);   // TELEGRAM_GROUP_CHAT_ID
    expect(grupo?.[2]).toBe(privado?.[2]);
    expect(records).toContainEqual({ code: "GROUP_SENT", source: "yahoo", stage: "telegram" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("un titular macro de prensa sí se copia, con el mismo cuerpo", async () => {
    mocks.config.mockReturnValue({ ...config(), feeds: ["cnbc-markets"],
      telegramChatId: "chat-privado", telegramGroupChatId: "-100grupo" });
    mocks.watchlist.mockResolvedValue([{ ...vigilado(), vigilarPrecio: false, vigilarNoticias: true, vigilarFilings: false }]);
    mocks.feed.mockResolvedValue([{ title: "El BCE eleva los tipos de interés",
      link: "https://example.org/nota", guid: "nota-1", date: new Date().toISOString(),
      summary: null, raw: "<item/>" }]);
    mocks.send.mockResolvedValue({ ok: true, state: "sent" });

    const { records, exit } = await ejecutarMain(false);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    const [privado, grupo] = mocks.send.mock.calls;
    expect(privado?.[1]).toBe("chat-privado");
    expect(grupo?.[1]).toBe("-100grupo");
    expect(grupo?.[2]).toBe(privado?.[2]); // El mismo cuerpo, sin recortar.
    expect(records).toContainEqual({ code: "GROUP_SENT", source: "rss", stage: "telegram" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("un rechazo del grupo se registra y no toca el resultado de la alerta privada", async () => {
    mocks.config.mockReturnValue({ ...config(), feeds: ["cnbc-markets"],
      telegramChatId: "chat-privado", telegramGroupChatId: "-100grupo" });
    mocks.watchlist.mockResolvedValue([{ ...vigilado(), vigilarPrecio: false, vigilarNoticias: true, vigilarFilings: false }]);
    mocks.feed.mockResolvedValue([{ title: "El BCE eleva los tipos de interés",
      link: "https://example.org/nota", guid: "nota-1", date: new Date().toISOString(),
      summary: null, raw: "<item/>" }]);
    mocks.send.mockResolvedValueOnce({ ok: true, state: "sent" })
      .mockRejectedValueOnce(Object.assign(new Error(payload), { code: "ECONNRESET" }));

    const { records, exit } = await ejecutarMain(false);
    expect(records).toContainEqual({ code: "ALERT_SENT", source: "rss", stage: "persist" });
    expect(records).toContainEqual({ code: "GROUP_FAILED", source: "rss", stage: "telegram", error: "ECONNRESET" });
    expect(mocks.seen.saveAlert).toHaveBeenCalledTimes(1); // La alerta privada queda registrada.
    expect(exit).toHaveBeenCalledWith(0);
  });
});
