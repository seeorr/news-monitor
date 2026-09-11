import { describe, expect, it } from "vitest";
import { applyRules } from "../src/pipeline/rules.ts";
import { detectRelevance } from "../src/pipeline/relevance.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

/**
 * Vigilar una empresa sin bajarle el listón a su prensa.
 *
 * **Lo primero, porque se creyó lo contrario:** estar en la watchlist **no**
 * admite ni una noticia más. El filtro de relevancia decide antes, y rechaza el
 * ruido —«should you buy the dip», los previos sin hecho concreto— con la lista
 * y sin ella. Se midió contra los titulares reales que quedaron en la cola el
 * 11-09, y los cuatro se descartan igual en los dos casos.
 *
 * Lo que la lista sí cambia, sobre una noticia **ya admitida**, son dos cosas:
 * la marca como relación **directa** —que en `news-policy` baja el umbral de
 * importancia de 7 a 6— y la prioridad en la cola. Eso es lo que este
 * interruptor permite apagar: «vigílala para sus documentos y su fecha de
 * resultados, pero no le bajes el listón por estar en mi lista».
 *
 * Y hay una vía que no pasa por aquí en absoluto: el 8-K de resultados llega
 * marcado como **oficial**, y lo oficial se admite antes de mirar ninguna
 * watchlist. Esa es la que trae la cifra.
 */

const base: NormalizedEvent = {
  id: "rss:yahoo-finance:solo-oficial",
  source: "rss",
  source_url: "https://example.invalid/noticia",
  kind: "news",
  title: "",
  summary: null,
  country: "US",
  series_id: null,
  observed_at: "2026-09-11T12:00:00.000Z",
  retrieved_at: "2026-09-11T12:05:00.000Z",
  actual: null,
  previous: null,
  consensus: null,
  unit: null,
  surprises: [],
  stale: false,
  official: false,
};

const noticia = (title: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ ...base, title, ...extra });

const ORACLE = { ticker: "ORCL", nombre: "Oracle Corporation", quoteSymbol: null };
const ORACLE_SOLO_OFICIAL = { ...ORACLE, vigilarNoticias: false };

/** Una noticia corporativa con hecho concreto: la que sí atraviesa el filtro. */
const RESULTADOS = "Oracle Corporation announces fourth quarter results and raises guidance";

describe("lo que la watchlist cambia de verdad", () => {
  it("sobre una noticia admitida, la marca como relación directa", () => {
    const ev = noticia(RESULTADOS);
    expect(applyRules(ev, { watchlist: [ORACLE] }).reasonCode).toBe("watchlist_name");
    expect(detectRelevance(ev, { watchlist: [ORACLE] }).watchlistRelation).toBe("direct_material");
  });

  it("y apagando sus noticias, la misma noticia entra sin ese trato", () => {
    const ev = noticia(RESULTADOS);
    const off = applyRules(ev, { watchlist: [ORACLE_SOLO_OFICIAL] });
    // Sigue admitida —es una noticia corporativa con hecho— pero ya no por la
    // lista, así que conserva el umbral general en vez del rebajado.
    expect(off.pass).toBe(true);
    expect(off.reasonCode).toBe("corporate");
    expect(detectRelevance(ev, { watchlist: [ORACLE_SOLO_OFICIAL] }).watchlistRelation).toBe("none");
  });

  it("tampoco la marca por el símbolo, que es la otra puerta", () => {
    const ev = noticia("ORCL announces fourth quarter results and raises guidance");
    expect(applyRules(ev, { watchlist: [ORACLE] }).reasonCode).toBe("watchlist_symbol");
    expect(applyRules(ev, { watchlist: [ORACLE_SOLO_OFICIAL] }).reasonCode).toBe("corporate");
  });
});

describe("lo OFICIAL no depende de ningún interruptor", () => {
  it("el 8-K de resultados entra igual, y es el que trae la cifra", () => {
    const ocho_k = noticia("Oracle Corporation Results of Operations and Financial Condition",
      { official: true, kind: "filing", source: "sec-edgar" });
    expect(applyRules(ocho_k, { watchlist: [ORACLE_SOLO_OFICIAL] })).toMatchObject({
      pass: true, reasonCode: "official",
    });
  });

  it("y su propio movimiento de precio también, que no es prensa", () => {
    // Apagar las noticias no es decir «no me avises si se desploma». El
    // movimiento del símbolo vigilado es una observación del sistema.
    const caida = noticia("ORCL -6,2 %", { kind: "market_move", series_id: "ORCL" });
    expect(applyRules(caida, { watchlist: [ORACLE_SOLO_OFICIAL] })).toMatchObject({
      pass: true, reasonCode: "watchlist_symbol",
    });
  });
});

describe("el ruido se rechaza con lista y sin ella", () => {
  /** Titulares reales, copiados de la cola de producción del 11-09. */
  const RUIDO = [
    "Adobe stock at 1-month low: Should you buy the dip into today's earnings?",
    "Ahead of Oracle Earnings, Here's What Barchart Data Says Comes Next for ORCL Stock",
    "Oracle earnings read-throughs: cloud rivals, AI suppliers, and hyperscalers to watch",
    "U.S. stock futures steady with CPI on tap; Oracle firms on strong earnings",
  ];

  it("añadir la empresa NO abre la puerta a su prensa", () => {
    for (const titular of RUIDO) {
      const ev = noticia(titular);
      expect(applyRules(ev, {}).pass, `sin lista: ${titular}`).toBe(false);
      expect(applyRules(ev, { watchlist: [ORACLE] }).pass, `con lista: ${titular}`).toBe(false);
      expect(applyRules(ev, { watchlist: [ORACLE_SOLO_OFICIAL] }).pass, `solo oficial: ${titular}`).toBe(false);
    }
  });
});

describe("lo que ya estaba configurado no cambia", () => {
  it("sin decir nada, una empresa se comporta como siempre", () => {
    expect(applyRules(noticia(RESULTADOS), { watchlist: [ORACLE] }).reasonCode).toBe("watchlist_name");
  });

  it("un ticker suelto del respaldo por entorno conserva su trato", () => {
    // `desdeEntorno` produce tickers sin el campo: ausente tiene que ser `true`.
    expect(applyRules(noticia("ORCL announces fourth quarter results"), { watchlist: ["ORCL"] }).reasonCode)
      .toBe("watchlist_symbol");
  });

  it("apagar una empresa no apaga a las demás de la lista", () => {
    const lista = [ORACLE_SOLO_OFICIAL, { ticker: "MU", nombre: "MICRON TECHNOLOGY INC", quoteSymbol: null }];
    expect(applyRules(noticia(RESULTADOS), { watchlist: lista }).reasonCode).toBe("corporate");
    expect(applyRules(noticia("MICRON TECHNOLOGY INC announces fourth quarter results"), { watchlist: lista }).reasonCode)
      .toBe("watchlist_name");
  });
});
