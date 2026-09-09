import { describe, expect, it } from "vitest";
import { neonSeenStore } from "../src/db/neon.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

/**
 * El mismo espía que la watchlist: se comprueba **la consulta que sale de casa**,
 * su texto y sus parámetros, no lo que Postgres hace con ella. El fallo que
 * estas pruebas cazan —una puntuación que se paga al modelo y no se escribe en
 * ninguna columna— vive entero ahí.
 */
function espia() {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  const ejecutor: Ejecutor = async (strings, ...valores) => {
    consultas.push({ sql: strings.join("?"), valores });
    return [];
  };
  return { consultas, ejecutor };
}

const URL_FALSA = "postgres://nadie@ninguna-parte/db";

const evento: NormalizedEvent = {
  id: "fred:CPIAUCSL:2026-08-01",
  source: "fred",
  source_url: "https://fred.stlouisfed.org/series/CPIAUCSL",
  kind: "macro_release",
  title: "US CPI",
  summary: null,
  country: "🇺🇸",
  series_id: "CPIAUCSL",
  observed_at: "2026-08-01",
  retrieved_at: "2026-09-08T10:00:00.000Z",
  actual: 3.54,
  previous: 3.73,
  consensus: null,
  unit: "%",
  surprise: { value: -0.19, basis: "previous", unit: "%" },
  stale: false,
  official: true,
};

const puntuacion = {
  importance: 6.6,
  impact: 4.2,
  sentiment: "neutral",
  oneLiner: "El IPC afloja una decima.",
};

describe("registro de un evento", () => {
  // El fallo: con el umbral en 7 la mayoría de lo que se puntúa no se anuncia, y
  // su nota se perdía. Se pagaba Haiku y se tiraba el resultado.
  it("escribe la nota del paso 3 aunque el evento no llegue a alertar", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).mark(evento, puntuacion);

    const { sql, valores } = consultas[0]!;
    expect(sql).toContain("importance_score, market_impact_score, sentiment, one_liner");
    expect(valores.slice(-4)).toEqual([7, 4, "neutral", "El IPC afloja una decima."]);
  });

  it("sin nota, las cuatro columnas se van a null y no a un 5 de relleno", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).mark(evento);

    expect(consultas[0]?.valores.slice(-4)).toEqual([null, null, null, null]);
  });

  // Un duplicado se marca sin nota después de que su representante se registrara
  // con la suya. Si el `do update` no llevara `coalesce`, ese marcado la borraría.
  it("un marcado sin nota no borra la que ya estaba", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).mark(evento);

    const { sql } = consultas[0]!;
    expect(sql).toContain("coalesce(excluded.importance_score, events.importance_score)");
    expect(sql).toContain("coalesce(excluded.sentiment, events.sentiment)");
    expect(sql).toContain("coalesce(excluded.one_liner, events.one_liner)");
  });

  // Idempotencia: el `do update` toca las cuatro columnas del paso 3 y nada más.
  // Que una segunda vuelta del cron reescribiera el titular o las cifras sería
  // exactamente el fallo que el `on conflict` existe para impedir.
  it("no reescribe el evento: el do update solo toca las cuatro columnas", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).mark(evento, puntuacion);

    const set = consultas[0]!.sql.split("do update set")[1] ?? "";
    for (const columna of ["title", "actual", "previous", "observed_at", "stale", "official"]) {
      expect(set).not.toContain(columna);
    }
  });

  it("la alerta escribe su nota en las dos tablas", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).saveAlert(evento, {
      ...puntuacion,
      deep: true,
      body: "texto de la alerta",
      analysis: null,
    });

    expect(consultas).toHaveLength(2);
    expect(consultas[0]?.sql).toContain("insert into events");
    expect(consultas[0]?.valores.slice(-4)).toEqual([7, 4, "neutral", "El IPC afloja una decima."]);
    expect(consultas[1]?.sql).toContain("insert into alerts");
    expect(consultas[1]?.valores).toEqual([
      evento.id,
      7,
      4,
      "neutral",
      true,
      "texto de la alerta",
      null,
    ]);
  });
});

/**
 * El hueco G2: `analyzeEvent()` devolvía el análisis, `formatAlert()` lo pasaba a
 * prosa y el objeto moría con la función. Se pagaba el modelo caro por algo que
 * la base no podía consultar. El fallo vivía entero en esta consulta —la columna
 * no estaba en la lista— y por eso se mira aquí.
 */
describe("analisis del paso 4", () => {
  const analisis = {
    why_it_matters: "Un recorte de tipos abarata el credito.",
    catalysts: ["Actas del FOMC la semana que viene."],
    risks: ["Un IPC al alza revierte la expectativa."],
    affected_assets: [
      { symbol: "ACME", direction: "up", confidence: 2 },
      { symbol: "GLOBX", direction: "unclear", confidence: 1 },
    ],
    what_to_watch: ["El bono a 2 anos.", "El dolar."],
  };

  it("el analisis viaja a la base entero y como jsonb", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).saveAlert(evento, {
      ...puntuacion,
      deep: true,
      body: "texto de la alerta",
      analysis: analisis,
    });

    const { sql, valores } = consultas[1]!;
    // `\b` a los dos lados a proposito: sin el, "deep_analysis" haria pasar la
    // prueba con la columna nueva sin escribir, que es justo el fallo que caza.
    expect(sql).toMatch(/\banalysis\b/);
    expect(sql).toContain("::jsonb");

    // Se guarda la forma entera, no un resumen ni tres campos sueltos: es lo que
    // permite releerla sin volver a pagar el modelo.
    expect(JSON.parse(String(valores.at(-1)))).toEqual(analisis);
  });

  // Un objeto vacio diria "el modelo analizo esto y no encontro nada", y es
  // mentira: lo que pasa es que el paso 4 no corrio.
  it("una alerta sin analisis escribe null, no un objeto vacio", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).saveAlert(evento, {
      ...puntuacion,
      deep: false,
      body: "texto de la alerta",
      analysis: null,
    });

    expect(consultas[1]?.valores.at(-1)).toBeNull();
    expect(consultas[1]?.valores.at(-1)).not.toEqual({});
    expect(consultas[1]?.valores.at(-1)).not.toBe("{}");
  });

  // El analisis solo existe cuando hubo alerta: el paso 4 corre despues de
  // `mereceAlerta()`. En `events` seria una columna a null casi siempre.
  it("el analisis no se cuela en la tabla de eventos", async () => {
    const { consultas, ejecutor } = espia();
    await neonSeenStore(URL_FALSA, ejecutor).saveAlert(evento, {
      ...puntuacion,
      deep: true,
      body: "texto de la alerta",
      analysis: analisis,
    });

    expect(consultas[0]?.sql).toContain("insert into events");
    expect(consultas[0]?.sql).not.toMatch(/\banalysis\b/);
    expect(consultas[0]?.valores).not.toContain(JSON.stringify(analisis));
  });
});
