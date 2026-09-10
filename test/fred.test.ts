import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fred-cpiaucsl.json" with { type: "json" };
import { applyTransform, SERIES, toEvent } from "../src/sources/fred.ts";

const spec = SERIES["CPIAUCSL"]!;

/** El parseo que haría fetchObservations, sin tocar la red. */
function parse(obs: Array<{ date: string; value: string }>) {
  return obs
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: Number(o.value) }));
}

describe("FRED", () => {
  it("descarta las observaciones sin dato en vez de tratarlas como cero", () => {
    const parsed = parse(fixture.observations);
    expect(parsed).toHaveLength(15);
    expect(parsed.some((o) => o.date === "2025-06-01")).toBe(false);
    expect(parsed.every((o) => Number.isFinite(o.value))).toBe(true);
  });

  it("calcula la variación interanual, no devuelve el índice en bruto", () => {
    const series = applyTransform(parse(fixture.observations), spec);
    const latest = series[0]!;
    expect(latest.date).toBe("2026-08-01");
    // 325.100 / 315.000 - 1 = 3,206... %
    expect(latest.value).toBeCloseTo(3.21, 2);
  });

  it("no inventa periodos cuando falta historia para el interanual", () => {
    const corto = parse(fixture.observations).slice(0, 5);
    expect(applyTransform(corto, spec)).toHaveLength(0);
  });

  it("mantiene separadas la fecha del dato y la de obtención", () => {
    const series = applyTransform(parse(fixture.observations), spec);
    const event = toEvent(series, spec, { retrievedAt: "2026-09-08T10:00:00.000Z" });
    expect(event.observed_at).toBe("2026-08-01");
    expect(event.retrieved_at).toBe("2026-09-08T10:00:00.000Z");
    expect(event.observed_at).not.toBe(event.retrieved_at);
  });

  it("declara la base de la sorpresa y no la finge cuando no hay consenso", () => {
    const series = applyTransform(parse(fixture.observations), spec);
    const event = toEvent(series, spec, { retrievedAt: "2026-09-08T10:00:00.000Z" });
    expect(event.consensus).toBeNull();
    // Este fixture tiene 15 observaciones del índice, así que el interanual solo
    // da 3 periodos y la media de 3 meses **no se puede calcular**: haría falta
    // un cuarto. Sale una sola sorpresa, y esa es la respuesta correcta: se
    // calculan todas las bases disponibles, no se rellenan las que no lo están.
    expect(event.surprises.map((s) => s.basis)).toEqual(["previous"]);
  });

  it("usa el consenso cuando alguien lo ha introducido a mano, y no tira las demás", () => {
    const series = applyTransform(parse(fixture.observations), spec);
    const event = toEvent(series, spec, { retrievedAt: "2026-09-08T10:00:00.000Z", consensus: 3.4 });
    expect(event.surprises.map((s) => s.basis)).toEqual(["consensus", "previous"]);
    // El consenso primero: es la mejor base y por eso encabeza la lista.
    expect(event.surprises[0]?.value).toBeCloseTo(-0.19, 2);
  });

  /**
   * Las dos series europeas que entran por FRED. Son una fila del registro y no
   * un camino aparte, y esto lo comprueba: el IPC de la zona euro se transforma
   * como el americano y el tipo del BCE se lee como nivel.
   */
  it("trata el IPC de la zona euro como índice a transformar, no como porcentaje", () => {
    const euro = SERIES["CP0000EZCCM086NEST"]!;
    expect(euro.transform).toBe("yoy_pct");
    expect(euro.periodsPerYear).toBe(12);
    expect(euro.country).toBe("🇪🇺");
    // La de composición variable, no la de 19 países: la zona euro cambia de
    // miembros y una serie de composición fija envejece sola.
    expect(euro.id).toContain("EZCC");
  });

  it("lee el tipo de depósito del BCE como nivel diario", () => {
    const bce = SERIES["ECBDFR"]!;
    expect(bce.transform).toBe("level");
    expect(bce.periodsPerYear).toBe(252);
    expect(bce.unit).toBe("%");
  });

  it("genera ids deterministas: la misma observación no puede alertar dos veces", () => {
    const series = applyTransform(parse(fixture.observations), spec);
    const a = toEvent(series, spec, { retrievedAt: "2026-09-08T10:00:00.000Z" });
    const b = toEvent(series, spec, { retrievedAt: "2026-09-09T23:59:00.000Z" });
    expect(a.id).toBe(b.id);
  });
});
