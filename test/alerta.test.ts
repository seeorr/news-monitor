import { describe, expect, it } from "vitest";
import { formatAlert } from "../src/notify/telegram.ts";
import type { Analysis, Scoring } from "../src/ai/cascade.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const event: NormalizedEvent = {
  id: "fred:CPIAUCSL:2026-08-01",
  source: "fred",
  source_url: "https://fred.stlouisfed.org/series/CPIAUCSL",
  kind: "macro_release",
  title: "US CPI",
  country: "US",
  series_id: "CPIAUCSL",
  observed_at: "2026-08-01",
  retrieved_at: "2026-09-08T10:00:00.000Z",
  actual: 3.2,
  previous: 3.4,
  consensus: 3.4,
  unit: "%",
  surprise: { value: -0.2, basis: "consensus", unit: "%" },
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

  it("declara la base cuando la sorpresa no es contra consenso", () => {
    const sinConsenso = {
      ...event,
      consensus: null,
      surprise: { value: -0.2, basis: "previous" as const, unit: "%" },
    };
    const t = formatAlert(sinConsenso, scoring, analysis);
    expect(t).toContain("Anterior: 3,4%");
    expect(t).toContain("(vs anterior)");
    expect(t).not.toContain("Consenso:");
  });

  it("no imprime un hueco como si fuera un dato", () => {
    const t = formatAlert({ ...event, consensus: null, previous: null, surprise: null }, scoring, null);
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
