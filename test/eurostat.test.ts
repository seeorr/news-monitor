import { describe, expect, it } from "vitest";
import une from "./fixtures/eurostat-une-ea21.json" with { type: "json" };
import vacio from "./fixtures/eurostat-une-ea20-vacio.json" with { type: "json" };
import sinFiltrar from "./fixtures/eurostat-trtu-sin-filtrar.json" with { type: "json" };
import pib from "./fixtures/eurostat-gdp-ea21.json" with { type: "json" };
import {
  agregadoZonaEuro,
  comoFecha,
  DATASETS,
  EurostatError,
  parseSerie,
  toEvent,
} from "../src/sources/eurostat.ts";
import { NormalizedEvent } from "../src/schema/event.ts";
import { formatAlert } from "../src/notify/telegram.ts";
import type { Scoring } from "../src/ai/cascade.ts";

const paro = DATASETS["une_rt_m"]!;
const gdp = DATASETS["namq_10_gdp"]!;
const ventas = DATASETS["sts_trtu_m"]!;
const retrievedAt = "2026-09-09T10:00:00.000Z";

/**
 * Los cuatro fixtures son respuestas reales de la API, guardadas el 9 de
 * septiembre de 2026. Ninguno está retocado: si Eurostat cambia la forma de la
 * respuesta, estos tests dejan de describir la realidad y hay que volver a
 * capturarlos, no ajustarlos a mano.
 */
describe("Eurostat · lectura de JSON-stat", () => {
  it("lee la serie con el índice plano y la devuelve más reciente primero", () => {
    const obs = parseSerie(une, paro);
    expect(obs[0]?.periodo).toBe("2026-07");
    expect(obs[0]?.value).toBe(6.4);
    expect(obs.at(-1)?.periodo).toBe("2026-01");
  });

  /**
   * El caso que rompe el atajo: la respuesta trae ocho periodos y solo siete
   * valores, porque el agregado de la zona euro va un mes por detrás de los
   * países sueltos. Si el código emparejara por posición contando desde el
   * final, el 6,4 de julio se leería como el dato de agosto: un dato correcto
   * con la fecha equivocada, que es peor que ninguno.
   */
  it("no corre los valores cuando el periodo más nuevo todavía no tiene dato", () => {
    expect(Object.keys(une.dimension.time.category.index)).toHaveLength(8);
    expect(Object.keys(une.value)).toHaveLength(7);
    const obs = parseSerie(une, paro);
    expect(obs).toHaveLength(7);
    expect(obs.map((o) => o.periodo)).not.toContain("2026-08");
  });

  it("nombra el periodo con la convención de fechas que ya usa FRED", () => {
    expect(comoFecha("2026-07")).toBe("2026-07-01");
    expect(comoFecha("2026-Q1")).toBe("2026-01-01");
    expect(comoFecha("2026-Q2")).toBe("2026-04-01");
    expect(comoFecha("2026-Q4")).toBe("2026-10-01");
    // Lo que ya es una fecha se queda como está: no se reinterpreta nada.
    expect(comoFecha("2026-07-15")).toBe("2026-07-15");
  });
});

/**
 * La trampa. Eurostat responde 200 a una consulta que no vigila nada, con la
 * dimensión a tamaño 0 y el resto de la respuesta impecable. Sin esta
 * comprobación no hay error, no hay excepción y no hay nada en el log.
 */
describe("Eurostat · el vacío es un fallo, no un resultado", () => {
  it("falla con su código cuando la consulta devuelve cero filas", () => {
    // Es la respuesta real de pedir EA20 hoy —y la que devolverá EA21 el día que
    // entre el país 22—: 200, ocho periodos y una dimensión geo de tamaño 0.
    expect(vacio.size[5]).toBe(0);
    expect(Object.keys(vacio.value)).toHaveLength(0);

    expect(() => parseSerie(vacio, paro)).toThrow(EurostatError);
    try {
      parseSerie(vacio, paro);
      expect.unreachable("tenía que lanzar");
    } catch (err) {
      expect((err as EurostatError).code).toBe("EUROSTAT_EMPTY");
    }
  });

  /**
   * El otro modo de fallo silencioso, y este apareció de verdad al integrar:
   * `indic_bt=TOVT` no existe en `sts_trtu_m`, así que la dimensión venía a 0 y
   * la serie salía vacía con un 200. El fixture es la misma consulta sin filtrar
   * esa dimensión, que es como se descubrió cuáles son los códigos buenos.
   */
  it("falla cuando una dimensión se queda sin filtrar, en vez de leer valores corridos", () => {
    expect(sinFiltrar.size[1]).toBe(2);
    try {
      parseSerie(sinFiltrar, ventas);
      expect.unreachable("tenía que lanzar");
    } catch (err) {
      expect((err as EurostatError).code).toBe("EUROSTAT_DIMENSION");
    }
  });

  it("no deja pasar una respuesta sin forma reconocible", () => {
    try {
      parseSerie({ value: { "0": 1 } }, paro);
      expect.unreachable("tenía que lanzar");
    } catch (err) {
      expect((err as EurostatError).code).toBe("EUROSTAT_SHAPE");
    }
  });

  it("el mensaje del error no acaba en el log: solo su código", () => {
    const err = new EurostatError("EUROSTAT_EMPTY", "detalle interno");
    // El logger lee `code` como propiedad propia y jamás serializa el mensaje.
    expect(Object.getOwnPropertyDescriptor(err, "code")?.value).toBe("EUROSTAT_EMPTY");
  });
});

/**
 * El agregado se resuelve por dataset porque cada uno admite unos distintos.
 * Las cuatro listas son las que devolvieron los datasets reales el 9 de
 * septiembre de 2026.
 */
describe("Eurostat · el agregado se resuelve por dataset", () => {
  it("elige EA21 donde es el único agregado (une_rt_m)", () => {
    expect(agregadoZonaEuro(["EU27_2020", "EA21", "BE", "DE", "ES", "FR", "US", "JP"])).toBe("EA21");
  });

  it("elige el más amplio cuando el dataset ofrece varios (namq_10_gdp)", () => {
    expect(agregadoZonaEuro(["EA", "EA21", "EA20", "EA19", "EA12", "DE"])).toBe("EA21");
  });

  /**
   * La prueba de que una constante global estaría mal desde el primer día:
   * `prc_hicp_manr` no tiene EA21. Fijar EA21 en todas partes devolvería cero
   * filas aquí, con un 200 y sin una línea en el log.
   */
  it("elige EA20 en un dataset que no tiene EA21 (prc_hicp_manr)", () => {
    expect(agregadoZonaEuro(["EA", "EA20", "EA19", "DE", "ES"])).toBe("EA20");
  });

  /**
   * El día que entre el país 22. La lista no la escribimos nosotros: la publica
   * el dataset, así que `EA22` aparecerá solo y la regla lo elegirá sin tocar
   * una línea de código. Es lo que hace que esto no envejezca en silencio.
   */
  it("elegirá EA22 el día que el dataset lo publique, sin cambiar nada", () => {
    expect(agregadoZonaEuro(["EA", "EA22", "EA21", "EA20", "DE"])).toBe("EA22");
  });

  it("EA a secas solo gana si no hay ningún numerado", () => {
    expect(agregadoZonaEuro(["EA", "DE", "FR"])).toBe("EA");
  });

  it("falla en voz alta si el dataset se queda sin agregado de zona euro", () => {
    try {
      agregadoZonaEuro(["EU27_2020", "DE", "FR", "ES"]);
      expect.unreachable("tenía que lanzar");
    } catch (err) {
      expect((err as EurostatError).code).toBe("EUROSTAT_NO_AGGREGATE");
    }
    // Y un dataset que no declara ningún geo tampoco cuela por parecido.
    expect(() => agregadoZonaEuro([])).toThrow(EurostatError);
  });
});

describe("Eurostat · evento normalizado", () => {
  const evento = toEvent(parseSerie(une, paro), paro, { geo: "EA21", retrievedAt });

  it("cumple el mismo contrato que las demás fuentes", () => {
    expect(() => NormalizedEvent.parse(evento)).not.toThrow();
    expect(evento.source).toBe("eurostat");
    expect(evento.kind).toBe("macro_release");
    expect(evento.official).toBe(true);
    expect(evento.country).toBe("🇪🇺");
  });

  it("separa la fecha del dato de la de obtención", () => {
    expect(evento.observed_at).toBe("2026-07-01");
    expect(evento.retrieved_at).toBe(retrievedAt);
  });

  /**
   * El id no lleva el agregado. Si lo llevara, el día que `EA21` pase a `EA22`
   * la serie se partiría en dos y el primer dato del agregado nuevo se
   * anunciaría como si fuera otra cosa.
   */
  it("da el mismo id a la misma observación aunque cambie el agregado", () => {
    const con22 = toEvent(parseSerie(une, paro), paro, { geo: "EA22", retrievedAt });
    expect(con22.id).toBe(evento.id);
    expect(evento.id).toBe("eurostat:une_rt_m:2026-07-01");
    // Pero la consulta que se hizo de verdad sí queda registrada.
    expect(evento.source_url).toContain("geo=EA21");
    expect(con22.source_url).toContain("geo=EA22");
  });

  it("no finge un consenso que Eurostat tampoco publica", () => {
    expect(evento.consensus).toBeNull();
    expect(evento.surprises.map((s) => s.basis)).not.toContain("consensus");
  });

  /**
   * Un dato europeo llega a la alerta con sus dos bases, exactamente igual que
   * uno americano: la sorpresa la calcula la misma función para las dos fuentes.
   */
  it("trae las dos sorpresas sobre un dato europeo real", () => {
    const pibEvento = toEvent(parseSerie(pib, gdp), gdp, { geo: "EA21", retrievedAt });
    expect(pibEvento.actual).toBe(0.6);
    expect(pibEvento.previous).toBe(0);
    expect(pibEvento.surprises.map((s) => s.basis)).toEqual(["previous", "mean_3m"]);
    expect(pibEvento.surprises[0]?.value).toBeCloseTo(0.6, 2);
    // Media de 2026-Q1, 2025-Q4 y 2025-Q3: (0 + 0,2 + 0,3) / 3 = 0,17.
    expect(pibEvento.surprises[1]?.value).toBeCloseTo(0.43, 2);
  });

  it("se escribe en la alerta con la misma función que un dato de FRED", () => {
    const pibEvento = toEvent(parseSerie(pib, gdp), gdp, { geo: "EA21", retrievedAt });
    const scoring: Scoring = {
      importance_score: 8,
      market_impact_score: 7,
      sentiment: "bullish",
      needs_alert: true,
      one_liner: "El PIB acelera.",
    };
    const texto = formatAlert(pibEvento, scoring, null);
    expect(texto).toContain("Sorpresa: +0,6 pp (vs anterior) · +0,4 pp (vs media 3m)");
  });

  it("marca stale cuando el dato lleva demasiado tiempo sin renovarse", () => {
    const tarde = toEvent(parseSerie(une, paro), paro, {
      geo: "EA21",
      retrievedAt,
      ahora: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(tarde.stale).toBe(true);
    expect(evento.stale).toBe(false);
  });

  it("no acepta una serie vacía ni siquiera por la puerta de atrás", () => {
    expect(() => toEvent([], paro, { geo: "EA21", retrievedAt })).toThrow(EurostatError);
  });
});

/**
 * El registro es la única superficie que hay que tocar para añadir una serie
 * europea, así que sus invariantes se comprueban aquí y no en cada consulta.
 */
describe("Eurostat · registro de datasets", () => {
  it("filtra todas las dimensiones que no son geo ni tiempo", () => {
    for (const spec of Object.values(DATASETS)) {
      expect(Object.keys(spec.filtros).length).toBeGreaterThan(0);
      expect(spec.filtros["geo"]).toBeUndefined();
      expect(spec.filtros["time"]).toBeUndefined();
    }
  });

  it("pide bastantes periodos para el anterior y la media de 3", () => {
    for (const spec of Object.values(DATASETS)) {
      expect(spec.periodos).toBeGreaterThanOrEqual(4);
    }
  });

  /**
   * Los tres que ya vienen en variación porcentual no llevan ninguna
   * transformación encima: calcular la variación de una variación daría una
   * cifra que no significa nada y que nadie detectaría mirando la pantalla.
   */
  it("pide en variación lo que se publica en variación", () => {
    expect(DATASETS["namq_10_gdp"]?.filtros["unit"]).toBe("CLV_PCH_PRE");
    expect(DATASETS["sts_inpr_m"]?.filtros["unit"]).toBe("PCH_PRE");
    expect(DATASETS["sts_trtu_m"]?.filtros["unit"]).toBe("PCH_PRE");
    expect(DATASETS["une_rt_m"]?.filtros["unit"]).toBe("PC_ACT");
  });
});
