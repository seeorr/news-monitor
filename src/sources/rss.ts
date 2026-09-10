/**
 * Feeds RSS/Atom — la segunda fuente.
 *
 * FRED da la cifra; el feed da el hecho. Un recorte de tipos, una sanción, un
 * beneficio publicado: nada de eso es una serie temporal, y sin esto el monitor
 * solo ve lo que se publica con calendario.
 *
 * Dos clases de feed, y la diferencia importa porque decide quién pasa el filtro
 * por reglas sin gastar un céntimo de LLM:
 *
 * - **Oficiales** (Fed, BCE, SEC): el emisor es la fuente primaria. Pasan siempre.
 * - **Prensa** (CNBC, Yahoo Finance): pasan solo si mencionan la watchlist o una
 *   palabra macro. Es el 80-90 % que muere en el paso 1 de la cascada.
 */
import { fetchText, type RetryOptions } from "../lib/http.ts";
import { parseFeed, toIso, type FeedItem } from "../lib/feed.ts";
import { itemId, type NormalizedEvent } from "../schema/event.ts";

export interface FeedSpec {
  id: string;
  title: string;
  url: string;
  country: string;
  /** Fuente primaria (banco central, regulador). Pasa el filtro por reglas siempre. */
  official: boolean;
}

/**
 * Registro de feeds. Añadir uno es añadir una fila: no toca el pipeline ni el
 * formateador, igual que con las series de FRED.
 *
 * Ninguno pide clave ni tiene cupo. Los cinco primeros se comprobaron vivos el 8
 * de septiembre de 2026; los tres de Investing, el 10 de septiembre.
 */
export const FEEDS: Record<string, FeedSpec> = {
  "fed-press": {
    id: "fed-press",
    title: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    country: "🇺🇸",
    official: true,
  },
  "ecb-press": {
    id: "ecb-press",
    title: "BCE",
    url: "https://www.ecb.europa.eu/rss/press.html",
    country: "🇪🇺",
    official: true,
  },
  "sec-press": {
    id: "sec-press",
    title: "SEC",
    url: "https://www.sec.gov/news/pressreleases.rss",
    country: "🇺🇸",
    official: true,
  },
  "cnbc-markets": {
    id: "cnbc-markets",
    title: "CNBC Markets",
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    country: "🌐",
    official: false,
  },
  "yahoo-finance": {
    id: "yahoo-finance",
    title: "Yahoo Finance",
    url: "https://finance.yahoo.com/news/rssindex",
    country: "🌐",
    official: false,
  },

  // ── Investing.com ──────────────────────────────────────────────────────────
  // Tres secciones y no su feed general (`/rss/news.rss`), por una razón medible:
  // el general va lleno de "Earnings call transcript: …", y "earnings" es una
  // palabra macro del filtro por reglas. Cada transcripción pasaría el paso 1 y
  // se pagaría su puntuación en Haiku. Las tres secciones elegidas no traían
  // ninguna el 10 de septiembre de 2026; el general, una de cada diez.
  //
  // Investing publica `<link>` pero no `<guid>` ni `<description>`: el id sale
  // del enlace, que lleva el número de artículo, y el resumen queda en null —un
  // hueco declarado, como en cualquier otra fuente sin resumen. Y su `pubDate`
  // viene sin zona horaria; lo arregla `toIso`, no esta tabla.
  //
  // Quedan a una fila de distancia, si algún día hacen falta: `news_1` (divisas),
  // `news_11` (materias primas), `news_301` (cripto) y `news_357` (operaciones de
  // insiders). `market_overview.rss` no entra a propósito: es análisis y opinión
  // —"¿romperá el oro los 4.450?"—, justo lo que la cascada existe para no mirar.
  "investing-economy": {
    id: "investing-economy",
    title: "Investing Economía",
    url: "https://www.investing.com/rss/news_14.rss",
    country: "🌐",
    official: false,
  },
  "investing-indicators": {
    id: "investing-indicators",
    title: "Investing Indicadores",
    url: "https://www.investing.com/rss/news_95.rss",
    country: "🌐",
    official: false,
  },
  "investing-stocks": {
    id: "investing-stocks",
    title: "Investing Bolsa",
    url: "https://www.investing.com/rss/news_25.rss",
    country: "🌐",
    official: false,
  },
};

export async function fetchFeed(spec: FeedSpec, opts: RetryOptions = {}): Promise<FeedItem[]> {
  return parseFeed(await fetchText(spec.url, opts));
}

/**
 * Elementos del feed a eventos normalizados.
 *
 * Se descarta el elemento **sin fecha interpretable**. No es purismo: la frescura
 * es lo que decide si algo se mira o se ignora, y darle la fecha de hoy a un
 * elemento sin fecha lo convierte en noticia de última hora en cada ejecución del
 * cron.
 */
export function toEvents(
  items: FeedItem[],
  spec: FeedSpec,
  opts: { retrievedAt: string },
): NormalizedEvent[] {
  const eventos: NormalizedEvent[] = [];

  for (const item of items) {
    const observedAt = toIso(item.date);
    if (observedAt === null) continue;

    const guid = item.guid ?? item.link;
    if (guid === null) continue; // Sin identificador estable no hay idempotencia posible.

    eventos.push({
      id: itemId("rss", spec.id, guid),
      source: "rss",
      source_url: item.link,
      kind: "news",
      title: item.title,
      summary: recortar(item.summary, 600),
      country: spec.country,
      series_id: spec.id,
      observed_at: observedAt,
      retrieved_at: opts.retrievedAt,

      // Una noticia no trae cifras estructuradas. El hueco se declara, no se rellena.
      actual: null,
      previous: null,
      consensus: null,
      unit: null,
      surprises: [],

      stale: false,
      official: spec.official,
    });
  }
  return eventos;
}

/** Un resumen de tres párrafos no aporta más que su primera parte, y sí gasta tokens. */
function recortar(s: string | null, max: number): string | null {
  if (s === null) return null;
  const limpio = s.trim();
  if (limpio === "") return null;
  return limpio.length <= max ? limpio : limpio.slice(0, max - 1).trimEnd() + "…";
}
