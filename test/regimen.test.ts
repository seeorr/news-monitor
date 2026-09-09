import { describe, expect, it } from "vitest";
import { calcularRegimen, esSesionUs, fetchRegimen, formatRegimen, type DatosRegimen } from "../src/sources/regimen.ts";
import { guardarRegimen } from "../src/db/regimen.ts";

const now = new Date("2026-09-09T06:30:00Z");
function datos(): DatosRegimen {
  const sp = [];
  for (let d = new Date("2026-09-08T00:00:00Z"); sp.length < 200; d.setUTCDate(d.getUTCDate() - 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      sp.push({ date: d.toISOString().slice(0, 10), value: sp.length === 0 ? 200 : 100 });
    }
  }
  return {
    VIXCLS: [{date: "2026-09-08", value: 19.99}], SP500: sp,
    BAMLH0A0HYM2: [{date: "2026-09-08", value: 3.99}],
    DTWEXBGS: [{date: "2026-09-04", value: 120}],
  };
}
describe("régimen trazable", () => {
  it("exige las tres señales favorables y calcula SMA200 con sus entradas", () => {
    const r = calcularRegimen(datos(), now);
    expect(r.state).toBe("risk_on");
    expect(r.signals[1]?.detail).toContain("100.5 puntos");
    expect(r.signals[1]?.value).toBe(200);
    expect(r.signals[1]?.date).toBe("2026-09-08");
  });
  it("tres señales adversas dan risk_off, incluyendo límites exactos", () => {
    const d = datos(); d.VIXCLS![0]!.value = 30; d.BAMLH0A0HYM2![0]!.value = 6; d.SP500![0]!.value = 50;
    expect(calcularRegimen(d, now).state).toBe("risk_off");
  });
  it("20 de VIX o 4 de spread son zona mixta, no voto favorable", () => {
    for (const [id, value] of [["VIXCLS", 20], ["BAMLH0A0HYM2", 4]] as const) {
      const d = datos(); d[id]![0]!.value = value;
      expect(calcularRegimen(d, now).state).toBe("mixed");
    }
  });
  it("una señal contraria impide declarar unanimidad", () => {
    const d = datos(); d.VIXCLS![0]!.value = 35;
    expect(calcularRegimen(d, now).state).toBe("mixed");
  });
  it("no llama neutral a una fuente caída", () => {
    const d = datos(); delete d.VIXCLS;
    expect(calcularRegimen(d, now).state).toBe("insufficient_data");
    expect(calcularRegimen(d, now).signals[0]?.value).toBeNull();
  });
  it("fin de semana y festivo no caducan la señal; seis días sí", () => {
    const d = datos(); d.VIXCLS![0]!.date = "2026-09-04";
    expect(calcularRegimen(d, now).state).toBe("risk_on");
    d.VIXCLS![0]!.date = "2026-09-03";
    expect(calcularRegimen(d, now).state).toBe("insufficient_data");
  });
  it("199 sesiones no se presentan como SMA200", () => {
    const d = datos(); d.SP500!.pop();
    expect(calcularRegimen(d, now).signals[1]?.vote).toBeNull();
  });
  it("rechaza historia discontinua aunque haya 200 filas", () => {
    const d = datos(); d.SP500![199]!.date = "2020-01-01";
    expect(calcularRegimen(d, now).signals[1]?.vote).toBeNull();
  });
  it("no confunde un festivo NYSE con una sesión perdida", () => {
    expect(esSesionUs("2026-09-07")).toBe(false);
    expect(esSesionUs("2026-04-03")).toBe(false);
    expect(esSesionUs("2026-06-19")).toBe(false);
    expect(esSesionUs("2026-07-03")).toBe(false);
    expect(esSesionUs("2026-09-08")).toBe(true);
    expect(esSesionUs("2021-12-31")).toBe(true);
  });
  it("una sesión intermedia ausente invalida la media aunque se conserven 200 precios", () => {
    const d = datos();
    d.SP500 = d.SP500!.filter(o => o.date !== "2026-09-02");
    d.SP500.push({date: "2025-12-02",value:100});
    expect(d.SP500).toHaveLength(200);
    expect(calcularRegimen(d, now).state).toBe("insufficient_data");
  });
  it("fechas futuras, duplicadas y valores no finitos no cambian el cálculo", () => {
    const d = datos();
    d.SP500!.push({...d.SP500![1]!}, {date:"2026-09-10",value:9999}, {date:"2026-09-08",value:NaN});
    d.VIXCLS!.push({date:"2026-02-30",value:32});
    d.SP500!.reverse();
    expect(calcularRegimen(d, now).state).toBe("risk_on");
    expect(calcularRegimen(d, now).signals[1]?.detail).toContain("100.5 puntos");
  });
  it("dólar ausente no se inventa ni se disfraza de DXY", () => {
    const d = datos(); delete d.DTWEXBGS;
    const r = calcularRegimen(d, now);
    expect(r.state).toBe("risk_on");
    expect(r.signals[3]?.value).toBeNull();
    const text = formatRegimen(r);
    expect(text).toContain("Liquidez no cubierta");
    expect(text).toContain("https://fred.stlouisfed.org/series/VIXCLS");
    expect(text).not.toContain("NaN");
  });
  it("una caída HTTP conserva las otras fuentes sin filtrar la API key", async () => {
    const d = datos();
    const r = await fetchRegimen("secreto-falso", { now, fetcher: async (s) => {
      if (s.id === "VIXCLS") throw new Error("https://example.test?api_key=secreto-falso");
      return d[s.id as keyof DatosRegimen]!;
    } });
    expect(r.state).toBe("insufficient_data");
    expect(r.signals[1]?.value).toBe(200);
    expect(JSON.stringify(r)).not.toContain("secreto-falso");
  });
  it("la fotografía SQL guarda entradas y versión y rechaza sobrescrituras antiguas", async () => {
    const r = calcularRegimen(datos(), now);
    let query = ""; let params: unknown[] = [];
    await guardarRegimen(async (s, ...p) => {query = s.join("?"); params = p; return [];}, r);
    expect(query).toContain("on conflict (day) do update");
    expect(query).toContain("market_regimes.as_of < excluded.as_of");
    expect(JSON.parse(params[4] as string)).toEqual(r);
  });
});
