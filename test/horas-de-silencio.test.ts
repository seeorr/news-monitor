import { describe, expect, it } from "vitest";
import { leerHorasDeSilencio, silencioHasta } from "../src/pipeline/horas-de-silencio.ts";

const madrid = { desde: 0, hasta: 8, zona: "Europe/Madrid" };

describe("horas de silencio de los breves", () => {
  it("lee el rango, con valor por defecto y apagado explícito", () => {
    expect(leerHorasDeSilencio(null, null)).toEqual(madrid);
    expect(leerHorasDeSilencio("22-7", "UTC")).toEqual({ desde: 22, hasta: 7, zona: "UTC" });
    expect(leerHorasDeSilencio("none", null)).toBeNull();
  });
  it.each(["8-8", "25-3", "0-24", "0 - 8", "noche"])("rechaza %s al arrancar", (valor) => {
    expect(() => leerHorasDeSilencio(valor, null)).toThrow("invalid_brief_quiet_hours");
  });
  it("rechaza una zona que no existe", () => {
    expect(() => leerHorasDeSilencio("0-8", "Europa/Madriz")).toThrow("invalid_news_timezone");
  });
  it("en verano Madrid es UTC+2: calla de 22:00 a 06:00 UTC", () => {
    expect(silencioHasta("2026-09-15T21:59:00.000Z", madrid)).toBeNull();
    expect(silencioHasta("2026-09-15T22:00:00.000Z", madrid)).toBe("2026-09-16T06:00:00.000Z");
    expect(silencioHasta("2026-09-16T00:04:00.000Z", madrid)).toBe("2026-09-16T06:00:00.000Z");
    expect(silencioHasta("2026-09-16T06:00:00.000Z", madrid)).toBeNull();
  });
  it("en invierno Madrid es UTC+1: el fin se mueve con el cambio de hora", () => {
    expect(silencioHasta("2026-12-10T23:30:00.000Z", madrid)).toBe("2026-12-11T07:00:00.000Z");
    expect(silencioHasta("2026-12-11T06:59:00.000Z", madrid)).toBe("2026-12-11T07:00:00.000Z");
    expect(silencioHasta("2026-12-11T07:00:00.000Z", madrid)).toBeNull();
  });
  it("un rango que cruza la medianoche", () => {
    const s = { desde: 22, hasta: 7, zona: "UTC" };
    expect(silencioHasta("2026-09-15T23:10:00.000Z", s)).toBe("2026-09-16T07:00:00.000Z");
    expect(silencioHasta("2026-09-15T12:00:00.000Z", s)).toBeNull();
  });
  it("sin silencio configurado nunca calla", () => {
    expect(silencioHasta("2026-09-16T00:04:00.000Z", null)).toBeNull();
  });
});
