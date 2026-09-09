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
    });

    expect(consultas).toHaveLength(2);
    expect(consultas[0]?.sql).toContain("insert into events");
    expect(consultas[0]?.valores.slice(-4)).toEqual([7, 4, "neutral", "El IPC afloja una decima."]);
    expect(consultas[1]?.sql).toContain("insert into alerts");
    expect(consultas[1]?.valores).toEqual([evento.id, 7, 4, "neutral", true, "texto de la alerta"]);
  });
});
