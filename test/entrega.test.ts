/**
 * La entrega de la alerta, exactamente una vez.
 *
 * El defecto que arregla esto: la alerta se enviaba a Telegram y **después** se
 * registraba en Neon. Si el proceso moría en esos quince segundos de red, la
 * vuelta siguiente volvía a mandar el mismo mensaje. El índice único de `alerts`
 * impide duplicar la fila; no retira un mensaje ya entregado en el teléfono de
 * alguien.
 *
 * El caso que de verdad importa está en el primer bloque, y se prueba corriendo
 * el ciclo **dos veces** contra el mismo estado, matando el primero justo en el
 * punto peor. La regla que se fija es una sola: en la segunda vuelta no sale un
 * segundo mensaje.
 */
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import type { Vigilado } from "../src/db/watchlist.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), dotenv: vi.fn(), watchlist: vi.fn(), quote: vi.fn(),
  filings: vi.fn(), resolve: vi.fn(), feed: vi.fn(), eurostat: vi.fn(),
  score: vi.fn(), analyze: vi.fn(), send: vi.fn(), store: vi.fn(),
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
vi.mock("../src/db/neon.ts", async (original) => ({
  ...await original<typeof import("../src/db/neon.ts")>(), neonSeenStore: mocks.store,
}));

const vigilado: Vigilado = {
  ticker: "ACME", nombre: "Acme Ejemplo", cik: null, quoteSymbol: "ACME",
  vigilarFilings: false, vigilarPrecio: true, umbralMovimiento: 3,
};
const config = (): Config => ({
  anthropicApiKey: "clave-inventada", fredApiKey: null, telegramBotToken: "bot-inventado",
  telegramChatId: "chat-privado", telegramGroupChatId: null,
  databaseUrl: "postgres://nadie@ninguna-parte/db",
  secUserAgent: null, secWatchlist: [], watchlist: [], feeds: [], edgarForms: [],
  maxItemAgeHours: 72, maxScoringPerCycle: 12, maxDeepPerCycle: 3, agendaDias: 7,
  umbralAgrupacion: 0.6, modelScoring: "modelo-barato", modelAnalysis: "modelo-caro",
  deepAnalysisThreshold: 7, alertThreshold: 7, stateDir: ".cache-inventada",
});

/**
 * El estado compartido entre las dos vueltas, con la máquina de estados de
 * verdad: `memorySeenStore` implementa el mismo reclamo que el SQL —solo se
 * reclama lo que no tiene dueño y solo se cierra lo propio—. Las dos funciones
 * que se envuelven son los puntos donde se simula el proceso muerto.
 */
function estadoCompartido() {
  const memoria = memorySeenStore();
  const store = {
    ...memoria,
    mark: vi.fn(memoria.mark),
    saveAlert: vi.fn(memoria.saveAlert),
    finishAlert: vi.fn(memoria.finishAlert),
    claimAlert: vi.fn(memoria.claimAlert),
  };
  mocks.store.mockReturnValue(store);
  return { memoria, store };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Red no autorizada en entrega.test"); }));
  mocks.config.mockReturnValue(config());
  mocks.watchlist.mockResolvedValue([vigilado]);
  mocks.quote.mockResolvedValue({ symbol: "ACME", currency: "USD", price: 110,
    previousClose: 100, sessionDate: new Date().toISOString() });
  mocks.resolve.mockResolvedValue({ companies: [], unknown: [] });
  mocks.filings.mockResolvedValue([]);
  mocks.feed.mockResolvedValue([]);
  mocks.eurostat.mockRejectedValue(new Error("eurostat apagado en este test"));
  mocks.score.mockResolvedValue({ importance_score: 8, market_impact_score: 8,
    sentiment: "bullish", needs_alert: true, one_liner: "Sube con fuerza." });
  mocks.analyze.mockResolvedValue({ why_it_matters: "Importa.", catalysts: [],
    risks: [], affected_assets: [], what_to_watch: [] });
  mocks.send.mockResolvedValue({ ok: true, state: "sent" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Una vuelta entera del ciclo, con `src/main.ts` de verdad. */
async function vuelta(flags: string[] = []) {
  vi.resetModules();
  const salida: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => salida.push(a.map(String).join(" ")));
  const argv = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "main.ts", ...flags]);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  await import("../src/main.ts");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  const codigo = exit.mock.calls[0]?.[0];
  for (const espia of [log, argv, exit]) espia.mockRestore();
  return { codigos: salida.map((l) => String(JSON.parse(l).code)), codigo };
}

describe("el proceso muere y la vuelta siguiente no reenvía", () => {
  it("muere entre el envío y el registro: la segunda vuelta no manda nada", async () => {
    const { memoria, store } = estadoCompartido();
    // El mensaje sale, y el proceso se cae antes de escribir nada de vuelta.
    store.saveAlert.mockRejectedValueOnce(new Error("el proceso se murió aquí"));

    const primera = await vuelta();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(primera.codigos).toContain("ALERT_RECORD_FAILED");
    expect(primera.codigo).toBe(1); // Se ve sin abrir el job.
    // Ni entregada ni descartada: la entrega se queda en vuelo y nadie la libera.
    expect([...memoria.entregas.values()].map((e) => e.estado)).toEqual(["sending"]);
    expect(memoria.alerts).toHaveLength(0);

    const segunda = await vuelta();
    expect(mocks.send).toHaveBeenCalledTimes(1); // ← lo único que importa.
    expect(segunda.codigos).toContain("DEDUPE");
    expect(segunda.codigos).not.toContain("ALERT_SENT");
    expect(mocks.score).toHaveBeenCalledTimes(1); // Ni se vuelve a pagar Haiku.
  });

  it("muere justo después de reclamar, con el evento sin marcar: tampoco reenvía", async () => {
    const { memoria, store } = estadoCompartido();
    // El peor caso: el reclamo ya está puesto y el registro de vistos no sabe
    // nada, así que la deduplicación no protege y el reclamo es lo único que hay.
    store.mark.mockRejectedValueOnce(new Error("el proceso se murió aquí"));

    const primera = await vuelta();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(primera.codigos).toContain("EVENT_FAILED");

    const segunda = await vuelta();
    expect(mocks.score).toHaveBeenCalledTimes(2); // El evento vuelve entero...
    expect(segunda.codigos).toContain("ALERT_BLOCKED"); // ...y choca con el reclamo.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(segunda.codigo).toBe(1);
    // Y en esta segunda vuelta sí se marca, para no repuntuarlo cada media hora.
    expect(await memoria.has(mocks.score.mock.calls[1]![0].id)).toBe(true);
  });

  it("un envío incierto no se reintenta solo, y se dice que es incierto", async () => {
    const { memoria } = estadoCompartido();
    mocks.send.mockRejectedValueOnce(new Error("ETIMEDOUT a mitad del envío"));

    const primera = await vuelta();
    expect(primera.codigos).toContain("ALERT_UNCERTAIN");
    expect(primera.codigos).not.toContain("ALERT_SENT");
    expect(primera.codigo).toBe(1);
    expect([...memoria.entregas.values()].map((e) => e.estado)).toEqual(["uncertain"]);
    // No se registra como enviada: no se sabe si salió, y `alerts` significa
    // exactamente "lo que de verdad salió".
    expect(memoria.alerts).toHaveLength(0);

    await vuelta();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("un rechazo coherente se cierra como tal y no vuelve a intentarse", async () => {
    const { memoria } = estadoCompartido();
    mocks.send.mockResolvedValueOnce({ ok: false, state: "rejected", description: "chat not found" });

    const primera = await vuelta();
    expect(primera.codigos).toContain("ALERT_REJECTED");
    expect([...memoria.entregas.values()].map((e) => e.estado)).toEqual(["rejected"]);

    // Se reintentaba en cada vuelta: el mismo rechazo determinista pagaba una
    // puntuación cada media hora mientras el evento siguiera fresco.
    await vuelta();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.score).toHaveBeenCalledTimes(1);
  });

  it("el camino normal entrega, registra y cierra la entrega en ese orden", async () => {
    const { memoria, store } = estadoCompartido();
    const { codigos, codigo } = await vuelta();
    expect(codigos).toContain("ALERT_SENT");
    expect(codigo).toBe(0);
    expect(memoria.alerts).toHaveLength(1);
    expect([...memoria.entregas.values()].map((e) => e.estado)).toEqual(["sent"]);
    // Reclamar antes de la red; el cierre, después.
    expect(store.claimAlert.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
    expect(store.finishAlert.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.send.mock.invocationCallOrder[0]!);
    // Y el mismo token de punta a punta: solo su dueño cierra la entrega.
    expect(store.finishAlert.mock.calls[0]![1]).toBe(store.claimAlert.mock.calls[0]![1].token);
  });

  it("--force sigue sirviendo para reenviar a mano", async () => {
    const { memoria } = estadoCompartido();
    await vuelta();
    expect(mocks.send).toHaveBeenCalledTimes(1);

    await vuelta(["--force"]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect([...memoria.entregas.values()].map((e) => e.estado)).toEqual(["sent"]);
  });

  it("--dry no reclama, no marca y no envía", async () => {
    const { memoria, store } = estadoCompartido();
    const { codigos } = await vuelta(["--dry"]);
    expect(codigos).toContain("DRY_RUN");
    expect(store.claimAlert).not.toHaveBeenCalled();
    expect(store.mark).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(memoria.entregas.size).toBe(0);
  });
});

/**
 * El mismo espía que el resto del SQL del proyecto: se mira **la consulta que
 * sale de casa**, texto y parámetros, sin una base delante.
 */
function espia(resultados: unknown[][] = []) {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  const ejecutor: Ejecutor = async (partes, ...valores) => {
    consultas.push({ sql: partes.join("?"), valores });
    return resultados.shift() ?? [];
  };
  return { consultas, ejecutor };
}
const URL_FALSA = "postgres://nadie@ninguna-parte/db";
const evento = "yahoo:ACME:2026-09-10";

/** El almacén de verdad: en este archivo `src/db/neon.ts` está doblado. */
const almacen = async (ejecutor: Ejecutor) => {
  const real = await vi.importActual<typeof import("../src/db/neon.ts")>("../src/db/neon.ts");
  return real.neonSeenStore(URL_FALSA, ejecutor);
};

describe("contrato SQL de la entrega, sin ejecutar DB", () => {
  it("reclamar es un insert que compite por la clave, sin caducidad", async () => {
    const { consultas, ejecutor } = espia([[]]);
    const reclamada = await (await almacen(ejecutor)).claimAlert(evento, { token: "tok" });

    expect(reclamada).toBe(false); // Cero filas: la entrega ya tenía dueño.
    const { sql, valores } = consultas[0]!;
    expect(sql).toContain("insert into alert_deliveries");
    expect(sql).toContain("on conflict (event_id) do update set");
    expect(sql).toContain("state = 'sending'");
    expect(sql).toContain("attempts = alert_deliveries.attempts + 1");
    // Nada de liberar por tiempo: es justo lo que produce el doble envío.
    expect(sql).not.toMatch(/interval|claimed_at\s*</i);
    expect(valores).toEqual([evento, "tok", "tok", false]);
  });

  it("solo --force cambia de dueño una entrega que ya lo tiene", async () => {
    const { consultas, ejecutor } = espia([[{ event_id: evento }]]);
    const reclamada = await (await almacen(ejecutor)).claimAlert(evento, { token: "tok", force: true });

    expect(reclamada).toBe(true);
    expect(consultas[0]!.sql).toContain("where ?::boolean");
    expect(consultas[0]!.valores.at(-1)).toBe(true);
    // La entrega que se reclama todavía no ha ocurrido.
    expect(consultas[0]!.sql).toContain("settled_at = null");
  });

  it("cerrar exige ser el dueño y seguir en vuelo", async () => {
    const { consultas, ejecutor } = espia([[{ event_id: evento }]]);
    await (await almacen(ejecutor)).finishAlert(evento, "tok", "uncertain");

    const { sql, valores } = consultas[0]!;
    expect(sql).toContain("update alert_deliveries");
    expect(sql).toContain("claim_token = ? and state = 'sending'");
    expect(valores).toEqual(["uncertain", evento, "tok"]);
  });

  it("perder el reclamo se lanza, no se traga", async () => {
    const { ejecutor } = espia([[]]);
    await expect((await almacen(ejecutor)).finishAlert(evento, "tok", "sent"))
      .rejects.toThrow("alert_claim_lost");
  });

  it("`alerts` solo se escribe cuando Telegram acepta, y sigue significando eso", async () => {
    const { consultas, ejecutor } = espia();
    await (await almacen(ejecutor)).saveAlert(
      { id: evento, source: "yahoo", source_url: null, kind: "market_move", title: "ACME +10 %",
        summary: null, country: null, series_id: "ACME", observed_at: "2026-09-10",
        retrieved_at: "2026-09-10T10:00:00.000Z", actual: 10, previous: null, consensus: null,
        unit: "%", surprises: [], stale: false, official: false },
      { importance: 8, impact: 8, sentiment: "bullish", oneLiner: "Sube.",
        deep: false, body: "cuerpo", analysis: null },
    );
    // Ni una palabra de la entrega: son dos tablas y dos significados.
    for (const { sql } of consultas) expect(sql).not.toContain("alert_deliveries");
  });
});

describe("migración de la entrega", () => {
  const ruta = new URL("../neon/migrations/20260910_entrega_de_alertas.sql", import.meta.url);
  const texto = readFileSync(ruta, "utf8");

  it("es idempotente, declara los cuatro estados y no caduca nada", () => {
    expect(texto).toContain("create table if not exists alert_deliveries");
    expect(texto).toContain("'sending', 'sent', 'rejected', 'uncertain'");
    expect(texto).toContain("claim_token");
    expect(texto).toMatch(/\battempts\b/);
    expect(texto).not.toMatch(/\b(drop|alter)\s+table/i);
    // Sin caducidad no hay reciclado de `sending`, que es el punto entero.
    expect(texto).not.toMatch(/interval/i);
  });

  it("rellena el histórico como entregado y se puede aplicar dos veces", () => {
    expect(texto).toContain("from alerts a");
    expect(texto).toContain("on conflict (event_id) do nothing");
  });

  // El migrador aplica los archivos en orden alfabético: una migración que lee
  // una tabla tiene que ordenarse detrás de la que la crea.
  it("se ordena detrás de la migración que crea `alerts`", () => {
    const dir = new URL("../neon/migrations/", import.meta.url);
    const archivos = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const crea = archivos.findIndex((f) =>
      readFileSync(new URL(f, dir), "utf8").includes("create table if not exists alerts"));
    expect(crea).toBeGreaterThanOrEqual(0);
    expect(archivos.indexOf("20260910_entrega_de_alertas.sql")).toBeGreaterThan(crea);
  });
});

describe("qué se puede afirmar de una respuesta de Telegram", () => {
  it.each([
    ["entregado", 200, { ok: true, result: { message_id: 7 } }, "sent"],
    ["rechazo coherente", 400, { ok: false, error_code: 400 }, "rejected"],
    ["rechazo incoherente", 400, { ok: false, error_code: 500 }, "uncertain"],
    ["timeout del propio Telegram", 408, { ok: false, error_code: 408 }, "uncertain"],
    ["proxy caído", 502, { ok: false, error_code: 502 }, "uncertain"],
    ["200 sin message_id", 200, { ok: true }, "uncertain"],
    ["cuerpo ilegible", 200, null, "uncertain"],
  ])("%s → %s", async (_caso, status, cuerpo, esperado) => {
    const real = await vi.importActual<typeof import("../src/notify/telegram.ts")>(
      "../src/notify/telegram.ts");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: status >= 200 && status < 300, status,
      json: async () => { if (cuerpo === null) throw new Error("no es JSON"); return cuerpo; },
    })));
    const salida = await real.sendTelegram("bot", "chat", "texto");
    expect(salida.state).toBe(esperado);
    expect(salida.ok).toBe(esperado === "sent");
  });
});
