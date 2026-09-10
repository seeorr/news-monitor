import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fred-agenda.json" with { type: "json" };
import {
  agendaEvent,
  formatAgenda,
  parseAgenda,
  sumarDias,
  RELEASES,
} from "../src/sources/calendario.ts";
import { NormalizedEvent } from "../src/schema/event.ts";

/** La ventana real de la respuesta guardada: 8 al 18 de septiembre de 2026. */
const opts = { desde: "2026-09-08", dias: 10 };
const citas = parseAgenda(fixture, opts);

describe("agenda macro", () => {
  it("saca las citas de verdad de la ventana", () => {
    const porFecha = citas.map((c) => `${c.date} ${c.title}`);
    expect(porFecha).toContain("2026-09-11 IPC de Estados Unidos");
    expect(porFecha).toContain("2026-09-10 Precios de producción (PPI)");
    expect(porFecha).toContain("2026-09-16 Ventas minoristas");
  });

  // Las peticiones de desempleo son semanales: dos jueves en once días.
  it("no se come las citas que se repiten cada semana", () => {
    const paro = citas.filter((c) => c.releaseId === 180).map((c) => c.date);
    expect(paro).toEqual(["2026-09-10", "2026-09-17"]);
  });

  // El caso que estropea una agenda: FRED marca el comunicado del FOMC y los
  // tipos del BCE como publicación de TODOS los días. Anunciarlos a diario es
  // peor que no tener agenda. Sus decisiones ya entran por los feeds de prensa.
  it("descarta lo que aparece casi a diario: no es una cita, es una serie", () => {
    expect(citas.some((c) => c.releaseId === 101)).toBe(false);
    expect(citas.some((c) => c.releaseId === 484)).toBe(false);
  });

  it("ignora las publicaciones que no están en el registro", () => {
    for (const c of citas) expect(RELEASES[c.releaseId]).toBeDefined();
  });

  it("devuelve las citas ordenadas por fecha", () => {
    const fechas = citas.map((c) => c.date);
    expect([...fechas].sort()).toEqual(fechas);
  });

  it("no inventa citas fuera de la ventana", () => {
    for (const c of citas) {
      expect(c.date >= opts.desde).toBe(true);
      expect(c.date <= "2026-09-18").toBe(true);
    }
  });
});

describe("mensaje de la agenda", () => {
  const texto = formatAgenda(citas, opts);

  it("agrupa por día y solo enseña los días con algo", () => {
    expect(texto).toContain("vie 11 sep — 🇺🇸 IPC de Estados Unidos");
    expect(texto).not.toContain("nada previsto");
  });

  // FRED publica el día, no la hora. Decirlo evita la pregunta y evita que
  // alguien —modelo o persona— rellene el hueco con una hora plausible.
  it("declara que no hay hora en vez de inventarse una", () => {
    expect(texto).toContain("FRED publica la fecha, no la hora");
    expect(texto).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("dice claramente cuando no hay nada", () => {
    expect(formatAgenda([], opts)).toContain("Sin publicaciones relevantes");
  });
});

describe("la agenda como evento", () => {
  const event = agendaEvent(citas, { ...opts, retrievedAt: "2026-09-08T06:30:00.000Z" });

  it("cumple el contrato y se identifica por su día", () => {
    expect(() => NormalizedEvent.parse(event)).not.toThrow();
    expect(event.id).toBe("fred:agenda:2026-09-08");
    expect(event.kind).toBe("calendar");
  });

  it("no lleva cifras: es una lista de fechas", () => {
    expect(event.actual).toBeNull();
    expect(event.surprises).toEqual([]);
  });
});

describe("aritmética de días", () => {
  it("suma días sin que el cambio de hora la despiste", () => {
    expect(sumarDias("2026-09-08", 7)).toBe("2026-09-15");
    expect(sumarDias("2026-10-24", 7)).toBe("2026-10-31"); // cambio de hora en Europa
    expect(sumarDias("2026-12-28", 7)).toBe("2027-01-04"); // cambio de año
  });
});
