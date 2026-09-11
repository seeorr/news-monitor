import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config.ts";

/**
 * Una configuración inválida tiene que **fallar al arrancar**.
 *
 * El defecto que abre este archivo: cinco variables numéricas se leían con un
 * `Number()` pelado y sin comprobar nada. `ALERT_THRESHOLD=abc` daba `NaN`, y
 * `NaN` hace falsa **toda** comparación —`score >= NaN` no se cumple nunca—, así
 * que el sistema dejaba de anunciar sin un solo error en el registro. Un fallo de
 * configuración que se manifiesta como silencio es el peor de todos: se parece
 * exactamente a que no hay noticias que contar.
 */

const VARIABLES = [
  "MAX_ITEM_AGE_HOURS", "AGENDA_DIAS", "GROUP_THRESHOLD",
  "DEEP_ANALYSIS_THRESHOLD", "ALERT_THRESHOLD",
  "BRIEF_NEWS_PER_HOUR", "BRIEF_NEWS_PER_DAY",
  "IMPORTANT_NEWS_PER_HOUR", "IMPORTANT_NEWS_PER_DAY",
] as const;

afterEach(() => {
  for (const nombre of VARIABLES) delete process.env[nombre];
});

describe("las cinco variables que no se validaban", () => {
  it("basura no se convierte en NaN en silencio: revienta al cargar", () => {
    for (const nombre of ["MAX_ITEM_AGE_HOURS", "AGENDA_DIAS", "GROUP_THRESHOLD",
      "DEEP_ANALYSIS_THRESHOLD", "ALERT_THRESHOLD"]) {
      process.env[nombre] = "abc";
      // El mensaje dice **cuál**: sin el nombre, quien despliega tiene que ir
      // probando variables una a una para encontrar la que escribió mal.
      expect(() => loadConfig(), nombre).toThrow(new RegExp(`invalid_bounded_configuration:${nombre}`));
      delete process.env[nombre];
    }
  });

  it("un umbral fuera de la escala real no pasa", () => {
    // Las puntuaciones van de 0 a 10. Un umbral de 40 no es estricto: es un
    // umbral que nada alcanza, y se comporta igual que el NaN de arriba.
    for (const [nombre, valor] of [["ALERT_THRESHOLD", "40"], ["DEEP_ANALYSIS_THRESHOLD", "-1"],
      ["GROUP_THRESHOLD", "1.5"], ["MAX_ITEM_AGE_HOURS", "0"], ["AGENDA_DIAS", "0"]] as const) {
      process.env[nombre] = valor;
      expect(() => loadConfig(), `${nombre}=${valor}`).toThrow(/invalid_bounded_configuration/);
      delete process.env[nombre];
    }
  });

  it("los valores por defecto no cambian", () => {
    const c = loadConfig();
    expect(c.maxItemAgeHours).toBe(72);
    expect(c.agendaDias).toBe(7);
    expect(c.umbralAgrupacion).toBe(0.6);
    expect(c.deepAnalysisThreshold).toBe(7);
    expect(c.alertThreshold).toBe(7);
  });

  it("una fracción legítima sigue entrando", () => {
    // `GROUP_THRESHOLD` y los umbrales admiten decimales a propósito: validar no
    // puede significar convertirlos en enteros por el camino.
    process.env["GROUP_THRESHOLD"] = "0.75";
    process.env["ALERT_THRESHOLD"] = "6.5";
    const c = loadConfig();
    expect(c.umbralAgrupacion).toBe(0.75);
    expect(c.alertThreshold).toBe(6.5);
  });
});

describe("relaciones entre variables", () => {
  it("un techo por hora mayor que el del día es un techo que no se alcanza", () => {
    process.env["BRIEF_NEWS_PER_HOUR"] = "30";
    process.env["BRIEF_NEWS_PER_DAY"] = "24";
    expect(() => validateConfig(loadConfig())).toThrow(/invalid_quota_relation/);

    process.env["BRIEF_NEWS_PER_HOUR"] = "6";
    process.env["IMPORTANT_NEWS_PER_HOUR"] = "20";
    process.env["IMPORTANT_NEWS_PER_DAY"] = "12";
    expect(() => validateConfig(loadConfig())).toThrow(/invalid_quota_relation/);
  });

  it("la configuración por defecto es coherente", () => {
    expect(() => validateConfig(loadConfig())).not.toThrow();
  });

  it("igual no es mayor: un día de una sola hora es legítimo", () => {
    process.env["BRIEF_NEWS_PER_HOUR"] = "24";
    process.env["BRIEF_NEWS_PER_DAY"] = "24";
    expect(() => validateConfig(loadConfig())).not.toThrow();
  });
});
