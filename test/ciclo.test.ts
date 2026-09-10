import { describe, expect, it } from "vitest";
import { porFecha, recientes } from "../src/pipeline/collect.ts";
import { mereceAlerta } from "../src/pipeline/rules.ts";
import { allowedNumbers, eventFacts } from "../src/ai/cascade.ts";
import { checkFabrication } from "../src/lib/fabrication.ts";
import { formatAlert } from "../src/notify/telegram.ts";
import type { Scoring } from "../src/ai/cascade.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const noticia = (id: string, observedAt: string, title = "El BCE recorta 25 puntos basicos"): NormalizedEvent => ({
  id,
  source: "rss",
  source_url: "https://www.ecb.europa.eu/x",
  kind: "news",
  title,
  summary: "El Consejo de Gobierno baja el tipo de deposito al 2,25 %.",
  country: "🇪🇺",
  series_id: "ecb-press",
  observed_at: observedAt,
  retrieved_at: "2026-09-08T10:00:00.000Z",
  actual: null,
  previous: null,
  consensus: null,
  unit: null,
  surprises: [],
  stale: false,
  official: true,
});

const macro: NormalizedEvent = {
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
  surprises: [{ value: -0.19, basis: "previous", unit: "%" }],
  stale: false,
  official: true,
};

const ahora = new Date("2026-09-08T10:00:00.000Z");

describe("frescura", () => {
  it("deja fuera el titular viejo que el feed sigue publicando", () => {
    const viejas = [noticia("a", "2026-08-01T09:00:00.000Z")];
    expect(recientes(viejas, { now: ahora, maxAgeHours: 72 })).toHaveLength(0);
  });

  it("deja pasar el titular de hoy", () => {
    const hoy = [noticia("b", "2026-09-08T08:00:00.000Z")];
    expect(recientes(hoy, { now: ahora, maxAgeHours: 72 })).toHaveLength(1);
  });

  // El IPC de agosto se publica a mediados de septiembre y lleva fecha del 1 de
  // agosto: es el dato por el que existe el monitor, y un corte por antigüedad
  // aplicado a ciegas lo tiraría siempre.
  it("NO aplica el corte por antiguedad a un dato macro", () => {
    expect(recientes([macro], { now: ahora, maxAgeHours: 72 })).toHaveLength(1);
  });

  it("ordena lo mas reciente primero, que es por donde se reparte el cupo", () => {
    const lista = [
      noticia("vieja", "2026-09-06T08:00:00.000Z"),
      noticia("nueva", "2026-09-08T09:00:00.000Z"),
    ];
    expect(porFecha(lista).map((e) => e.id)).toEqual(["nueva", "vieja"]);
  });
});

describe("lo que ve el modelo", () => {
  it("no le enseña un formulario de cifras vacio a una noticia", () => {
    const facts = eventFacts(noticia("c", "2026-09-08T09:00:00.000Z"));
    expect(facts).toContain("Titular:");
    expect(facts).toContain("Lo que dice la fuente:");
    expect(facts).not.toContain("Actual: n/d");
    expect(facts).toContain("no trae cifras");
  });

  it("mantiene el bloque de cifras del dato macro", () => {
    const facts = eventFacts(macro);
    expect(facts).toContain("Actual: 3.54%");
    expect(facts).toContain("Sorpresa: -0.19");
  });

  // Sin esto, repetir la cifra del propio titular contaba como fabricarla y la
  // alerta se degradaba sin motivo.
  it("permite citar las cifras que estan en el titular o en el resumen", () => {
    const evento = noticia("d", "2026-09-08T09:00:00.000Z");
    const permitidos = allowedNumbers(evento);
    expect(checkFabrication("Recorte de 25 puntos basicos, al 2,25 %.", permitidos).ok).toBe(true);
  });

  it("sigue cazando la cifra que no esta en ninguna parte", () => {
    const evento = noticia("e", "2026-09-08T09:00:00.000Z");
    const r = checkFabrication("El paro subio al 7,8 %.", allowedNumbers(evento));
    expect(r.ok).toBe(false);
  });
});

describe("puerta de la alerta", () => {
  const prensa = { ...noticia("h", "2026-09-08T09:00:00.000Z"), official: false };

  it("anuncia lo que llega al umbral, venga de donde venga", () => {
    expect(mereceAlerta(prensa, { needs_alert: false, importance_score: 8 }, 7)).toBe(true);
  });

  // Con cinco feeds, "needs_alert" del modelo barato se cumple demasiadas veces:
  // cuatro avisos de relleno y se deja de mirar el teléfono.
  it("no anuncia un titular de prensa de 6/10 aunque el modelo lo pida", () => {
    expect(mereceAlerta(prensa, { needs_alert: true, importance_score: 6 }, 7)).toBe(false);
  });

  it("sí lo anuncia si viene de una fuente primaria", () => {
    const oficial = { ...prensa, official: true };
    expect(mereceAlerta(oficial, { needs_alert: true, importance_score: 6 }, 7)).toBe(true);
  });

  it("calla lo que ni llega al umbral ni pide aviso", () => {
    const oficial = { ...prensa, official: true };
    expect(mereceAlerta(oficial, { needs_alert: false, importance_score: 3 }, 7)).toBe(false);
  });
});

describe("alerta de una noticia", () => {
  const scoring: Scoring = {
    importance_score: 8,
    sentiment: "bullish",
    market_impact_score: 7,
    needs_alert: true,
    one_liner: "El BCE recorta tipos.",
  };

  it("no imprime cifras que la noticia no tiene", () => {
    const texto = formatAlert(noticia("f", "2026-09-08T09:00:00.000Z"), scoring, null);
    expect(texto).not.toContain("Actual:");
    expect(texto).not.toContain("null");
    expect(texto).not.toContain("NaN");
  });

  it("dice publicado, no dato de, y con la hora en UTC", () => {
    const texto = formatAlert(noticia("g", "2026-09-08T09:00:00.000Z"), scoring, null);
    expect(texto).toContain("publicado 2026-09-08 09:00 UTC");
  });

  it("al dato macro le sigue diciendo dato de, con su fecha tal cual", () => {
    const texto = formatAlert(macro, scoring, null);
    expect(texto).toContain("dato de 2026-08-01");
  });
});
