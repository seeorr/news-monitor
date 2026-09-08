/**
 * FRED (Federal Reserve Bank of St. Louis) — la columna vertebral macro.
 *
 * Gratis, sin límite práctico y fuente primaria: cubre CPI, empleo, PIB y yields.
 * Requiere una API key gratuita que no pide tarjeta.
 *
 * FRED devuelve **niveles**, no variaciones. El CPI de la alerta ("3,2 %") es la
 * variación interanual del índice, y aquí se **calcula** a partir de dos
 * observaciones reales. No se aproxima ni se rellena.
 */
import { fetchJson } from "../lib/http.ts";
import {
  computeSurprise,
  eventId,
  round,
  type NormalizedEvent,
} from "../schema/event.ts";

const BASE = "https://api.stlouisfed.org/fred";

export type Transform = "level" | "yoy_pct";

export interface SeriesSpec {
  id: string;
  title: string;
  country: string;
  unit: string;
  transform: Transform;
  /** Observaciones por año: 12 mensual, 4 trimestral, 252 diaria hábil. */
  periodsPerYear: number;
}

/**
 * Registro de series. Añadir una fuente macro nueva es añadir una fila aquí:
 * no toca el pipeline ni el formateador.
 */
export const SERIES: Record<string, SeriesSpec> = {
  CPIAUCSL: {
    id: "CPIAUCSL",
    title: "US CPI",
    country: "🇺🇸",
    unit: "%",
    transform: "yoy_pct",
    periodsPerYear: 12,
  },
  UNRATE: {
    id: "UNRATE",
    title: "US Unemployment Rate",
    country: "🇺🇸",
    unit: "%",
    transform: "level",
    periodsPerYear: 12,
  },
  DGS10: {
    id: "DGS10",
    title: "US 10Y Treasury Yield",
    country: "🇺🇸",
    unit: "%",
    transform: "level",
    periodsPerYear: 252,
  },
};

interface FredObservation {
  date: string;
  value: string;
}
interface FredResponse {
  observations?: FredObservation[];
}

/** Observaciones más recientes primero. Descarta las que FRED marca con "." (sin dato). */
export async function fetchObservations(
  spec: SeriesSpec,
  apiKey: string,
  limit = 20,
): Promise<Array<{ date: string; value: number }>> {
  const url =
    `${BASE}/series/observations?series_id=${encodeURIComponent(spec.id)}` +
    `&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;

  const body = await fetchJson<FredResponse>(url);
  const raw = body.observations ?? [];
  const parsed = raw
    .filter((o) => o.value !== "." && o.value !== "")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value));

  if (parsed.length === 0) {
    throw new Error(`FRED no devolvió ninguna observación con valor para ${spec.id}`);
  }
  return parsed;
}

/** Serie transformada según el spec. Para `yoy_pct` necesita 12 periodos de historia. */
export function applyTransform(
  obs: Array<{ date: string; value: number }>,
  spec: SeriesSpec,
): Array<{ date: string; value: number }> {
  if (spec.transform === "level") return obs;

  const lag = spec.periodsPerYear;
  const out: Array<{ date: string; value: number }> = [];
  for (let i = 0; i + lag < obs.length; i++) {
    const now = obs[i];
    const yearAgo = obs[i + lag];
    if (!now || !yearAgo || yearAgo.value === 0) continue;
    out.push({ date: now.date, value: round((now.value / yearAgo.value - 1) * 100, 2) });
  }
  return out;
}

/**
 * Última observación como evento normalizado.
 * `consensus` llega de fuera (introducido a mano) porque FRED no lo publica.
 */
export function toEvent(
  series: Array<{ date: string; value: number }>,
  spec: SeriesSpec,
  opts: { retrievedAt: string; stale?: boolean; consensus?: number | null } = {
    retrievedAt: new Date().toISOString(),
  },
): NormalizedEvent {
  const latest = series[0];
  if (!latest) throw new Error(`Serie vacía para ${spec.id}`);

  const previous = series[1]?.value ?? null;
  const window = series.slice(1, 4).map((o) => o.value);
  const mean3m =
    window.length === 3 ? round(window.reduce((a, b) => a + b, 0) / window.length, 2) : null;

  const consensus = opts.consensus ?? null;

  return {
    id: eventId("fred", spec.id, latest.date),
    source: "fred",
    source_url: `https://fred.stlouisfed.org/series/${spec.id}`,
    kind: "macro_release",
    title: spec.title,
    country: spec.country,
    series_id: spec.id,
    observed_at: latest.date,
    retrieved_at: opts.retrievedAt,
    actual: latest.value,
    previous,
    consensus,
    unit: spec.unit,
    surprise: computeSurprise(latest.value, { consensus, previous, mean3m }, spec.unit),
    stale: opts.stale ?? false,
    official: true,
  };
}
