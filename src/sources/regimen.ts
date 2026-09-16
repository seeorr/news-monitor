import { fetchObservations, type SeriesSpec } from "./fred.ts";
import { round } from "../schema/event.ts";

export interface Observacion { date: string; value: number }
export interface SenalRegimen {
  id: string;
  label: string;
  sourceUrl: string;
  date: string | null;
  value: number | null;
  unit: string;
  stale: boolean;
  vote: -1 | 0 | 1 | null;
  detail: string;
  /** Observaciones utilizadas: permite recalcular el voto y la SMA exacta. */
  observations?: Observacion[];
}
export interface Regimen {
  asOf: string;
  version: string;
  state: "risk_on" | "risk_off" | "mixed" | "insufficient_data";
  signals: SenalRegimen[];
}

// Heurística descriptiva, sin calibración predictiva. El dólar es contexto;
// no se llama DXY porque DTWEXBGS pondera una cesta comercial diferente.
export const VERSION_REGIMEN = "riesgo-us-v1";
export const SERIES_REGIMEN = [
  { id: "VIXCLS", title: "VIX · Cboe", unit: "puntos" },
  { id: "SP500", title: "S&P 500 · S&P DJI", unit: "puntos" },
  { id: "BAMLH0A0HYM2", title: "Spread HY · ICE BofA", unit: "%" },
  { id: "DTWEXBGS", title: "Dólar amplio · Fed", unit: "índice" },
  { id: "NFCI", title: "Condiciones financieras · Fed de Chicago", unit: "índice" },
] as const;
export type IdSerieRegimen = (typeof SERIES_REGIMEN)[number]["id"];
export type DatosRegimen = Partial<Record<IdSerieRegimen, Observacion[]>>;

/**
 * Las que acompañan y no clasifican.
 *
 * La liquidez entra por aquí, con `NFCI`, y no como cuarto voto. Mover una serie
 * de esta lista a la de votos cambia lo que significa la unanimidad: las
 * fotografías ya escritas con `riesgo-us-v1` dejarían de ser comparables con las
 * nuevas aunque la tabla pareciera la misma. Ese día es una versión nueva de la
 * regla, `riesgo-us-v2`, y no un retoque de esta constante.
 *
 * Además `NFCI` es semanal y con retraso, y los tres votos son diarios: dejarle
 * vetar la clasificación de hoy sería dejar que un número de hace doce días
 * decida sobre un mercado que abrió esta mañana.
 */
export const CONTEXTO: ReadonlySet<string> = new Set<IdSerieRegimen>(["DTWEXBGS", "NFCI"]);

/**
 * Margen de frescura en días naturales: admite fin de semana y festivo.
 *
 * El dólar se publica con más retraso. `NFCI` sale los miércoles y se refiere al
 * viernes anterior, así que la víspera de una publicación el último dato ya tiene
 * doce días sin que pase nada raro: con cinco días se marcaría antiguo cada
 * semana y la palabra dejaría de significar nada.
 */
const MARGEN_DIAS: Record<IdSerieRegimen, number> = {
  VIXCLS: 5, SP500: 5, BAMLH0A0HYM2: 5, DTWEXBGS: 10, NFCI: 14,
};

/**
 * Quién puede ser negativo.
 *
 * `NFCI` lo es casi siempre —negativo son condiciones más laxas que la media
 * histórica—, y descartarlo por el signo dejaba la señal vacía todos los días. Un
 * VIX, un precio o un spread negativos son un error de la fuente y se siguen
 * descartando: ahí el signo no es información, es un dato roto.
 */
const ADMITE_NEGATIVOS: ReadonlySet<string> = new Set<IdSerieRegimen>(["NFCI"]);

/** Ordena y elimina fechas inválidas, futuras y duplicadas. No rellena huecos. */
function normalizar(obs: Observacion[], hoy: string, negativos = false): Observacion[] {
  const porDia = new Map<string, Observacion>();
  for (const o of obs) {
    const t = Date.parse(o.date + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !Number.isFinite(t) ||
        new Date(t).toISOString().slice(0, 10) !== o.date || o.date > hoy ||
        !Number.isFinite(o.value) || (o.value < 0 && !negativos)) continue;
    porDia.set(o.date, o);
  }
  return [...porDia.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Calendario regular NYSE. Un cierre extraordinario no conocido deja un hueco
 * y degrada la señal; nunca se rellena ni se cuenta una sesión imaginaria. */
export function esSesionUs(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) return false;
  const holidays = new Set<string>();
  const key = (t: Date) => t.toISOString().slice(0, 10);
  const fixed = (month: number, day: number, saturdayObserved = true) => {
    const t = new Date(Date.UTC(year, month - 1, day));
    if (t.getUTCDay() === 6 && saturdayObserved) t.setUTCDate(t.getUTCDate() - 1);
    if (t.getUTCDay() === 0) t.setUTCDate(t.getUTCDate() + 1);
    holidays.add(key(t));
  };
  const nth = (month: number, weekday: number, n: number) => {
    const t = new Date(Date.UTC(year, month - 1, 1));
    t.setUTCDate(1 + (weekday - t.getUTCDay() + 7) % 7 + 7 * (n - 1));
    holidays.add(key(t));
  };
  // NYSE no observa Año Nuevo el viernes anterior cuando cae en sábado.
  fixed(1, 1, false); nth(1, 1, 3); nth(2, 1, 3);
  const memorial = new Date(Date.UTC(year, 4, 31));
  memorial.setUTCDate(31 - (memorial.getUTCDay() + 6) % 7);
  holidays.add(key(memorial));
  if (year >= 2022) fixed(6, 19);
  fixed(7, 4); nth(9, 1, 1); nth(11, 4, 4); fixed(12, 25);
  // Pascua gregoriana; Viernes Santo es dos días antes.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), n = h + l - 7 * m + 114;
  holidays.add(key(new Date(Date.UTC(year, Math.floor(n / 31) - 1, n % 31 - 1))));
  return !holidays.has(date);
}

function faltanSesiones(ventana: Observacion[]): boolean {
  const inicio = ventana.at(-1)?.date, fin = ventana[0]?.date;
  if (!inicio || !fin) return true;
  const fechas = new Set(ventana.map(o => o.date));
  for (let d = new Date(`${inicio}T00:00:00Z`); d.toISOString().slice(0, 10) <= fin; d.setUTCDate(d.getUTCDate() + 1)) {
    const fecha = d.toISOString().slice(0, 10);
    if (esSesionUs(fecha) && !fechas.has(fecha)) return true;
  }
  return false;
}

export function calcularRegimen(datos: DatosRegimen, now = new Date()): Regimen {
  const hoy = now.toISOString().slice(0, 10);
  const signals: SenalRegimen[] = SERIES_REGIMEN.map((spec) => {
    const serie = normalizar(datos[spec.id] ?? [], hoy, ADMITE_NEGATIVOS.has(spec.id));
    const ultima = serie[0];
    const edad = ultima ? (Date.parse(hoy) - Date.parse(ultima.date)) / 86_400_000 : Infinity;
    const stale = edad > MARGEN_DIAS[spec.id];
    const s: SenalRegimen = {
      id: spec.id, label: spec.title,
      sourceUrl: `https://fred.stlouisfed.org/series/${spec.id}`,
      date: ultima?.date ?? null, value: ultima?.value ?? null,
      unit: spec.unit, stale, vote: null,
      observations: serie.slice(0, spec.id === "SP500" ? 200 : 1),
      detail: !ultima ? "Sin observación válida; fuente no disponible." : "Dato antiguo; no participa en la clasificación.",
    };
    if (!ultima || stale) return s;
    if (spec.id === "VIXCLS") {
      s.vote = ultima.value < 20 ? 1 : ultima.value >= 30 ? -1 : 0;
      s.detail = "Regla VIX: <20 favorable; >=30 adverso; entre ambos, mixto.";
    } else if (spec.id === "BAMLH0A0HYM2") {
      s.vote = ultima.value < 4 ? 1 : ultima.value >= 6 ? -1 : 0;
      s.detail = "Regla spread: <4% favorable; >=6% adverso; entre ambos, mixto.";
    } else if (spec.id === "SP500") {
      // Una SMA200 necesita 200 observaciones distintas y relativamente
      // continuas; 200 precios dispersos durante años no son 200 sesiones.
      const ventana = serie.slice(0, 200);
      const amplitud = ventana[199] ? (Date.parse(ultima.date) - Date.parse(ventana[199].date)) / 86_400_000 : Infinity;
      const salto = ventana.some((o, i) => i > 0 &&
        (Date.parse(ventana[i - 1]!.date) - Date.parse(o.date)) / 86_400_000 > 7);
      if (ventana.length < 200 || amplitud > 400 || salto || faltanSesiones(ventana)) {
        s.detail = "Historia insuficiente o discontinua para una media de 200 sesiones.";
      } else {
        const media = ventana.reduce((a, o) => a + o.value, 0) / 200;
        s.vote = ultima.value > media ? 1 : ultima.value < media ? -1 : 0;
        s.detail = `Media 200 sesiones: ${round(media, 2)} puntos. Cierre por encima: favorable; por debajo: adverso; igual: mixto.`;
      }
    } else if (spec.id === "NFCI") {
      // El signo va escrito porque es contraintuitivo: sin esta frase al lado, la
      // mitad de quien lo lee entiende el número al revés.
      s.detail = "Contexto: condiciones financieras, semanal. Negativo: más laxas que la media histórica; positivo: más restrictivas. No vota.";
    } else {
      s.detail = "Contexto: índice amplio nominal de la Fed; no es DXY y no vota.";
    }
    return s;
  });
  const votos = signals.filter((s) => !CONTEXTO.has(s.id)).map((s) => s.vote);
  const state: Regimen["state"] = votos.some((v) => v === null) ? "insufficient_data"
    : votos.every((v) => v === 1) ? "risk_on"
    : votos.every((v) => v === -1) ? "risk_off" : "mixed";
  return { asOf: now.toISOString(), version: VERSION_REGIMEN, state, signals };
}

export async function fetchRegimen(
  apiKey: string,
  opts: { now?: Date; fetcher?: typeof fetchObservations } = {},
): Promise<Regimen> {
  const datos: DatosRegimen = {};
  const resultados = await Promise.allSettled(SERIES_REGIMEN.map(async (s) => {
    const spec: SeriesSpec = { ...s, country: "US", transform: "level", periodsPerYear: s.id === "NFCI" ? 52 : 252 };
    const obs = await (opts.fetcher ?? fetchObservations)(spec, apiKey, s.id === "SP500" ? 300 : 20);
    return { id: s.id, obs };
  }));
  for (const r of resultados) if (r.status === "fulfilled") datos[r.value.id] = r.value.obs;
  // No se imprime el error de red: podría contener la URL con la API key.
  return calcularRegimen(datos, opts.now);
}

export function formatRegimen(r: Regimen): string {
  const nombres: Record<Regimen["state"], string> = {
    risk_on: "favorable al riesgo", risk_off: "aversión al riesgo",
    mixed: "señales mixtas", insufficient_data: "datos insuficientes",
  };
  return [
    `Régimen US: ${nombres[r.state]} (${r.version}).`,
    "Regla descriptiva: unanimidad de VIX, tendencia y crédito; no es una predicción. El dólar amplio y las condiciones financieras acompañan como contexto y no votan.",
    ...r.signals.map((s) => `${s.label}: ${s.value ?? "sin dato"} ${s.unit} · ${s.date ?? "sin fecha"}${s.stale && s.date ? " · antiguo" : ""}. ${s.detail}\n${s.sourceUrl}`),
  ].join("\n");
}
