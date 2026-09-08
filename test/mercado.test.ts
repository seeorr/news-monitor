import { describe, expect, it } from "vitest";
import fixture from "./fixtures/yahoo-nvda.json" with { type: "json" };
import { parseCotizacion, toEvent, variacion } from "../src/sources/mercado.ts";
import { NormalizedEvent } from "../src/schema/event.ts";

const retrievedAt = "2026-09-08T19:00:00.000Z";
const cotizacion = parseCotizacion(fixture, "NVDA");

describe("cotización", () => {
  it("lee la respuesta real de Yahoo", () => {
    expect(cotizacion.symbol).toBe("NVDA");
    expect(cotizacion.currency).toBe("USD");
    expect(cotizacion.price).toBeGreaterThan(0);
    expect(cotizacion.previousClose).toBeGreaterThan(0);
    expect(cotizacion.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // La serie de Yahoo trae huecos en los festivos. Coger el penúltimo elemento a
  // ciegas compara el lunes contra un día que no existió.
  it("salta los cierres nulos en vez de tomarlos por datos", () => {
    const conHueco = {
      chart: {
        result: [
          {
            meta: { symbol: "X", currency: "EUR", regularMarketPrice: 110 },
            timestamp: [1_788_000_000, 1_788_086_400, 1_788_172_800],
            indicators: { quote: [{ close: [100, null, 110] }] },
          },
        ],
      },
    };
    const c = parseCotizacion(conHueco, "X");
    expect(c.previousClose).toBe(100);
    expect(variacion(c)).toBe(10);
  });

  it("se niega a comparar cuando no hay cierre anterior", () => {
    const sinPrevio = {
      chart: {
        result: [
          {
            meta: { symbol: "X" },
            timestamp: [1_788_000_000],
            indicators: { quote: [{ close: [100] }] },
          },
        ],
      },
    };
    expect(() => parseCotizacion(sinPrevio, "X")).toThrow(/cierre anterior/);
  });

  it("dice qué símbolo falló cuando Yahoo no devuelve nada", () => {
    expect(() => parseCotizacion({ chart: { result: [] } }, "NOEXISTE")).toThrow(/NOEXISTE/);
  });
});

describe("movimiento de sesión", () => {
  const base = {
    symbol: "NVDA",
    currency: "USD",
    price: 110,
    previousClose: 100,
    sessionDate: "2026-09-08",
  };

  it("solo es evento si se sale del umbral de ese valor", () => {
    expect(toEvent(base, { ticker: "NVDA", umbral: 3, retrievedAt })).not.toBeNull();
    expect(toEvent(base, { ticker: "NVDA", umbral: 15, retrievedAt })).toBeNull();
  });

  it("un día tranquilo no genera nada", () => {
    const tranquilo = { ...base, price: 100.4 };
    expect(toEvent(tranquilo, { ticker: "NVDA", umbral: 3, retrievedAt })).toBeNull();
  });

  it("cumple el contrato y guarda la variación como cifra, no como texto", () => {
    const e = toEvent(base, { ticker: "NVDA", nombre: "NVIDIA", umbral: 3, retrievedAt })!;
    expect(() => NormalizedEvent.parse(e)).not.toThrow();
    expect(e.kind).toBe("market_move");
    expect(e.actual).toBe(10);
    expect(e.unit).toBe("%");
    expect(e.title).toContain("NVDA +10,00 %");
    expect(e.summary).toContain("NVIDIA (NVDA)");
  });

  // Un evento por valor y sesión: el cron pasa cada quince minutos y el precio
  // sigue moviéndose, pero "hoy se ha movido" se cuenta una vez.
  it("da el mismo id durante toda la sesión y otro al día siguiente", () => {
    const hoy = toEvent(base, { ticker: "NVDA", umbral: 3, retrievedAt })!;
    const masTarde = toEvent({ ...base, price: 112 }, { ticker: "NVDA", umbral: 3, retrievedAt })!;
    const manana = toEvent(
      { ...base, sessionDate: "2026-09-09" },
      { ticker: "NVDA", umbral: 3, retrievedAt },
    )!;
    expect(masTarde.id).toBe(hoy.id);
    expect(manana.id).not.toBe(hoy.id);
  });

  // Yahoo no es oficial y no tiene SLA: entra por el filtro como prensa, no como
  // dato primario. Lo que le abre la puerta es estar en la watchlist.
  it("no se declara fuente oficial", () => {
    expect(toEvent(base, { ticker: "NVDA", umbral: 3, retrievedAt })!.official).toBe(false);
  });
});
