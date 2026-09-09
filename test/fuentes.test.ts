import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/lib/feed.ts";
import { FEEDS, toEvents as feedEvents } from "../src/sources/rss.ts";
import {
  companyName,
  etiqueta,
  parseFilings,
  toEvents as filingEvents,
  type Company,
} from "../src/sources/sec-edgar.ts";
import { NormalizedEvent } from "../src/schema/event.ts";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const fed = fixture("fed-press.xml");
const edgar = fixture("edgar-aapl.xml");
const spec = FEEDS["fed-press"]!;
const retrievedAt = "2026-09-08T10:00:00.000Z";

describe("feeds → eventos", () => {
  const eventos = feedEvents(parseFeed(fed), spec, { retrievedAt });

  it("produce eventos que cumplen el contrato", () => {
    expect(eventos).toHaveLength(2);
    for (const e of eventos) expect(() => NormalizedEvent.parse(e)).not.toThrow();
  });

  it("marca la Fed como fuente oficial y la noticia como noticia", () => {
    expect(eventos[0]?.official).toBe(true);
    expect(eventos[0]?.kind).toBe("news");
    expect(eventos[0]?.source).toBe("rss");
  });

  it("separa la fecha de publicación de la de obtención", () => {
    expect(eventos[0]?.observed_at).toBe("2026-09-04T15:00:00.000Z");
    expect(eventos[0]?.retrieved_at).toBe(retrievedAt);
  });

  it("no rellena con ceros las cifras que una noticia no tiene", () => {
    expect(eventos[0]?.actual).toBeNull();
    expect(eventos[0]?.previous).toBeNull();
    expect(eventos[0]?.surprise).toBeNull();
    expect(eventos[0]?.unit).toBeNull();
  });

  // El id es lo que impide reenviar la misma noticia cada media hora.
  it("da el mismo id a la misma noticia y distinto a otra", () => {
    const otraVuelta = feedEvents(parseFeed(fed), spec, { retrievedAt: "2026-09-08T11:00:00Z" });
    expect(otraVuelta[0]?.id).toBe(eventos[0]?.id);
    expect(eventos[1]?.id).not.toBe(eventos[0]?.id);
  });

  // Dos noticias del mismo feed pueden compartir minuto de publicación. Si el id
  // se construyera con la fecha, la segunda se tomaría por duplicada y no se
  // enviaría nunca.
  it("distingue dos elementos publicados en el mismo instante", () => {
    const mismos = [
      { title: "Uno", link: "https://x.test/1", guid: "https://x.test/1", date: "Fri, 4 Sep 2026 15:00:00 GMT", summary: null, raw: "" },
      { title: "Dos", link: "https://x.test/2", guid: "https://x.test/2", date: "Fri, 4 Sep 2026 15:00:00 GMT", summary: null, raw: "" },
    ];
    const [a, b] = feedEvents(mismos, spec, { retrievedAt });
    expect(a?.observed_at).toBe(b?.observed_at);
    expect(a?.id).not.toBe(b?.id);
  });

  it("descarta el elemento sin fecha interpretable en vez de fecharlo hoy", () => {
    const sinFecha = [
      { title: "Sin fecha", link: "https://x.test/3", guid: "g3", date: null, summary: null, raw: "" },
    ];
    expect(feedEvents(sinFecha, spec, { retrievedAt })).toHaveLength(0);
  });
});

describe("SEC EDGAR", () => {
  const company: Company = { cik: "0000320193", ticker: "AAPL", name: "Apple Inc." };
  const filings = parseFilings(edgar);
  const eventos = filingEvents(filings, company, { retrievedAt });

  it("lee los documentos del feed Atom", () => {
    expect(filings).toHaveLength(4);
    expect(companyName(edgar)).toBe("Apple Inc.");
  });

  // El formulario 4 —compraventas de directivos— llega a diario y no dice nada.
  // Colarlo se comería la cuota de scoring del ciclo con ruido.
  it("deja fuera los formularios que no mueven el precio", () => {
    expect(filings.map((f) => f.formType)).toContain("4");
    expect(eventos).toHaveLength(3);
    expect(eventos.some((e) => / · 4\b/.test(e.title))).toBe(false);
  });

  it("trata la corrección 8-K/A como lo que es: un 8-K", () => {
    expect(eventos.some((e) => e.title.includes("8-K/A"))).toBe(true);
  });

  it("identifica el documento por su número de registro, no por el día", () => {
    const ocho = eventos.find((e) => e.title.includes("8-K/A"))!;
    expect(ocho.id).toBe(`sec-edgar:AAPL:${filings[0]!.accession}`);
    expect(new Set(eventos.map((e) => e.id)).size).toBe(eventos.length);
  });

  it("cumple el contrato y cuenta en el resumen lo que declara el documento", () => {
    for (const e of eventos) expect(() => NormalizedEvent.parse(e)).not.toThrow();
    const conItems = eventos.find((e) => e.summary?.includes("Contenido declarado"));
    expect(conItems?.summary).toContain("Apple Inc. (AAPL)");
    expect(conItems?.official).toBe(true);
    expect(conItems?.kind).toBe("filing");
  });

  // Un "8-K - Current report" puede ser un cambio de auditor o los resultados
  // del trimestre. Lo que los separa es el apartado que declara la empresa, y es
  // la unica via gratuita y oficial de detectar earnings sin calendario de pago.
  it("distingue unos resultados de un documento cualquiera por su apartado", () => {
    const resultados = filings.find((f) => f.items?.includes("2.02"));
    expect(resultados).toBeDefined();
    expect(etiqueta(resultados!)).toBe("resultados");
    expect(etiqueta({ ...resultados!, items: "item 5.02", formType: "8-K" })).toBeNull();
    expect(etiqueta({ ...resultados!, items: null, formType: "10-Q" })).toBe("informe trimestral");
  });

  it("lo dice en el titular, que es lo que se lee en el aviso", () => {
    const conResultados = eventos.find((e) => e.title.includes("resultados"));
    expect(conResultados).toBeDefined();
  });

  it("fecha el evento con el instante en que la SEC lo aceptó", () => {
    expect(eventos[0]?.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
