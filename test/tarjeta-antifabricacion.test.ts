import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ANALISIS_RETIRADO, RESUMEN_RETIRADO, TarjetaEvento } from "../app/_componentes/tarjeta-evento.tsx";
import type { FilaEvento } from "../src/db/lectura.ts";

/**
 * El dashboard enseña lo guardado, y lo guardado antes del 14-09 pasó por un
 * control más permisivo que el de Telegram: 1 de 7 análisis y 21 frases antiguas
 * citaban cifras que la fuente no dice. La tarjeta aplica ahora el mismo control
 * estricto al pintar. No toca la base: deja de enseñar y lo dice.
 *
 * Se pinta el componente de verdad, no una copia de su condición.
 */
const base: FilaEvento = {
  id: "rss:cnbc-markets:prueba", source: "rss", source_url: "https://example.test/cobre", kind: "news",
  title: "Copper production falls 5% during maintenance", summary: "The operator confirms a temporary reduction.",
  country: null, series_id: "cnbc-markets", observed_at: "2026-09-14T10:00:00.000Z",
  first_seen_at: new Date("2026-09-14T10:05:00.000Z"),
  actual: null, previous: null, consensus: null, unit: null, surprises: [], stale: false, official: false,
  importance_score: 8, market_impact_score: 7, sentiment: "neutral", one_liner: null,
  sent_at: null, deep_analysis: null, body: null, analysis: null, news_level: "important",
};

const analisisCorrecto = {
  why_it_matters: "Menos oferta puede presionar a los compradores tras la caída del 5%.",
  catalysts: [], risks: ["No consta cuánto durará la parada."],
  affected_assets: [
    { symbol: "Copper", direction: "up", confidence: 2 },
    { symbol: "ACME", direction: "down", confidence: 1 },
  ],
  what_to_watch: ["La confirmación del reinicio."],
} as unknown as FilaEvento["analysis"];

const pintar = (evento: FilaEvento) =>
  renderToStaticMarkup(createElement(TarjetaEvento, { evento, ahora: new Date("2026-09-14T12:00:00.000Z"), abierta: true }));

describe("la tarjeta del dashboard no enseña cifras que la fuente no dice", () => {
  it("un análisis respaldado se enseña, sin los activos que no están en la fuente", () => {
    const html = pintar({ ...base, analysis: analisisCorrecto });
    expect(html).toContain("Menos oferta puede presionar");
    expect(html).toContain("Copper");
    expect(html).not.toContain("ACME");
    expect(html).not.toContain(ANALISIS_RETIRADO);
  });

  it("un análisis con una cifra inventada en what_to_watch no se enseña, y se dice", () => {
    const inventado = { ...analisisCorrecto!, what_to_watch: ["El reinicio en 12 semanas."] };
    const html = pintar({ ...base, analysis: inventado });
    expect(html).toContain(ANALISIS_RETIRADO);
    expect(html).not.toContain("12 semanas");
    expect(html).not.toContain("Menos oferta puede presionar");
  });

  it("una frase del scoring se enseña solo si sus cifras están en la fuente", () => {
    const buena = pintar({ ...base, one_liner: "La producción de cobre cae un 5% por mantenimiento." });
    expect(buena).toContain("cae un 5%");
    expect(buena).not.toContain(RESUMEN_RETIRADO);

    const inventada = pintar({ ...base, one_liner: "La producción de cobre cae un 40% por mantenimiento." });
    expect(inventada).toContain(RESUMEN_RETIRADO);
    expect(inventada).not.toContain("40%");
  });

  it("el cuerpo de lo que salió a Telegram se sigue enseñando tal cual: es el registro de lo enviado", () => {
    const html = pintar({ ...base, sent_at: new Date("2026-09-14T10:10:00.000Z"), body: "Texto literal enviado" });
    expect(html).toContain("Texto literal enviado");
  });
});
