/**
 * Precios — la cuarta fuente, y la única que no publica nadie: la calcula el
 * mercado a cada segundo.
 *
 * Yahoo, con `fetch` y sin clave. Es la decisión heredada de Portfolio
 * Intelligence: cobertura mundial a coste cero. A cambio **no es una API
 * oficial, no tiene SLA y puede romperse sin avisar**, así que aquí un fallo de
 * Yahoo no puede ser más que una fuente caída: el ciclo sigue sin ella.
 *
 * Solo se convierte en evento la sesión que se sale de lo normal. Un valor que
 * cierra un 0,3 % arriba no es noticia, y anunciarlo cada tarde es la forma más
 * rápida de que alguien silencie el bot.
 */
import { fetchJson, type RetryOptions } from "../lib/http.ts";
import { eventId, round, type NormalizedEvent } from "../schema/event.ts";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface Cotizacion {
  symbol: string;
  currency: string | null;
  /** Último cierre conocido (o el precio vivo si la sesión está abierta). */
  price: number;
  /** Cierre anterior, que es contra lo que se mide la variación. */
  previousClose: number;
  /** Día de la sesión, en UTC. Es lo que hace idempotente el evento. */
  sessionDate: string;
}

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: { description?: string } | null;
  };
}

export async function fetchCotizacion(
  symbol: string,
  opts: RetryOptions = {},
): Promise<Cotizacion> {
  const url = `${BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  return parseCotizacion(await fetchJson<ChartResponse>(url, opts), symbol);
}

/**
 * Función pura sobre la respuesta de Yahoo.
 *
 * Se cogen los dos últimos cierres **reales**: la serie trae huecos (`null`) en
 * los festivos, y tomar el penúltimo elemento a ciegas compara el lunes contra
 * un día que no existió.
 */
export function parseCotizacion(body: ChartResponse, symbol: string): Cotizacion {
  const result = body.chart?.result?.[0];
  if (!result) {
    const detalle = body.chart?.error?.description ?? "sin resultado";
    throw new Error(`Yahoo no devolvió datos para ${symbol}: ${detalle}`);
  }

  const meta = result.meta ?? {};
  const cierres = result.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result.timestamp ?? [];

  const validos: Array<{ t: number; c: number }> = [];
  for (let i = 0; i < cierres.length; i++) {
    const c = cierres[i];
    const t = timestamps[i];
    if (typeof c === "number" && Number.isFinite(c) && typeof t === "number") validos.push({ t, c });
  }

  const ultimo = validos.at(-1);
  if (!ultimo) throw new Error(`Yahoo devolvió la serie de ${symbol} sin ningún cierre válido`);

  const previo = validos.at(-2)?.c ?? meta.chartPreviousClose ?? meta.previousClose;
  if (previo === undefined || !Number.isFinite(previo) || previo === 0) {
    throw new Error(`Sin cierre anterior con el que comparar ${symbol}`);
  }

  return {
    symbol: meta.symbol ?? symbol,
    currency: meta.currency ?? null,
    price: meta.regularMarketPrice ?? ultimo.c,
    previousClose: previo,
    sessionDate: new Date(ultimo.t * 1000).toISOString().slice(0, 10),
  };
}

/**
 * Serie diaria de cierres, para lo que necesita historia: medias móviles,
 * niveles de volatilidad. Misma llamada, otra ventana.
 */
export async function fetchSerie(
  symbol: string,
  opts: RetryOptions & { range?: string } = {},
): Promise<Array<{ date: string; close: number }>> {
  const url = `${BASE}/${encodeURIComponent(symbol)}?range=${opts.range ?? "1y"}&interval=1d`;
  return parseSerie(await fetchJson<ChartResponse>(url, opts), symbol);
}

/** Cierres válidos, en orden. Los huecos de los festivos se descartan, no se rellenan. */
export function parseSerie(
  body: ChartResponse,
  symbol: string,
): Array<{ date: string; close: number }> {
  const result = body.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo no devolvió datos para ${symbol}`);

  const cierres = result.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result.timestamp ?? [];
  const serie: Array<{ date: string; close: number }> = [];

  for (let i = 0; i < cierres.length; i++) {
    const c = cierres[i];
    const t = timestamps[i];
    if (typeof c === "number" && Number.isFinite(c) && typeof t === "number") {
      serie.push({ date: new Date(t * 1000).toISOString().slice(0, 10), close: c });
    }
  }
  if (serie.length === 0) throw new Error(`La serie de ${symbol} no trae ningún cierre válido`);
  return serie;
}

/**
 * Media móvil de los últimos `periodos` cierres.
 *
 * Devuelve null si no hay historia suficiente. Calcularla con menos datos de los
 * que pide daría un número con el nombre equivocado: una media de 200 sesiones
 * hecha con 40 no es una media de 200 sesiones.
 */
export function media(serie: Array<{ close: number }>, periodos: number): number | null {
  if (serie.length < periodos) return null;
  const ventana = serie.slice(-periodos);
  return round(ventana.reduce((a, b) => a + b.close, 0) / periodos, 2);
}

/** Variación de la sesión, en porcentaje. */
export function variacion(c: Cotizacion): number {
  return round((c.price / c.previousClose - 1) * 100, 2);
}

/**
 * La sesión como evento, **solo si se sale del umbral** de esa acción.
 *
 * El umbral es por valor y no global: una utility que se mueve un 3 % ha pasado
 * algo, y una biotecnológica que se mueve un 3 % es un martes cualquiera.
 */
export function toEvent(
  c: Cotizacion,
  opts: { ticker: string; nombre?: string | null; umbral: number; retrievedAt: string },
): NormalizedEvent | null {
  const cambio = variacion(c);
  if (Math.abs(cambio) < opts.umbral) return null;

  const signo = cambio > 0 ? "+" : "";
  const nombre = opts.nombre ? `${opts.nombre} (${opts.ticker})` : opts.ticker;

  return {
    // Un evento por valor y sesión: el cron pasa cada quince minutos y la sesión
    // sigue moviéndose, pero la noticia —"hoy se ha movido"— es una sola.
    id: eventId("yahoo", opts.ticker, c.sessionDate),
    source: "yahoo",
    source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(c.symbol)}`,
    kind: "market_move",
    title: `${opts.ticker} ${signo}${cambio.toFixed(2).replace(".", ",")} % en la sesión`,
    summary:
      `${nombre} cotiza a ${c.price} ${c.currency ?? ""} frente a un cierre anterior de ` +
      `${c.previousClose}. Movimiento de la sesion del ${cambio} %, por encima del umbral ` +
      `de ${opts.umbral} % fijado para este valor.`,
    country: "🌐",
    series_id: opts.ticker,
    observed_at: c.sessionDate,
    retrieved_at: opts.retrievedAt,

    actual: cambio,
    previous: null,
    consensus: null,
    unit: "%",
    surprise: null,

    stale: false,
    // Yahoo no es fuente oficial y no tiene SLA: pasa por el filtro como prensa.
    official: false,
  };
}
