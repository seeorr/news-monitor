import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { calcularRegimen, type DatosRegimen, type Regimen } from "../src/sources/regimen.ts";

/**
 * `/regime` se pinta de verdad, no una copia de su condición.
 *
 * Lo que se comprueba es lo que la página no puede contradecir: que la liquidez
 * aparece como contexto y nunca como voto, que `insufficient_data` se enseña
 * como un estado y diciendo cuál falta, que un dato antiguo se marca en vez de
 * dejar la casilla vacía, y que la explicación del voto es la del backend.
 */
const foto = vi.hoisted(() => ({ regimen: null as Regimen | null }));
vi.mock("../src/db/regimen.ts", () => ({ ultimoRegimen: async () => foto.regimen }));
process.env["DATABASE_URL"] = "postgres://usuario:clave@ejemplo.test/base";

const { default: PaginaRegimen } = await import("../app/regime/page.tsx");
const ahora = new Date("2026-09-09T06:30:00Z");

function datos(): DatosRegimen {
  const sp = [];
  for (let d = new Date("2026-09-08T00:00:00Z"); sp.length < 200; d.setUTCDate(d.getUTCDate() - 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      sp.push({ date: d.toISOString().slice(0, 10), value: sp.length === 0 ? 200 : 100 });
    }
  }
  return {
    VIXCLS: [{ date: "2026-09-08", value: 19.99 }],
    SP500: sp,
    BAMLH0A0HYM2: [{ date: "2026-09-08", value: 3.99 }],
    DTWEXBGS: [{ date: "2026-09-04", value: 120 }],
    NFCI: [{ date: "2026-09-04", value: -0.53 }],
  };
}

async function pintar(regimen: Regimen | null): Promise<string> {
  foto.regimen = regimen;
  return renderToStaticMarkup(await PaginaRegimen());
}

describe("la página del régimen enseña las entradas, no una conclusión suelta", () => {
  it("la liquidez sale como contexto, con su signo, y fuera de la tabla que vota", async () => {
    const html = await pintar(calcularRegimen(datos(), ahora));
    expect(html).toContain("Favorable al riesgo");
    expect(html).toContain("riesgo-us-v1");
    expect(html).toContain("Condiciones financieras");
    expect(html).toContain("-0,53");
    expect(html).toContain("Negativo: más laxas");
    expect(html).toContain("acompañan y no clasifican");
    // El contexto no aporta un voto en ninguna de sus formas.
    expect(html).not.toContain("NFCI</a>");
    const votan = html.slice(html.indexOf("Votan"), html.indexOf("Contexto"));
    expect(votan).not.toContain("Condiciones financieras");
  });

  it("no llama DXY al dólar amplio: solo aparece para negarlo", async () => {
    const html = await pintar(calcularRegimen(datos(), ahora));
    expect(html).toContain("Dólar amplio");
    // La única mención permitida es la del backend, que existe justamente para
    // que nadie confunda DTWEXBGS con el DXY. Como nombre de la serie, nunca.
    expect(html.match(/DXY/g)).toHaveLength(1);
    expect(html).toContain("no es DXY y no vota");
  });

  it("datos insuficientes es un estado, y dice cuál falta", async () => {
    const d = datos();
    delete d.VIXCLS;
    const html = await pintar(calcularRegimen(d, ahora));
    expect(html).toContain("Datos insuficientes");
    expect(html).toContain("Ahora falta el voto de");
    expect(html).toContain("VIX");
    expect(html).toContain("Sin observación válida");
  });

  it("un dato antiguo se marca en vez de dejar la casilla en blanco", async () => {
    const d = datos();
    d.DTWEXBGS![0]!.date = "2026-08-20";
    const html = await pintar(calcularRegimen(d, ahora));
    expect(html).toContain("antiguo");
    expect(html).toContain("2026-08-20");
  });

  it("sin fotografía lo dice, y no inventa un estado neutro", async () => {
    const html = await pintar(null);
    expect(html).toContain("Todavía no hay ninguna fotografía");
    expect(html).not.toContain("Señales mixtas");
  });

  it("la explicación del voto es la del backend, palabra por palabra", async () => {
    const r = calcularRegimen(datos(), ahora);
    const html = await pintar(r);
    // Tal cual, salvo el escapado del HTML: las reglas del VIX y del spread
    // llevan `<` y `>` dentro.
    const escapar = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const senal of r.signals) expect(html).toContain(escapar(senal.detail));
  });
});
