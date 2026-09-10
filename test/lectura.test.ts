import { describe, expect, it } from "vitest";
import {
  historialAlertas,
  listarEventos,
  loImportante,
  ultimasSeries,
  ultimosMovimientos,
} from "../src/db/lectura.ts";
import type { Ejecutor } from "../src/db/cliente.ts";

/**
 * El mismo espía que la watchlist y el registro de eventos: se comprueba la
 * consulta que sale de casa. Aquí eso vale doble, porque estas consultas las
 * parametriza una URL y lo que se mira es que ningún valor de fuera acabe dentro
 * del texto de la consulta.
 */
function espia() {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  const ejecutor: Ejecutor = async (strings, ...valores) => {
    consultas.push({ sql: strings.join("?"), valores });
    return [];
  };
  return { consultas, ejecutor };
}

describe("lo importante", () => {
  it("ordena por nota y deja fuera lo que nunca se puntuo", async () => {
    const { consultas, ejecutor } = espia();
    await loImportante(ejecutor);

    const { sql } = consultas[0]!;
    expect(sql).toContain("where e.importance_score is not null");
    expect(sql).toContain("order by e.importance_score desc, e.first_seen_at desc");
  });

  // Las cuatro alertas enviadas antes de que `events` tuviera la columna guardaron
  // su nota solo en `alerts`. Sin el coalesce, "lo mas importante" salia vacio.
  it("recupera la nota de alerts cuando el evento no la tiene", async () => {
    const { consultas, ejecutor } = espia();
    await loImportante(ejecutor);
    expect(consultas[0]?.sql).toContain(
      "coalesce(e.importance_score, a.importance_score)       as importance_score",
    );
  });

  it("un limite absurdo no pide la tabla entera", async () => {
    const { consultas, ejecutor } = espia();
    await loImportante(ejecutor, { limite: 100_000 });
    expect(consultas[0]?.valores[0]).toBe(200);
  });

  it("un limite invalido cae al valor por defecto", async () => {
    const { consultas, ejecutor } = espia();
    await loImportante(ejecutor, { limite: -3 });
    expect(consultas[0]?.valores[0]).toBe(10);
  });
});

describe("listado de eventos", () => {
  it("ordena por first_seen_at y no por observed_at, que es texto", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor);

    const { sql } = consultas[0]!;
    expect(sql).toContain("order by e.first_seen_at desc");
    expect(sql).not.toContain("order by e.observed_at");
  });

  // Un `kind` que llega de la URL no puede acabar dentro del texto de la consulta.
  it("los filtros viajan como parametros, nunca dentro del SQL", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor, { kinds: ["news"], sources: ["rss"], sentimiento: "bullish" });

    const { sql, valores } = consultas[0]!;
    expect(sql).not.toContain("'news'"); // news_decisions es un identificador SQL, no el filtro interpolado.
    expect(sql).not.toContain("bullish");
    expect(valores).toContainEqual(["news"]);
    expect(valores).toContainEqual(["rss"]);
    expect(valores).toContain("bullish");
  });

  it("un kind que no esta en el enum no llega a la base", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor, { kinds: ["news", "'; drop table events; --"] });
    expect(consultas[0]?.valores[0]).toEqual(["news"]);
  });

  it("sin filtros manda listas vacias, que el SQL neutraliza el solo", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor);

    const { sql, valores } = consultas[0]!;
    expect(valores[0]).toEqual([]);
    expect(sql).toContain("cardinality(?::text[]) = 0 or e.kind = any(?::text[])");
  });

  it("solo oficiales es un booleano, no un trozo de where", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor, { soloOficiales: true });
    expect(consultas[0]?.valores).toContain(true);
    expect(consultas[0]?.sql).toContain("::boolean = false or e.official");
  });

  it("el offset no acepta un negativo", async () => {
    const { consultas, ejecutor } = espia();
    await listarEventos(ejecutor, { offset: -50 });
    expect(consultas[0]?.valores.at(-1)).toBe(0);
  });
});

describe("historial de alertas", () => {
  // Es la unica consulta que NO lleva coalesce: aqui lo que interesa es con que
  // nota se anuncio, y eso solo lo dice `alerts`.
  it("lee la nota de alerts, que es la que se envio", async () => {
    const { consultas, ejecutor } = espia();
    await historialAlertas(ejecutor);

    const { sql } = consultas[0]!;
    expect(sql).toContain("a.importance_score, a.market_impact_score, a.sentiment");
    expect(sql).not.toContain("coalesce(e.importance_score");
    expect(sql).toContain("order by a.sent_at desc");
  });
});

describe("series macro", () => {
  it("no va a la base si no se le pide ninguna serie", async () => {
    const { consultas, ejecutor } = espia();
    expect(await ultimasSeries(ejecutor, [])).toEqual([]);
    expect(consultas).toHaveLength(0);
  });

  // Dentro de una serie el formato de `observed_at` si es homogeneo, y hay indice.
  it("coge la ultima observacion de cada serie por observed_at", async () => {
    const { consultas, ejecutor } = espia();
    await ultimasSeries(ejecutor, ["CPIAUCSL", "UNRATE"]);

    const { sql, valores } = consultas[0]!;
    expect(sql).toContain("distinct on (e.series_id)");
    expect(sql).toContain("order by e.series_id, e.observed_at desc");
    expect(valores[0]).toEqual(["CPIAUCSL", "UNRATE"]);
  });
});

/**
 * El otro lado del hueco G2: guardar el analisis no sirve de nada si la consulta
 * no lo pide. Y son cuatro consultas con la lista de columnas escrita entera,
 * porque el driver escapa cada hueco de la plantilla como parametro y un
 * `${COLUMNAS}` mandaria la lista como si fuera un dato: olvidarla en una sola de
 * las cuatro es el fallo que esto caza.
 */
describe("analisis del paso 4 al releerlo", () => {
  it("las cuatro consultas que hacen join con alerts lo piden", async () => {
    const { consultas, ejecutor } = espia();
    await loImportante(ejecutor);
    await listarEventos(ejecutor);
    await historialAlertas(ejecutor);
    await ultimasSeries(ejecutor, ["CPIAUCSL"]);

    expect(consultas).toHaveLength(4);
    for (const { sql } of consultas) expect(sql).toContain("a.analysis");
  });

  // El driver devuelve el `jsonb` ya deserializado: aqui no se parsea nada, y
  // esta prueba fija la forma con la que cuenta la ficha de detalle.
  it("la fila llega con el analisis ya deserializado", async () => {
    const analisis = {
      why_it_matters: "Un recorte de tipos abarata el credito.",
      catalysts: ["Actas del FOMC la semana que viene."],
      risks: ["Un IPC al alza revierte la expectativa."],
      affected_assets: [{ symbol: "ACME", direction: "up", confidence: 2 }],
      what_to_watch: ["El bono a 2 anos."],
    };
    const ejecutor: Ejecutor = async () => [{ id: "fred:CPIAUCSL:2026-08-01", analysis: analisis }];

    const [fila] = await historialAlertas(ejecutor);
    expect(fila?.analysis?.affected_assets[0]?.symbol).toBe("ACME");
    expect(fila?.analysis?.risks).toEqual(["Un IPC al alza revierte la expectativa."]);
    expect(fila?.analysis?.what_to_watch).toHaveLength(1);
  });

  // Las alertas anteriores al 9 de septiembre formatearon su analisis y lo
  // tiraron. Su columna es null y no se puede reconstruir sin inventarla; lo que
  // si conservan es su `body`, que es el texto que de verdad salio.
  it("una alerta sin analisis lo devuelve a null, no como objeto vacio", async () => {
    const ejecutor: Ejecutor = async () => [
      { id: "fred:CPIAUCSL:2026-08-01", body: "texto de la alerta", analysis: null },
    ];

    const [fila] = await historialAlertas(ejecutor);
    expect(fila?.analysis).toBeNull();
    expect(fila?.body).toBe("texto de la alerta");
  });
});

describe("ultimo movimiento por valor", () => {
  // El precio de hoy no esta en la base: solo se persiste la sesion que supera el
  // umbral. Lo unico que se puede enseñar es el ultimo que si llego a ser evento.
  it("solo mira los eventos de movimiento de mercado", async () => {
    const { consultas, ejecutor } = espia();
    await ultimosMovimientos(ejecutor);

    const { sql } = consultas[0]!;
    expect(sql).toContain("where e.kind = 'market_move'");
    expect(sql).toContain("distinct on (e.series_id)");
  });
});
