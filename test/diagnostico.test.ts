import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLogger, type LogFields } from "../src/lib/log.ts";
import { registrarEmbudoFeeds } from "../src/pipeline/diagnostico.ts";
import { FEEDS, fetchFeed } from "../src/sources/rss.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const noticia = (id: string, feed = "cnbc-markets", title = "Central bank cuts interest rates"): NormalizedEvent => ({
  id, source: "rss", series_id: feed, title, summary: null, source_url: "https://example.test/",
  kind: "news", country: null, official: false, stale: false,
  observed_at: "2026-09-10T08:00:00Z", retrieved_at: "2026-09-10T09:00:00Z",
  actual: null, previous: null, consensus: null, unit: null, surprises: [],
});
afterEach(() => vi.unstubAllGlobals());

describe("diagnóstico del embudo por feed", () => {
  it("clasifica el fallo de formato del SDK sin imprimir su respuesta ni ejecutar getters", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log("EVENT_FAILED", { stage: "scoring", source: "rss", feed: "cnbc-markets",
      error: new Error("Failed to parse structured output: información-privada") });
    const getter = vi.fn(() => "información-privada");
    const err = Object.defineProperty({}, "message", { get: getter });
    log("EVENT_FAILED", { error: err });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { code: "EVENT_FAILED", source: "rss", stage: "scoring", feed: "cnbc-markets", error: "MODEL_OUTPUT_INVALID" },
      { code: "EVENT_FAILED", error: "UNKNOWN" },
    ]);
    expect(getter).not.toHaveBeenCalled();
  });
  it("el fallo de red envuelto por fetch deja de leerse como UNKNOWN", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    // undici no propaga el código: envuelve el fallo en TypeError("fetch failed")
    // y deja ECONNRESET/ENOTFOUND en `cause`. Sin recorrer la cadena, "no hay
    // DNS" y "el modelo devolvió basura" se leían igual en el log.
    log("SOURCE_FAILED", { stage: "collect", source: "rss", feed: "ecb-press",
      error: new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }) });
    log("SOURCE_FAILED", { stage: "collect", source: "sec-edgar",
      error: new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { status: 503 }) }) });
    log("SOURCE_FAILED", { stage: "collect", source: "rss", error: new DOMException("HTTP timeout", "TimeoutError") });
    log("UNHANDLED", { stage: "startup", error: new Error("invalid_monitor_profile") });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { code: "SOURCE_FAILED", source: "rss", stage: "collect", feed: "ecb-press", error: "ENOTFOUND" },
      { code: "SOURCE_FAILED", source: "sec-edgar", stage: "collect", error: "HTTP", status: 503 },
      { code: "SOURCE_FAILED", source: "rss", stage: "collect", error: "REQUEST_TIMEOUT" },
      { code: "UNHANDLED", stage: "startup", error: "INVALID_MONITOR_PROFILE" },
    ]);
  });

  it("los códigos nuevos no publican cuerpos, URLs con credenciales ni getters", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    const getter = vi.fn(() => "postgres://user:clave@host/db");
    const envuelto = new Error("boom");
    Object.defineProperty(envuelto, "cause", { get: getter, enumerable: true, configurable: true });
    log("UNHANDLED", { error: envuelto });
    // Un mensaje libre no entra aunque contenga algo que parezca un código.
    log("UNHANDLED", { error: new Error("connect ECONNREFUSED 10.0.0.1:5432 postgres://user:clave@host") });
    log("UNHANDLED", { error: new Error("boom", { cause: new Error("https://api.telegram.org/bot123:SECRETO/sendMessage") }) });
    // Cadena cíclica: se acota, no cuelga el logger.
    const ciclo: { cause?: unknown } = {};
    ciclo.cause = ciclo;
    log("UNHANDLED", { error: ciclo });
    expect(getter).not.toHaveBeenCalled();
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { code: "UNHANDLED", error: "UNKNOWN" }, { code: "UNHANDLED", error: "UNKNOWN" },
      { code: "UNHANDLED", error: "UNKNOWN" }, { code: "UNHANDLED", error: "UNKNOWN" },
    ]);
    expect(lines.join("\n")).not.toContain("clave");
    expect(lines.join("\n")).not.toContain("SECRETO");
    expect(lines.join("\n")).not.toContain("10.0.0.1");
  });

  it("un snapshot con forma inválida y un cuerpo ilegible se distinguen entre sí", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    const zod = z.object({ id: z.string() }).safeParse({});
    log("EVENT_FAILED", { stage: "persist", error: zod.error });
    let sintaxis: unknown;
    try { JSON.parse("<html>Access denied</html>"); } catch (error) { sintaxis = error; }
    log("EVENT_FAILED", { stage: "collect", error: sintaxis });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { code: "EVENT_FAILED", stage: "persist", error: "SCHEMA_INVALID" },
      { code: "EVENT_FAILED", stage: "collect", error: "PAYLOAD_INVALID_JSON" },
    ]);
    expect(lines.join("\n")).not.toContain("Access denied");
  });

  it("separa antigüedad, rechazo de reglas y deduplicación sin publicar titulares", () => {
    const vieja = noticia("vieja");
    const rechazada = noticia("rechazada", "cnbc-markets", "My favourite holiday photos");
    const vista = noticia("vista");
    const nueva = noticia("nueva");
    const lines: string[] = [];
    registrarEmbudoFeeds({ events: [vieja, rechazada, vista, nueva], fresh: [rechazada, vista, nueva],
      candidates: [vista, nueva], nuevos: [nueva], watchlist: [] }, createLogger((l) => lines.push(l)));
    const records = lines.map((l) => JSON.parse(l));
    expect(records.find((r) => r.code === "FEED_FUNNEL")).toEqual({ code: "FEED_FUNNEL",
      source: "rss", stage: "dedupe", feed: "cnbc-markets", total: 4, fresh: 3,
      passed: 2, new: 1, seen: 1, discarded: 1 });
    expect(records).toContainEqual({ code: "RULE_REASON", source: "rss", stage: "rules",
      feed: "cnbc-markets", reason: "no_match", count: 1 });
    expect(lines.join("\n")).not.toContain("Central bank");
    expect(lines.join("\n")).not.toContain("holiday");
  });

  it("un feed solo antiguo tiene cero recientes y no se confunde con fallo de red", () => {
    const lines: string[] = [];
    registrarEmbudoFeeds({ events: [noticia("old", "fed-press")], fresh: [], candidates: [], nuevos: [], watchlist: [] },
      createLogger((l) => lines.push(l)));
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ code: "FEED_FUNNEL", source: "rss", stage: "dedupe",
      feed: "fed-press", total: 1, fresh: 0, passed: 0, new: 0, seen: 0, discarded: 0 }]);
  });

  it("los nuevos campos del logger validan vocabulario, límites y getters", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    const getter = vi.fn(() => "dato-privado");
    const fields = { feed: "cartera-privada", reason: "ticker-personal", importance: NaN, impact: 11,
      fresh: -1, new: 1.5 } as unknown as LogFields;
    Object.defineProperty(fields, "seen", { get: getter });
    log("SCORED", fields);
    log("SCORED", { feed: "cnbc-markets", importance: 6.5, impact: 3 });
    expect(getter).not.toHaveBeenCalled();
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ code: "SCORED" },
      { code: "SCORED", feed: "cnbc-markets", importance: 6.5, impact: 3 }]);
  });
});

describe("respuesta HTTP de un feed", () => {
  it("HTTP 200 con HTML no cuenta como fuente sana con cero noticias", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Access denied</html>")));
    await expect(fetchFeed(FEEDS["cnbc-markets"]!, { attempts: 1 }))
      .rejects.toMatchObject({ code: "FEED_INVALID" });
  });
  it("un RSS válido vacío se puede distinguir de HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<rss version="2.0"><channel></channel></rss>')));
    await expect(fetchFeed(FEEDS["fed-press"]!, { attempts: 1 })).resolves.toEqual([]);
  });
});
