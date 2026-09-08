import { describe, expect, it } from "vitest";
import { agrupar, firma, similitud, tambienLoCuentan } from "../src/pipeline/agrupar.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

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
  surprise: null,
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
