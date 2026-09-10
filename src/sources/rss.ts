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
import { parseFeed, tagText, toIso, type FeedItem } from "../lib/feed.ts";
import { itemId, type NormalizedEvent } from "../schema/event.ts";

export const FEED_BATCHES = ["core", "batch1", "batch2", "batch3"] as const;
export type FeedBatch = (typeof FEED_BATCHES)[number];

export interface FeedSpec {
  id: string;
  title: string;
  url: string;
  country: string;
  /** Fuente primaria (banco central, regulador). Pasa el filtro por reglas siempre. */
  official: boolean;
  /** Una cuota por editor, no una cuota por cada sección de Investing/BLS. */
  publisher: string;
  topic: string;
  region: string;
  language: string;
  batch: FeedBatch;
  /** false mantiene el candidato en el catálogo, fuera de la captura normal. */
  enabled?: boolean;
  disabledReason?: string;
  catalogUrl?: string;
  termsUrl?: string;
  attribution?: string;
  /** BOJ reutiliza enlaces de estadísticas: cada publicación es una edición. */
  identity?: "guid" | "guid-and-publication";
}

/**
 * Registro de feeds. Añadir uno es añadir una fila: no toca el pipeline ni el
 * formateador, igual que con las series de FRED.
 *
 * Catálogo, no lista de activación. selectFeeds() mantiene los ocho anteriores
 * por defecto. Comprobación de endpoints, condiciones y tandas: docs/fuentes-cobertura.md.
 */
export const FEEDS: Record<string, FeedSpec> = {
  "fed-press": {
    id: "fed-press",
    title: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    country: "🇺🇸",
    official: true,
    publisher: "fed", topic: "politica-monetaria", region: "US", language: "en", batch: "core",
  },
  "ecb-press": {
    id: "ecb-press",
    title: "BCE",
    url: "https://www.ecb.europa.eu/rss/press.html",
    country: "🇪🇺",
    official: true,
    publisher: "ecb", topic: "politica-monetaria", region: "EU", language: "en", batch: "core",
  },
  "sec-press": {
    id: "sec-press",
    title: "SEC",
    url: "https://www.sec.gov/news/pressreleases.rss",
    country: "🇺🇸",
    official: true,
    publisher: "sec", topic: "regulacion", region: "US", language: "en", batch: "core",
  },
  "cnbc-markets": {
    id: "cnbc-markets",
    title: "CNBC Markets",
    url: "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    country: "🌐",
    official: false,
    publisher: "cnbc", topic: "mercados", region: "global", language: "en", batch: "core",
  },
  "yahoo-finance": {
    id: "yahoo-finance",
    title: "Yahoo Finance",
    url: "https://finance.yahoo.com/news/rssindex",
    country: "🌐",
    official: false,
    publisher: "yahoo", topic: "mercados", region: "global", language: "en", batch: "core",
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
  // `news_1` (divisas) y `news_11` (materias primas) quedan en la tanda 3;
  // no se añaden `news_301` (cripto) ni `news_357` (operaciones de
  // insiders). `market_overview.rss` no entra a propósito: es análisis y opinión
  // —"¿romperá el oro los 4.450?"—, justo lo que la cascada existe para no mirar.
  "investing-economy": {
    id: "investing-economy",
    title: "Investing Economía",
    url: "https://www.investing.com/rss/news_14.rss",
    country: "🌐",
    official: false,
    publisher: "investing", topic: "economia", region: "global", language: "en", batch: "core",
  },
  "investing-indicators": {
    id: "investing-indicators",
    title: "Investing Indicadores",
    url: "https://www.investing.com/rss/news_95.rss",
    country: "🌐",
    official: false,
    publisher: "investing", topic: "indicadores", region: "global", language: "en", batch: "core",
  },
  "investing-stocks": {
    id: "investing-stocks",
    title: "Investing Bolsa",
    url: "https://www.investing.com/rss/news_25.rss",
    country: "🌐",
    official: false,
    publisher: "investing", topic: "bolsa", region: "global", language: "en", batch: "core",
  },
  "bls-employment": {
    id: "bls-employment", title: "BLS Empleo", url: "https://www.bls.gov/feed/empsit.rss",
    country: "🇺🇸", official: true, publisher: "bls", topic: "empleo", region: "US", language: "en", batch: "batch1",
    catalogUrl: "https://www.bls.gov/feed/", termsUrl: "https://www.bls.gov/bls/linksite.htm",
    attribution: "U.S. Bureau of Labor Statistics; publicación original y enlace al comunicado.",
  },
  "bls-cpi": {
    id: "bls-cpi", title: "BLS IPC", url: "https://www.bls.gov/feed/cpi.rss",
    country: "🇺🇸", official: true, publisher: "bls", topic: "inflacion-consumo", region: "US", language: "en", batch: "batch1",
    catalogUrl: "https://www.bls.gov/feed/", termsUrl: "https://www.bls.gov/bls/linksite.htm",
    attribution: "U.S. Bureau of Labor Statistics; publicación original y enlace al comunicado.",
  },
  "bls-ppi": {
    id: "bls-ppi", title: "BLS PPI", url: "https://www.bls.gov/feed/ppi.rss",
    country: "🇺🇸", official: true, publisher: "bls", topic: "inflacion-produccion", region: "US", language: "en", batch: "batch1",
    catalogUrl: "https://www.bls.gov/feed/", termsUrl: "https://www.bls.gov/bls/linksite.htm",
    attribution: "U.S. Bureau of Labor Statistics; publicación original y enlace al comunicado.",
  },
  "eia-today": {
    id: "eia-today", title: "EIA Today in Energy", url: "https://www.eia.gov/rss/todayinenergy.xml",
    country: "🇺🇸", official: true, publisher: "eia", topic: "energia", region: "US/global", language: "en", batch: "batch1",
    catalogUrl: "https://www.eia.gov/tools/rssfeeds/", termsUrl: "https://www.eia.gov/about/copyrights_reuse.php",
    attribution: "U.S. Energy Information Administration (fecha de publicación); interpretación de News Monitor; enlace al original.",
  },
  "boe-news": {
    id: "boe-news", title: "Banco de Inglaterra Noticias", url: "https://www.bankofengland.co.uk/rss/news",
    country: "🇬🇧", official: true, publisher: "boe", topic: "politica-monetaria-finanzas", region: "UK", language: "en", batch: "batch2",
    catalogUrl: "https://www.bankofengland.co.uk/rss", termsUrl: "https://www.bankofengland.co.uk/legal",
    attribution: "Bank of England; publicación original y enlace. Uso personal no comercial; análisis propio identificado.",
  },
  "boe-publications": {
    id: "boe-publications", title: "Banco de Inglaterra Publicaciones", url: "https://www.bankofengland.co.uk/rss/publications",
    country: "🇬🇧", official: true, publisher: "boe", topic: "politica-monetaria-informes", region: "UK", language: "en", batch: "batch2",
    catalogUrl: "https://www.bankofengland.co.uk/rss", termsUrl: "https://www.bankofengland.co.uk/legal",
    attribution: "Bank of England; publicación original y enlace. Uso personal no comercial; análisis propio identificado.",
  },
  "boj-news": {
    id: "boj-news", title: "Banco de Japón", url: "https://www.boj.or.jp/en/rss/whatsnew.xml",
    country: "🇯🇵", official: true, publisher: "boj", topic: "politica-monetaria-estadisticas", region: "JP", language: "en", batch: "batch2",
    catalogUrl: "https://www.boj.or.jp/en/", termsUrl: "https://www.boj.or.jp/en/copyright.htm",
    attribution: "Bank of Japan; titular original y enlace. Uso personal no comercial; interpretación de News Monitor identificada.",
    identity: "guid-and-publication",
  },
  "investing-forex": {
    id: "investing-forex", title: "Investing Divisas", url: "https://www.investing.com/rss/news_1.rss",
    country: "🌐", official: false, publisher: "investing", topic: "divisas", region: "global", language: "en", batch: "batch3",
    catalogUrl: "https://www.investing.com/webmaster-tools/rss", termsUrl: "https://www.investing.com/about-us/terms-and-conditions",
    attribution: "Investing.com y autor indicado en el original; enlace al artículo. No licencia abierta de redistribución.",
    enabled: false, disabledReason: "terms_review",
  },
  "investing-commodities": {
    id: "investing-commodities", title: "Investing Materias primas", url: "https://www.investing.com/rss/news_11.rss",
    country: "🌐", official: false, publisher: "investing", topic: "materias-primas", region: "global", language: "en", batch: "batch3",
    catalogUrl: "https://www.investing.com/webmaster-tools/rss", termsUrl: "https://www.investing.com/about-us/terms-and-conditions",
    attribution: "Investing.com y autor indicado en el original; enlace al artículo. No licencia abierta de redistribución.",
    enabled: false, disabledReason: "terms_review",
  },
  "eia-weekly-petroleum": {
    id: "eia-weekly-petroleum", title: "EIA This Week in Petroleum",
    url: "https://www.eia.gov/petroleum/weekly/includes/week_in_petroleum_rss.xml",
    country: "🇺🇸", official: true, publisher: "eia", topic: "petroleo-inventarios", region: "US", language: "en", batch: "batch3",
    catalogUrl: "https://www.eia.gov/tools/rssfeeds/", termsUrl: "https://www.eia.gov/about/copyrights_reuse.php",
    attribution: "U.S. Energy Information Administration (fecha de publicación); enlace al original.",
    enabled: false, disabledReason: "invalid_dates_and_stale_feed",
  },
};

/** Solo tandas expresamente elegidas; las erratas no activan todos los feeds. */
export function selectFeeds(batches: readonly string[] = ["core"]): FeedSpec[] {
  for (const batch of batches) {
    if (!(FEED_BATCHES as readonly string[]).includes(batch)) throw new Error("rss_batch_unknown");
  }
  const selected = new Set(batches);
  return Object.values(FEEDS).filter((spec) => selected.has(spec.batch) && spec.enabled !== false);
}

export function getFeedPublisher(id: string): string {
  return FEEDS[id]?.publisher ?? "rss-unknown";
}

/** La empresa observada no es el editor del feed que la comunica. */
export function publisherForEvent(event: Pick<NormalizedEvent, "source" | "series_id">): string {
  if (event.source === "rss") return getFeedPublisher(event.series_id ?? "");
  if (event.source === "sec-edgar") return "sec";
  if (event.source === "yahoo") return "yahoo-market";
  return event.source;
}

export async function fetchFeed(spec: FeedSpec, opts: RetryOptions = {}): Promise<FeedItem[]> {
  const xml = await fetchText(spec.url, opts);
  // Una página HTML de bloqueo con HTTP 200 no es un feed vacío correcto.
  if (!/<(?:\w+:)?(?:rss|feed|RDF)(?:\s|>)/i.test(xml)) {
    throw Object.assign(new Error("feed_invalid"), { code: "FEED_INVALID" });
  }
  return parseFeed(xml);
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
    // Atom distingue publicación de actualización. Una edición no convierte
    // el hecho original en recién publicado al día siguiente.
    const observedAt = toIso(item.date);
    if (observedAt === null) continue;
    const publicationAt = item.publicationDate === undefined ? observedAt : toIso(item.publicationDate);

    const guid = item.guid ?? item.link;
    if (guid === null) continue; // Sin identificador estable no hay idempotencia posible.

    eventos.push({
      id: itemId("rss", spec.id, spec.identity === "guid-and-publication" ? `${guid}|${observedAt}` : guid),
      source: "rss",
      source_url: item.link,
      kind: "news",
      title: item.title,
      summary: recortar(item.summary ?? atomContent(item), 600),
      country: spec.country,
      series_id: spec.id,
      observed_at: observedAt,
      retrieved_at: opts.retrievedAt,
      publication_at: publicationAt,
      // El mes al que alude un comunicado no se deduce de su fecha de publicación.
      data_period_at: null,

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

/** BLS ofrece su entradilla en content, no en summary. No se descarga el artículo. */
function atomContent(item: FeedItem): string | null {
  const content = tagText(item.raw, "content");
  return content?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

/** Un resumen de tres párrafos no aporta más que su primera parte, y sí gasta tokens. */
function recortar(s: string | null, max: number): string | null {
  if (s === null) return null;
  const limpio = s.trim();
  if (limpio === "") return null;
  return limpio.length <= max ? limpio : limpio.slice(0, max - 1).trimEnd() + "…";
}
