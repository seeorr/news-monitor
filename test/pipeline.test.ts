import { describe, expect, it } from "vitest";
import { applyRules } from "../src/pipeline/rules.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";
import { computeSurprise, NormalizedEvent } from "../src/schema/event.ts";
import { checkFabrication } from "../src/lib/fabrication.ts";

const base: NormalizedEvent = {
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
  actual: 3.21,
  previous: 3.4,
  consensus: null,
  unit: "%",
  surprise: { value: -0.19, basis: "previous", unit: "%" },
  stale: false,
  official: true,
};

describe("contrato del evento", () => {
  it("valida contra el esquema", () => {
    expect(() => NormalizedEvent.parse(base)).not.toThrow();
  });

  it("rechaza un evento sin los campos que la alerta necesita", () => {
    const roto: Record<string, unknown> = { ...base };
    delete roto["title"];
    expect(() => NormalizedEvent.parse(roto)).toThrow();
  });
});

describe("sorpresa", () => {
  it("prefiere el consenso cuando existe", () => {
    expect(computeSurprise(3.2, { consensus: 3.4, previous: 3.0 }, "%")?.basis).toBe("consensus");
  });
  it("cae al anterior cuando no hay consenso", () => {
    expect(computeSurprise(3.2, { consensus: null, previous: 3.0 }, "%")?.basis).toBe("previous");
  });
  it("devuelve null antes que un cero de relleno", () => {
    expect(computeSurprise(3.2, {}, "%")).toBeNull();
    expect(computeSurprise(null, { previous: 3.0 }, "%")).toBeNull();
  });
});

describe("filtro por reglas", () => {
  it("deja pasar siempre una fuente oficial", () => {
    expect(applyRules(base).pass).toBe(true);
  });

  it("descarta una noticia sin ticker ni keyword macro", () => {
    const ruido = { ...base, official: false, source: "rss" as const, title: "Una empresa abre oficina" };
    const d = applyRules(ruido);
    expect(d.pass).toBe(false);
    expect(d.reason).toContain("sin ticker");
  });

  it("deja pasar una noticia que menciona un ticker de la watchlist", () => {
    const n = { ...base, official: false, source: "rss" as const, title: "NVDA presenta resultados" };
    expect(applyRules(n, { watchlist: ["NVDA"] }).pass).toBe(true);
  });

  it("no confunde un ticker con una subcadena de otra palabra", () => {
    const n = { ...base, official: false, source: "rss" as const, title: "Informe sobre BAKED goods" };
    expect(applyRules(n, { watchlist: ["BA"] }).pass).toBe(false);
  });
});

describe("idempotencia", () => {
  it("no reprocesa una observacion ya vista", async () => {
    const seen = memorySeenStore();
    expect(await seen.has(base.id)).toBe(false);
    await seen.mark(base);
    expect(await seen.has(base.id)).toBe(true);
  });

  it("guardar la alerta marca tambien el evento como procesado", async () => {
    const seen = memorySeenStore();
    await seen.saveAlert(base, {
      importance: 9,
      impact: 8,
      sentiment: "bullish",
      oneLiner: "Frase del paso 3.",
      deep: true,
      body: "cuerpo de la alerta",
    });
    expect(await seen.has(base.id)).toBe(true);
    expect(seen.alerts).toHaveLength(1);
    expect(seen.alerts[0]?.deep).toBe(true);
    // La nota vive tambien en el evento: es lo que deja ordenar por importancia
    // sin quedarse solo con el subconjunto de lo anunciado.
    expect(seen.puntuaciones.get(base.id)?.importance).toBe(9);
  });
});

describe("anti-fabricacion", () => {
  it("acepta prosa cuyas cifras vienen de los datos", () => {
    const r = checkFabrication("El IPC baja a 3,21 % desde 3,4 %.", [3.21, 3.4, null]);
    expect(r.ok).toBe(true);
  });

  it("caza una cifra que el modelo se ha inventado", () => {
    const r = checkFabrication("El desempleo subio al 7,8 % en el trimestre.", [3.21, 3.4]);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("7.8");
  });

  it("no penaliza escalas de puntuacion ni fechas", () => {
    const r = checkFabrication("Importancia 9 de 10. Publicado el 2026-08-01.", [3.21]);
    expect(r.ok).toBe(true);
  });

  // Caso real del 8 de septiembre: con CPI 3,54 y anterior 3,73, el modelo
  // escribio "1,5 puntos por encima del objetivo". La resta es suya, no del dato.
  it("caza una cifra DERIVADA de los datos y no presente en ellos", () => {
    const r = checkFabrication(
      "La inflacion sigue 1,5 puntos por encima del objetivo del 2 %.",
      [3.54, 3.73, null, -0.19],
    );
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toContain("1.5");
  });
});
