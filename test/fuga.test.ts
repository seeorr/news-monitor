import { describe, expect, it } from "vitest";
import { taparTickers } from "../src/pipeline/collect.ts";
import type { Vigilado } from "../src/db/watchlist.ts";

/**
 * La watchlist no puede salir en los logs de GitHub Actions.
 *
 * El repositorio es publico y sus logs tambien: cualquiera puede leer la salida
 * de cada ciclo. La primera version de esta red solo envolvia el log de la
 * ingesta, y dejaba fuera lo que `main.ts` imprime despues —el titular de cada
 * evento y el cuerpo entero de la alerta—, que es justo donde el ticker aparece
 * escrito con todas las letras.
 *
 * Los tickers de estas pruebas son inventados a proposito. En un repositorio
 * publico, un test que use la watchlist de verdad publica lo mismo que la fuga
 * que pretende impedir.
 */
const vigilado = (ticker: string, quoteSymbol: string | null = null): Vigilado => ({
  ticker,
  nombre: null,
  cik: null,
  quoteSymbol,
  vigilarFilings: true,
  vigilarPrecio: true,
  umbralMovimiento: 3,
});

function capturar(vigilados: Vigilado[]) {
  const salida: string[] = [];
  const log = taparTickers((...a: unknown[]) => salida.push(a.map(String).join(" ")), vigilados);
  return { salida, log };
}

describe("la watchlist no sale en los logs", () => {
  // El titulo de un movimiento de precio empieza por el ticker. Es la primera
  // linea que se publicaria en cuanto un valor se saliera de su umbral.
  it("tapa el ticker en el titulo de un movimiento de precio", () => {
    const { salida, log } = capturar([vigilado("ACME")]);
    log("▸ ACME +4,20 % en la sesión");
    expect(salida[0]).not.toContain("ACME");
    expect(salida[0]).toContain("•••");
  });

  it("tapa el ticker en el titulo de un documento de la SEC", () => {
    const { salida, log } = capturar([vigilado("ACME")]);
    log("▸ ACME · 8-K — resultados");
    expect(salida[0]).not.toContain("ACME");
  });

  // El cuerpo de la alerta es el texto largo, con el ticker repetido dentro de
  // la prosa del analisis. Es la fuga mas grande de todas.
  it("tapa el ticker dentro del cuerpo entero de la alerta", () => {
    const { salida, log } = capturar([vigilado("ACME")]);
    log(
      "🚨 MARKET ALERT\n🌐 ACME sube un 4 %\nActivos afectados: ACME 🟢🟢, GLOBX 🟢\n" +
        "Qué vigilar ahora: el próximo 8-K de ACME",
    );
    expect(salida[0]).not.toContain("ACME");
    expect(salida[0]?.match(/•••/g)).toHaveLength(3);
    // Lo que no está en la watchlist no se tapa: no es un dato personal.
    expect(salida[0]).toContain("GLOBX");
  });

  it("tapa tambien el simbolo de Yahoo, que no coincide con el ticker", () => {
    const { salida, log } = capturar([vigilado("GLOBX", "GLOBX.DE")]);
    log("✕ Yahoo no devolvió datos para GLOBX.DE");
    expect(salida[0]).not.toContain("GLOBX.DE");
    expect(salida[0]).not.toContain("GLOBX");
  });

  it("no distingue mayusculas: un titular en minusculas filtraria igual", () => {
    const { salida, log } = capturar([vigilado("ACME")]);
    log("acme presenta resultados");
    expect(salida[0]?.toLowerCase()).not.toContain("acme");
  });

  // Un ticker corto dentro de otra palabra no es una mencion. Taparlo dejaria el
  // log ilegible sin proteger nada: "•••ción" no esconde a nadie.
  it("solo tapa la palabra completa, no un trozo de otra palabra", () => {
    const { salida, log } = capturar([vigilado("ON")]);
    log("La sesión continúa monótona");
    expect(salida[0]).toBe("La sesión continúa monótona");
  });

  // Con la watchlist vacia no hay nada que tapar, y envolver por envolver
  // costaria una expresion regular vacia que casaria con todo.
  it("con la watchlist vacia devuelve el log tal cual", () => {
    const { salida, log } = capturar([]);
    log("nada que tapar");
    expect(salida[0]).toBe("nada que tapar");
  });

  // Un ticker con punto o guion es un simbolo valido, y sus caracteres son
  // metacaracteres de expresion regular: sin escapar, `A.C` casaria con `ABC`.
  it("escapa los metacaracteres del simbolo", () => {
    const { salida, log } = capturar([vigilado("A.C")]);
    log("ABC no es A.C");
    expect(salida[0]).toContain("ABC");
    expect(salida[0]).not.toContain("A.C ");
  });

  it("no toca lo que no es texto", () => {
    const salida: unknown[] = [];
    const log = taparTickers((...a: unknown[]) => salida.push(a[0]), [vigilado("ACME")]);
    log({ ticker: "ACME" });
    expect(salida[0]).toEqual({ ticker: "ACME" });
  });
});
