import { describe, expect, it } from "vitest";
import { agrupar, firma, sameStory, similitud, tambienLoCuentan } from "../src/pipeline/agrupar.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";
import { writeFileSync } from "node:fs";
import pares from "./fixtures/dedup-pares.json" with { type: "json" };

const noticia = (
  id: string,
  title: string,
  extra: Partial<NormalizedEvent> = {},
): NormalizedEvent => ({
  id,
  source: "rss",
  source_url: `https://x.test/${id}`,
  kind: "news",
  title,
  summary: null,
  country: "🌐",
  series_id: "cnbc-markets",
  observed_at: "2026-09-08T09:00:00.000Z",
  retrieved_at: "2026-09-08T10:00:00.000Z",
  actual: null,
  previous: null,
  consensus: null,
  unit: null,
  surprises: [],
  stale: false,
  official: false,
  ...extra,
});

describe("firma del titular", () => {
  it("quita acentos, puntuación y palabras vacías", () => {
    const f = firma("El BCE recorta los tipos, según el comunicado");
    expect([...f]).toContain("bce");
    expect([...f]).toContain("recorta");
    expect([...f]).not.toContain("los");
    expect([...f]).not.toContain("segun");
  });

  // "recorta 25 puntos" y "recorta 50 puntos" son las dos noticias que más se
  // parecen palabra a palabra y las que menos se pueden confundir.
  it("conserva los números, que es lo que distingue una noticia de otra", () => {
    expect([...firma("El BCE recorta 25 puntos basicos")]).toContain("25");
  });
});

describe("similitud", () => {
  it("da 1 a dos titulares iguales y 0 a dos sin nada en común", () => {
    expect(similitud(firma("Fed recorta tipos"), firma("Fed recorta tipos"))).toBe(1);
    expect(similitud(firma("Fed recorta tipos"), firma("Apple presenta iPhone"))).toBe(0);
  });
});

describe("agrupar", () => {
  it("funde la misma historia contada por dos medios", () => {
    const grupos = agrupar([
      noticia("a", "Fed cuts rates by 25 basis points at September meeting"),
      noticia("b", "Fed cuts rates 25 basis points at its September meeting", {
        series_id: "yahoo-finance",
      }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.duplicados).toHaveLength(1);
  });

  // Caso real del 8 de septiembre: con el umbral en 0,5 estas dos se fundían.
  it("no funde dos columnas parecidas que hablan de productos distintos", () => {
    const grupos = agrupar([
      noticia("a", "Best CD rates today, Monday, September 7, 2026: Lock in up to 4.35% APY"),
      noticia("b", "Best high-yield savings interest rates today, Tuesday, September 8, 2026: Earn up to 4.10%"),
    ]);
    expect(grupos).toHaveLength(2);
  });

  it("manda la fuente oficial aunque llegue la segunda", () => {
    const grupos = agrupar([
      noticia("prensa", "Fed cuts rates by 25 basis points today"),
      noticia("oficial", "Fed cuts rates by 25 basis points today", {
        official: true,
        series_id: "fed-press",
      }),
    ]);
    expect(grupos[0]?.representante.id).toBe("oficial");
    expect(grupos[0]?.duplicados[0]?.id).toBe("prensa");
  });

  it("no agrupa lo que no es una noticia", () => {
    const macro = noticia("m1", "US CPI", { kind: "macro_release", official: true });
    const otro = noticia("m2", "US CPI", { kind: "macro_release", official: true });
    expect(agrupar([macro, otro])).toHaveLength(2);
  });

  it("dice quién más lo cuenta, sin repetir al representante", () => {
    const grupos = agrupar([
      noticia("a", "Fed cuts rates by 25 basis points at September meeting"),
      noticia("b", "Fed cuts rates 25 basis points at its September meeting", {
        series_id: "yahoo-finance",
      }),
    ]);
    expect(tambienLoCuentan(grupos[0]!)).toEqual(["yahoo-finance"]);
  });

  it("es estable: el orden de llegada no cambia el resultado", () => {
    const a = noticia("a", "Fed cuts rates by 25 basis points at September meeting");
    const b = noticia("b", "Fed cuts rates 25 basis points at its September meeting");
    const uno = agrupar([a, b])[0]?.representante.id;
    const otro = agrupar([b, a])[0]?.representante.id;
    expect(uno).toBe(otro);
  });
});

// ---------------------------------------------------------------------------
// Muestra etiquetada: medir dónde falla la deduplicación, no retocarla a ojo.
// ---------------------------------------------------------------------------

type Entrada = {
  id: string; title: string; summary: string; series_id: string;
  official?: boolean; publication_at?: string;
};
type Caso = {
  id: string; clase: string; agrupar: boolean; motivo: string; coste: string;
  a: Entrada; b: Entrada;
};

const PUBLICACION_POR_DEFECTO = "2026-09-10T10:00:00.000Z";
const casos = (pares as unknown as { casos: Caso[] }).casos;

const desdeFixture = (e: Entrada): NormalizedEvent =>
  noticia(e.id, e.title, {
    summary: e.summary,
    series_id: e.series_id,
    official: e.official ?? false,
    observed_at: e.publication_at ?? PUBLICACION_POR_DEFECTO,
    publication_at: e.publication_at ?? PUBLICACION_POR_DEFECTO,
  });

const medir = (c: Caso) => {
  const a = desdeFixture(c.a), b = desdeFixture(c.b);
  return {
    caso: c,
    agrupa: agrupar([a, b]).length === 1,
    // El orden de llegada no puede decidir: se mide en los dos sentidos.
    agrupaAlReves: agrupar([desdeFixture(c.b), desdeFixture(c.a)]).length === 1,
    jaccard: similitud(firma(c.a.title), firma(c.b.title)),
  };
};

const caso = (id: string): Caso => {
  const encontrado = casos.find((c) => c.id === id);
  if (!encontrado) throw new Error(`caso ausente en el fixture: ${id}`);
  return encontrado;
};

/**
 * Lo que la muestra dice que sigue mal y NO se corrige aquí. Es deuda medida,
 * no una excusa: el test exige que cada caso listado **siga** divergiendo, así
 * que el día que se arregle uno, esta lista falla y hay que borrarlo de aquí.
 * Ninguno de estos se arregla bajando el umbral: la decisión es de Alberto.
 */
const DIVERGENCIAS_CONOCIDAS: Record<string, string> = {
  mn2: "Falso negativo: la entradilla oficial no cita el nivel del tipo y la de prensa sí, así que el rasgo de cifras difiere aunque el hecho sea el mismo. Se prefiere el duplicado visible al silencio.",
  mn5: "Falso negativo, misma causa que mn2: una entradilla menciona 2,00 % y la otra no.",
  suj1: "Falso positivo: 'keeps' no está en el extractor de sujeto, así que Fed y BCE quedan sin sujeto y el titular casi idéntico los funde. Arreglarlo toca storySubject, compartido con relevance.ts.",
  suj4: "Falso positivo, misma causa: 'beats' no está en el extractor de sujeto (Apple y Amazon).",
  suj5: "Falso positivo, misma causa: 'holds' no está en el extractor de sujeto (Banco de Inglaterra y Banco de Japón).",
  act1: "Falso positivo en el límite exacto del umbral (Jaccard 0,600): la suspensión del dividendo se añade a un titular ya entregado y entra como duplicado.",
};

describe("matriz de deduplicación sobre la muestra etiquetada", () => {
  const filas = casos.map(medir);
  const fp = filas.filter((f) => !f.caso.agrupar && f.agrupa).map((f) => f.caso.id);
  const fn = filas.filter((f) => f.caso.agrupar && !f.agrupa).map((f) => f.caso.id);

  // La matriz se fija con números para que una regresión se vea como tal y no
  // como «el test sigue en verde». Cambiarla exige explicar qué caso se movió.
  // `DEDUP_INFORME=<ruta>` vuelca el detalle par a par para volver a medir sin
  // tocar el test; sin esa variable no se escribe nada en ningún sitio.
  it("mantiene la matriz medida: 23 pares, 4 falsos positivos y 2 falsos negativos", () => {
    if (process.env["DEDUP_INFORME"]) {
      writeFileSync(process.env["DEDUP_INFORME"], [
        `TOTAL ${filas.length} VP ${filas.length - fp.length - fn.length - filas.filter((f) => !f.caso.agrupar && !f.agrupa).length} FP ${fp.length} FN ${fn.length}`,
        ...filas.map((f) => [f.caso.id, f.caso.clase, `debe=${f.caso.agrupar}`, `hace=${f.agrupa}`,
          `inverso=${f.agrupaAlReves}`, `jaccard=${f.jaccard.toFixed(3)}`].join(" | ")),
      ].join("\n"), "utf8");
    }
    expect(filas).toHaveLength(23);
    expect(fp).toEqual(["suj1", "suj4", "suj5", "act1"]);
    expect(fn).toEqual(["mn2", "mn5"]);
  });

  it("no decide por orden de llegada: cada par da lo mismo en los dos sentidos", () => {
    expect(filas.filter((f) => f.agrupa !== f.agrupaAlReves).map((f) => f.caso.id)).toEqual([]);
  });

  it.each(casos.filter((c) => !(c.id in DIVERGENCIAS_CONOCIDAS)).map((c) => [c.id, c.clase] as const))(
    "%s (%s) coincide con la etiqueta editorial",
    (id) => {
      const fila = medir(caso(id));
      expect(fila.agrupa, fila.caso.motivo).toBe(fila.caso.agrupar);
    },
  );

  it.each(Object.entries(DIVERGENCIAS_CONOCIDAS))(
    "%s sigue divergiendo de la etiqueta (deuda conocida, no silenciada)",
    (id, motivo) => {
      const fila = medir(caso(id));
      expect(fila.agrupa, `¿arreglado? bórralo de DIVERGENCIAS_CONOCIDAS: ${motivo}`)
        .not.toBe(fila.caso.agrupar);
    },
  );
});

/**
 * Seguridad editorial. Estos tres no son «una métrica peor»: son noticias que
 * el usuario no recibe nunca porque el sistema las cuenta como ya contadas.
 */
describe("seguridad editorial de la deduplicación", () => {
  it("no agrupa un desmentido con su afirmación aunque el hecho de tipos coincida", () => {
    // El importe y el nivel salen del mismo texto en las dos versiones, así que
    // el hecho macro es idéntico y la equivalencia de hecho se saltaba el
    // control de negación. Agrupar aquí es no entregar el desmentido.
    const c = caso("neg1");
    const a = desdeFixture(c.a), b = desdeFixture(c.b);
    expect(sameStory(a, b)).toBe(false);
    expect(agrupar([a, b])).toHaveLength(2);
    expect(agrupar([b, a])).toHaveLength(2);
  });

  it("no agrupa 'descarta subir los tipos' con 'sube los tipos'", () => {
    // Negación sin partícula negativa: el titular no dice «no», dice lo contrario.
    const c = caso("neg5");
    expect(agrupar([desdeFixture(c.a), desdeFixture(c.b)])).toHaveLength(2);
  });

  it("no agrupa un cuarto de punto con medio punto", () => {
    // 25 y 50 puntos básicos ya se distinguían en dígitos; escritos con palabras
    // —como los titula la prensa anglosajona— eran la misma noticia.
    const c = caso("cif4");
    expect(agrupar([desdeFixture(c.a), desdeFixture(c.b)])).toHaveLength(2);
  });
});
