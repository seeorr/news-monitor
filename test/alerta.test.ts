import { describe, expect, it } from "vitest";
import { formatAlert, sorpresa, sorpresas } from "../src/notify/telegram.ts";
import { cifras } from "../app/_lib/formato.ts";
import type { FilaEvento } from "../src/db/lectura.ts";
import type { Analysis, Scoring } from "../src/ai/cascade.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const event: NormalizedEvent = {
  id: "fred:CPIAUCSL:2026-08-01",
  source: "fred",
  source_url: "https://fred.stlouisfed.org/series/CPIAUCSL",
  kind: "macro_release",
  title: "US CPI",
  summary: null,
  country: "US",
  series_id: "CPIAUCSL",
  observed_at: "2026-08-01",
  retrieved_at: "2026-09-08T10:00:00.000Z",
  actual: 3.2,
  previous: 3.4,
  consensus: 3.4,
  unit: "%",
  surprises: [{ value: -0.2, basis: "consensus", unit: "%" }],
  stale: false,
  official: true,
};

const scoring: Scoring = {
  importance_score: 9,
  sentiment: "bullish",
  market_impact_score: 8,
  needs_alert: true,
  one_liner: "Inflacion por debajo de lo esperado.",
};

const analysis: Analysis = {
  why_it_matters: "Una inflacion menor abre la puerta a recortes de tipos.",
  catalysts: ["Proxima reunion del FOMC"],
  risks: ["Un repunte de la energia revertiria la senal"],
  affected_assets: [
    { symbol: "NVDA", direction: "up", confidence: 3 },
    { symbol: "BTC", direction: "up", confidence: 2 },
  ],
  what_to_watch: ["US 2Y", "US 10Y", "Nasdaq futures"],
};

describe("formato de la alerta", () => {
  it("respeta el formato objetivo del spec", () => {
    const t = formatAlert(event, scoring, analysis);
    expect(t).toContain("MARKET ALERT");
    expect(t).toContain("US CPI");
    expect(t).toContain("Actual: 3,2% | Consenso: 3,4% | Sorpresa: -0,2 pp (vs consenso)");
    expect(t).toContain("IMPORTANCIA: 9/10 | IMPACTO:");
    expect(t).toContain("NVDA");
    expect(t).toContain("Qué vigilar ahora: US 2Y · US 10Y · Nasdaq futures");
  });

  it("limpia los puntos finales de la lista de vigilancia", () => {
    const conPuntos = { ...analysis, what_to_watch: ["Vivienda y servicios.", "La variacion mensual."] };
    const t = formatAlert(event, scoring, conPuntos);
    expect(t).toContain("Vivienda y servicios · La variacion mensual");
    expect(t).not.toContain("servicios., ");
  });

  it("no deja la etiqueta colgando si la lista se queda vacia al limpiarla", () => {
    const vacia = { ...analysis, what_to_watch: [".", "", "  "] };
    const t = formatAlert(event, scoring, vacia);
    expect(t).not.toContain("Qué vigilar ahora");
  });

  it("descarta los elementos basura sin dejar separadores sueltos", () => {
    const sucia = { ...analysis, what_to_watch: ["US 2Y", ".", "US 10Y"] };
    const t = formatAlert(event, scoring, sucia);
    expect(t).toContain("Qué vigilar ahora: US 2Y · US 10Y");
  });

  it("omite los activos sin simbolo", () => {
    const sinSimbolo = {
      ...analysis,
      affected_assets: [{ symbol: "  ", direction: "up" as const, confidence: 2 }],
    };
    const t = formatAlert(event, scoring, sinSimbolo);
    expect(t).not.toContain("Activos afectados");
  });

  it("declara la base cuando la sorpresa no es contra consenso", () => {
    const sinConsenso = {
      ...event,
      consensus: null,
      surprises: [{ value: -0.2, basis: "previous" as const, unit: "%" }],
    };
    const t = formatAlert(sinConsenso, scoring, analysis);
    expect(t).toContain("Anterior: 3,4%");
    expect(t).toContain("(vs anterior)");
    expect(t).not.toContain("Consenso:");
  });

  it("no imprime un hueco como si fuera un dato", () => {
    const t = formatAlert({ ...event, consensus: null, previous: null, surprises: [] }, scoring, null);
    expect(t).not.toContain("Consenso:");
    expect(t).not.toContain("Sorpresa:");
    expect(t).not.toContain("null");
    expect(t).not.toContain("NaN");
  });

  it("avisa cuando el dato es obsoleto en vez de presentarlo como fresco", () => {
    const t = formatAlert({ ...event, stale: true }, scoring, analysis);
    expect(t).toContain("Dato obsoleto");
  });

  it("degrada al one-liner cuando no hubo analisis profundo", () => {
    const t = formatAlert(event, { ...scoring, importance_score: 5 }, null);
    expect(t).toContain("Resumen: Inflacion por debajo de lo esperado.");
    expect(t).not.toContain("Por qué importa:");
  });
});

/**
 * La sorpresa la escribe una sola funcion, y la usan la alerta de Telegram y el
 * dashboard. Antes eran dos: la alerta decia "-0,2 pp (vs anterior)" y la
 * pantalla "-0,2% vs anterior" para la misma cifra del mismo evento.
 */
describe("la sorpresa se escribe en un solo sitio", () => {
  it("una diferencia entre porcentajes son puntos porcentuales", () => {
    expect(sorpresa({ value: -0.19, basis: "previous", unit: "%" })).toBe("-0,2 pp (vs anterior)");
  });

  it("con signo, tambien cuando sube", () => {
    expect(sorpresa({ value: 0.4, basis: "consensus", unit: "%" })).toBe("+0,4 pp (vs consenso)");
  });

  // "pp" solo es cierto entre porcentajes. Con cualquier otra unidad se escribe
  // esa unidad, que es lo unico que se puede afirmar.
  it("con otra unidad, la unidad y no pp", () => {
    expect(sorpresa({ value: 12, basis: "mean_3m", unit: " puntos" })).toBe("+12,0 puntos (vs media 3m)");
  });

  it("la base se declara siempre: sin ella la cifra miente por omision", () => {
    for (const basis of ["consensus", "previous", "mean_3m"] as const) {
      expect(sorpresa({ value: 1, basis, unit: "%" })).toContain("vs ");
    }
  });
});

/**
 * Un evento lleva varias sorpresas y la alerta las enseña todas. Enseñar una y
 * callar la otra seria volver a elegir por el lector: comparar el IPC con el del
 * mes pasado es una variacion, y compararlo con la media de 3 meses dice si se
 * sale de la tendencia. No son la misma frase dicha dos veces.
 */
describe("varias sorpresas en la misma cifra", () => {
  const dos = [
    { value: -0.2, basis: "previous" as const, unit: "%" },
    { value: 0.4, basis: "mean_3m" as const, unit: "%" },
  ];

  it("las escribe todas, en orden y cada una con su base", () => {
    expect(sorpresas(dos)).toBe("-0,2 pp (vs anterior) · +0,4 pp (vs media 3m)");
  });

  it("el consenso encabeza cuando existe", () => {
    const tres = [{ value: -0.4, basis: "consensus" as const, unit: "%" }, ...dos];
    expect(sorpresas(tres)).toBe(
      "-0,4 pp (vs consenso) · -0,2 pp (vs anterior) · +0,4 pp (vs media 3m)",
    );
  });

  it("con una sola base escribe una sola, sin separador colgando", () => {
    expect(sorpresas([dos[0]!])).toBe("-0,2 pp (vs anterior)");
    expect(sorpresas([dos[0]!])).not.toContain("·");
  });

  it("sin ninguna devuelve null, para que la etiqueta no salga vacia", () => {
    expect(sorpresas([])).toBeNull();
    const t = formatAlert({ ...event, surprises: [] }, scoring, null);
    expect(t).not.toContain("Sorpresa:");
  });

  it("la alerta imprime la linea entera", () => {
    const t = formatAlert({ ...event, consensus: null, surprises: dos }, scoring, null);
    expect(t).toContain("Sorpresa: -0,2 pp (vs anterior) · +0,4 pp (vs media 3m)");
  });

  /**
   * El fallo que obligo a unificar `sorpresa()` fue que la alerta decia una cosa
   * y la pantalla otra para la misma cifra. Con dos sorpresas por evento el
   * riesgo se duplica: bastaria con que una de las dos superficies enseñara solo
   * la primera. Esto lo fija comparando las dos salidas de verdad.
   */
  it("el dashboard escribe exactamente la misma linea que la alerta", () => {
    const fila = { actual: 3.2, consensus: null, previous: 3.4, unit: "%", surprises: dos };
    const enPantalla = cifras(fila as FilaEvento).find((c) => c.etiqueta === "Sorpresa");
    const enTelegram = formatAlert({ ...event, consensus: null, surprises: dos }, scoring, null);
    expect(enPantalla?.valor).toBe(sorpresas(dos));
    expect(enTelegram).toContain(enPantalla!.valor);
  });
});
