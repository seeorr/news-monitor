import { describe, expect, it } from "vitest";
import { applyRules, mereceAlerta, RULE_REASON_CODES } from "../src/pipeline/rules.ts";
import { Scoring, scoreEvent, type CascadeDeps } from "../src/ai/cascade.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

// Casos sintéticos de los patrones vistos en feeds públicos; ninguna cartera.
const noticia = (title: string, summary: string | null = null): NormalizedEvent => ({
  id: "rss:prueba:1", source: "rss", source_url: "https://example.com/news",
  kind: "news", title, summary, country: "🌐", series_id: "prueba",
  observed_at: "2026-09-10T10:00:00Z", retrieved_at: "2026-09-10T10:01:00Z",
  actual: null, previous: null, consensus: null, unit: null,
  surprises: [], stale: false, official: false,
});

describe("cobertura de las reglas sin ampliar el umbral de alerta", () => {
  it.each([
    ["Central bank holds benchmark rate unchanged", "macro"],
    ["Consumer price growth slows in August", "macro"],
    ["Retail sales fall more than expected", "macro"],
    ["Industrial output rebounds after a weak quarter", "macro"],
    ["Jobless claims rise as PMI contracts", "macro"],
    ["El banco central revisa los tipos de interés", "macro"],
    ["Nuevos aranceles sobre las importaciones", "macro"],
    ["Country to pump capital into banks and insurers", "market"],
    ["Crude stocks fall less than expected", "market"],
    ["Bond sell-off deepens as investors reassess outlook", "market"],
    ["War raises energy costs for households", "geopolitics"],
    ["Blockade disrupts passage through a key shipping strait", "geopolitics"],
    ["Grain exports shift as war reshapes trade", "geopolitics"],
    ["El bloqueo del estrecho interrumpe el suministro de petróleo", "geopolitics"],
    ["Acme announces acquisition of a competitor", "corporate"],
    ["Broker upgrades Acme after revised outlook", "corporate"],
  ])("recupera %s por %s", (title, reasonCode) => {
    expect(applyRules(noticia(title))).toMatchObject({ pass: true, reasonCode });
  });

  it("usa la entradilla cuando el titular no identifica el hecho", () => {
    expect(applyRules(noticia("A surprise from the monthly report", "Industrial output fell in July.")))
      .toMatchObject({ pass: true, reasonCode: "macro" });
  });

  it.each([
    "FedEx opens a new office", "Chipotle launches a new menu",
    "El analista comparó las oficinas", "Los distintos tipos de vivienda",
  ])("no acepta subcadenas o términos genéricos: %s", (title) => {
    expect(applyRules(noticia(title)).pass).toBe(false);
  });

  it.each([
    "A war of words at the awards ceremony", "The canal festival opens this week",
    "A new biography of the former president", "Company opens a new office",
  ])("no convierte política o palabras aisladas en impacto de mercado: %s", (title) => {
    expect(applyRules(noticia(title))).toMatchObject({ pass: false, reasonCode: "no_match" });
  });

  it.each([
    "Acme Q2 Earnings Call Transcript", "Acme Q2 Earnings Call Highlights",
    "Card welcome offer: earn points today", "Best CD rates today",
  ])("descarta contenido mecánico o promocional sin empresa vigilada: %s", (title) => {
    expect(applyRules(noticia(title))).toMatchObject({ pass: false, reasonCode: "low_signal" });
  });

  it("la watchlist no convierte una transcripción en hecho nuevo", () => {
    expect(applyRules(noticia("Acme Q2 Earnings Call Transcript"), {
      watchlist: [{ ticker: "ACMX", nombre: "Acme Inc." }],
    })).toMatchObject({ pass: false, reasonCode: "low_signal" });
  });

  it("una fuente oficial rutinaria también necesita un hecho nuevo", () => {
    expect(applyRules({ ...noticia("Fireside chat"), official: true }))
      .toMatchObject({ pass: false, reasonCode: "low_signal" });
  });
});

describe("la watchlist se reconoce sin diccionarios privados en el código", () => {
  const watchlist = [{ ticker: "ACMX", nombre: "Acme Robotics Inc.", quoteSymbol: "ACMX.DE" }];

  it("acepta el nombre sin sufijo legal aunque no se imprima el ticker", () => {
    expect(applyRules(noticia("Acme Robotics signs new supply contract"), { watchlist }))
      .toMatchObject({ pass: true, reasonCode: "watchlist_name" });
  });
  it("también busca el nombre en la entradilla", () => {
    expect(applyRules(noticia("A new partnership", "The agreement involves Acme Robotics."), { watchlist }))
      .toMatchObject({ pass: true, reasonCode: "watchlist_name" });
  });
  it("no reduce el nombre a una palabra compartida por todo un sector", () => {
    expect(applyRules(noticia("Robotics company opens a new office"), { watchlist }).pass).toBe(false);
  });
  it.each(["^INDX", "ACMX.DE", "A.C"])("respeta signos y puntos en %s", (ticker) => {
    expect(applyRules(noticia(`${ticker} announces a new partnership`), { watchlist: [ticker] }))
      .toMatchObject({ pass: true, reasonCode: "watchlist_symbol" });
  });
  it("acepta el símbolo alternativo de cotización", () => {
    expect(applyRules(noticia("ACMX.DE signs a contract"), { watchlist }))
      .toMatchObject({ pass: true, reasonCode: "watchlist_symbol" });
  });
  it.each(["A new office opens", "IT is a growing industry", "Focus ON customer service"])(
    "no confunde palabras con tickers cortos: %s", (title) => {
      expect(applyRules(noticia(title), { watchlist: ["A", "IT", "ON"] }).pass).toBe(false);
    },
  );
  it.each(["$ON announces a contract", "Company (ON) announces a contract", "NASDAQ:ON announces a contract"])(
    "reconoce un ticker corto con notación financiera: %s", (title) => {
      expect(applyRules(noticia(title), { watchlist: ["ON"] }).pass).toBe(true);
    },
  );
  it("un movimiento estructurado no pierde un ticker corto", () => {
    expect(applyRules({ ...noticia("ON +4,00 % en la sesión"), kind: "market_move", series_id: "ON" }, {
      watchlist: ["ON"],
    })).toMatchObject({ pass: true, reasonCode: "watchlist_symbol" });
  });
  it("ignora un símbolo vacío y un nombre demasiado corto", () => {
    expect(applyRules(noticia("An office opens"), { watchlist: ["", " ", { ticker: "Z", nombre: "A Inc." }] }).pass)
      .toBe(false);
  });
  it("el motivo no reproduce la cartera ni el titular", () => {
    const decision = applyRules(noticia("ACMX signs an agreement"), { watchlist });
    expect(RULE_REASON_CODES).toContain(decision.reasonCode);
    expect(JSON.stringify(decision)).not.toContain("ACMX");
  });
});

describe("puntuación y puerta de alerta coherentes", () => {
  const scoring: Scoring = {
    importance_score: 6, market_impact_score: 5, sentiment: "neutral",
    needs_alert: true, one_liner: "Hecho relevante con alcance limitado.",
  };
  it("rechaza decimales que la base redondearía cambiando el significado del umbral", () => {
    expect(Scoring.safeParse({ ...scoring, importance_score: 6.5 }).success).toBe(false);
    expect(Scoring.safeParse({ ...scoring, market_impact_score: 7.5 }).success).toBe(false);
    expect(Scoring.safeParse(scoring).success).toBe(true);
  });
  it("no envía una noticia oficial de 3/10 aunque needs_alert sea true", () => {
    expect(mereceAlerta({ ...noticia("Routine speech"), official: true }, { ...scoring, importance_score: 3 }, 7))
      .toBe(false);
  });
  it("conserva la excepción de un punto para novedades de fuente primaria", () => {
    expect(mereceAlerta({ ...noticia("Official decision"), official: true }, scoring, 7)).toBe(true);
    expect(mereceAlerta(noticia("Press report"), scoring, 7)).toBe(false);
    expect(mereceAlerta(noticia("Press report"), { ...scoring, importance_score: 7 }, 7)).toBe(true);
  });
  it("envía al scoring una rúbrica y la información de la entradilla, sin llamar a una API", async () => {
    const calls: Array<{ system: string; messages: Array<{ content: string }> }> = [];
    const deps = {
      modelScoring: "test", modelAnalysis: "test",
      client: { messages: { parse: async (request: typeof calls[number]) => {
        calls.push(request);
        return { parsed_output: scoring, stop_reason: "end_turn" };
      } } },
    } as unknown as CascadeDeps;
    const result = await scoreEvent(noticia("Monthly report", "Industrial output fell."), deps);
    expect(result).toEqual(scoring);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("enteros de 0 a 10");
    expect(calls[0]!.system).toContain("needs_alert solo es true");
    expect(calls[0]!.system).toContain("NO es sorpresa frente al consenso");
    expect(calls[0]!.messages[0]!.content).toContain("Industrial output fell.");
  });
});
