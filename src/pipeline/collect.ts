/**
 * Recolección: todas las fuentes, un solo montón de eventos normalizados.
 *
 * La regla que gobierna este archivo es que **una fuente caída no puede tumbar
 * el ciclo**. Si el BCE no responde, se sigue con el resto y se dice cuál falló:
 * un monitor que se calla porque un feed dio 503 es exactamente el fallo que
 * este proyecto existe para no tener.
 *
 * Aguas abajo de aquí nadie pregunta de qué fuente viene un evento.
 */
import type { Config } from "../config.ts";
import { desdeEntorno, leerWatchlist, type Vigilado } from "../db/watchlist.ts";
import { applyTransform, fetchObservations, SERIES, toEvent } from "../sources/fred.ts";
import {
  DATASETS,
  fetchSerie as fetchEurostat,
  toEvent as eurostatEvent,
} from "../sources/eurostat.ts";
import { FEEDS, fetchFeed, toEvents as feedEvents } from "../sources/rss.ts";
import { fetchCotizacion, toEvent as movimientoEvent } from "../sources/mercado.ts";
import {
  fetchFilings,
  resolveTickers,
  toEvents as filingEvents,
  type Company,
} from "../sources/sec-edgar.ts";
import { createLogger, type Logger } from "../lib/log.ts";
import type { NormalizedEvent } from "../schema/event.ts";

export interface SourceFailure {
  source: string;
  detail: string;
}

export interface Collected {
  events: NormalizedEvent[];
  failures: SourceFailure[];
  /** Fuentes que respondieron. Cero con fallos = el ciclo no ha visto nada. */
  ok: number;
  /** La watchlist que se ha usado de verdad, para que el filtro por reglas use la misma. */
  vigilados: Vigilado[];
}

interface Task {
  name: string;
  source: "fred" | "eurostat" | "rss" | "sec-edgar" | "yahoo";
  feed?: string;
  run: () => Promise<NormalizedEvent[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * La watchlist que manda.
 *
 * La tabla de Neon primero: es donde alguien la ha editado a mano y donde cada
 * valor lleva su propio umbral. Las variables de entorno quedan de respaldo para
 * desarrollo y para el día en que la base no conteste; que la lista esté vacía
 * no es un error, solo significa que aún no se vigila ninguna empresa.
 */
export async function watchlistEfectiva(
  config: Config,
  sink: (line: string) => void = () => {},
): Promise<Vigilado[]> {
  return cargarWatchlist(config, createLogger(sink));
}

async function cargarWatchlist(
  config: Config,
  log: Logger,
): Promise<Vigilado[]> {
  if (config.databaseUrl) {
    try {
      const filas = await leerWatchlist(config.databaseUrl);
      if (filas.length > 0) return filas;
      log("WATCHLIST_EMPTY", { stage: "watchlist", source: "neon" });
    } catch (err) {
      log("WATCHLIST_FAILED", { stage: "watchlist", source: "neon", error: err });
    }
  }
  return desdeEntorno(config.watchlist, config.secWatchlist);
}

export async function collectEvents(
  config: Config,
  opts: { retrievedAt: string; log?: (line: string) => void; logger?: Logger },
): Promise<Collected> {
  const log = opts.logger ?? createLogger(opts.log ?? (() => {}));
  const retrievedAt = opts.retrievedAt;
  // Protegido incluso si Neon falla antes de devolver la lista.
  const vigilados = await cargarWatchlist(config, log);
  const tasks: Task[] = [];

  // ── FRED ───────────────────────────────────────────────────────────────────
  if (config.fredApiKey) {
    for (const spec of Object.values(SERIES)) {
      tasks.push({
        name: `fred:${spec.id}`,
        source: "fred",
        run: async () => {
          const raw = await fetchObservations(spec, config.fredApiKey!);
          const series = applyTransform(raw, spec);
          return [toEvent(series, spec, { retrievedAt })];
        },
      });
    }
  }

  // ── Eurostat ───────────────────────────────────────────────────────────────
  // Sin clave: la API es pública. Una tarea por dataset y no una sola, por lo
  // mismo que en Yahoo: si un dataset retira su agregado de zona euro, se pierde
  // ese y no la macro europea entera.
  //
  // El agregado (`EA21` hoy) se resuelve dentro, preguntándoselo al propio
  // dataset. Una respuesta sin filas —que Eurostat sirve con un 200 y cara de
  // normalidad— lanza y cae aquí como `SOURCE_FAILED`, igual que una caída.
  for (const spec of Object.values(DATASETS)) {
    tasks.push({
      name: `eurostat:${spec.id}`,
      source: "eurostat",
      run: async () => {
        const { geo, obs } = await fetchEurostat(spec);
        return [eurostatEvent(obs, spec, { geo, retrievedAt })];
      },
    });
  }

  // ── Feeds ──────────────────────────────────────────────────────────────────
  const elegidos = config.feeds.length > 0 ? config.feeds : Object.keys(FEEDS);
  for (const id of elegidos) {
    const spec = FEEDS[id];
    if (!spec) {
      log("FEED_UNKNOWN", { stage: "collect", source: "rss", count: 1 });
      continue;
    }
    tasks.push({
      name: `rss:${spec.id}`,
      source: "rss",
      feed: spec.id,
      run: async () => {
        const items = await fetchFeed(spec);
        const normalized = feedEvents(items, spec, { retrievedAt });
        log("FEED_NORMALIZED", { stage: "collect", source: "rss", feed: spec.id,
          total: items.length, count: normalized.length, discarded: items.length - normalized.length });
        return normalized;
      },
    });
  }

  // ── SEC EDGAR ──────────────────────────────────────────────────────────────
  // Dos condiciones, y las dos se explican en voz alta si no se cumplen: sin
  // contacto la SEC responde 403, y sin watchlist no hay a quién vigilar.
  const conFilings = vigilados.filter((v) => v.vigilarFilings);
  if (conFilings.length > 0 && config.secUserAgent) {
    tasks.push({
      name: "sec-edgar",
      source: "sec-edgar",
      run: async () => {
        const ua = config.secUserAgent!;
        const companies = await resolverEmpresas(conFilings, ua, log);
        const eventos: NormalizedEvent[] = [];
        for (const company of companies) {
          const filings = await fetchFilings(company, ua);
          eventos.push(
            ...filingEvents(filings, company, {
              retrievedAt,
              forms: config.edgarForms.length > 0 ? config.edgarForms : undefined,
            }),
          );
          await sleep(150); // La SEC pide como mucho 10 peticiones por segundo.
        }
        return eventos;
      },
    });
  } else if (conFilings.length > 0) {
    log("SEC_CONTACT_MISSING", { stage: "collect", source: "sec-edgar" });
  }

  // ── Precios ────────────────────────────────────────────────────────────────
  // Una tarea por valor y no una sola: si Yahoo se atraganta con un símbolo, se
  // pierde ese y no la cartera entera.
  const conPrecio = vigilados.filter((x) => x.vigilarPrecio);
  for (const [i, v] of conPrecio.entries()) {
    const symbol = v.quoteSymbol ?? v.ticker;
    tasks.push({
      // Numerada, no nombrada: el diagnóstico no identifica la cartera.
      name: `yahoo:#${i + 1}`,
      source: "yahoo",
      run: async () => {
        const c = await fetchCotizacion(symbol);
        const evento = movimientoEvent(c, {
          ticker: v.ticker,
          nombre: v.nombre,
          umbral: v.umbralMovimiento,
          retrievedAt,
        });
        return evento ? [evento] : [];
      },
    });
  }

  // ── Ejecución ──────────────────────────────────────────────────────────────
  const events: NormalizedEvent[] = [];
  const failures: SourceFailure[] = [];
  let ok = 0;

  for (const [index, task] of tasks.entries()) {
    try {
      const nuevos = await task.run();
      events.push(...nuevos);
      ok++;
      log("SOURCE_OK", { stage: "collect", source: task.source, feed: task.feed, index: index + 1, count: nuevos.length });
    } catch (err) {
      // Tampoco devolver mensajes crudos que otro consumidor pudiera imprimir.
      failures.push({ source: task.name, detail: "SOURCE_FAILED" });
      log("SOURCE_FAILED", { stage: "collect", source: task.source, feed: task.feed, index: index + 1, error: err });
    }
  }

  return { events, failures, ok, vigilados };
}

/**
 * Empresas listas para EDGAR.
 *
 * El CIK guardado en la watchlist se usa tal cual; solo se pregunta a la SEC por
 * los que no lo tienen. Así una lista ya resuelta no descarga el mapa completo
 * de tickers en cada ciclo.
 */
async function resolverEmpresas(
  vigilados: Vigilado[],
  userAgent: string,
  log: Logger,
): Promise<Company[]> {
  const listas: Company[] = vigilados
    .filter((v) => v.cik)
    .map((v) => ({ cik: v.cik!, ticker: v.ticker, name: v.nombre }));

  const pendientes = vigilados.filter((v) => !v.cik).map((v) => v.ticker);
  if (pendientes.length === 0) return listas;

  const { companies, unknown } = await resolveTickers(pendientes, userAgent);
  if (unknown.length > 0) {
    log("SEC_UNKNOWN", { stage: "collect", source: "sec-edgar", count: unknown.length });
  }
  return [...listas, ...companies];
}

/**
 * Eventos lo bastante recientes como para merecer una mirada.
 *
 * Un feed no publica solo lo de hoy: trae su historial. Sin este corte, la
 * primera ejecución puntuaría treinta noticias de hace tres semanas y las
 * anunciaría como novedades.
 *
 * El corte solo vale donde `observed_at` es el momento de publicación —una
 * noticia, un documento de la SEC—. En un dato macro `observed_at` es el periodo
 * al que se refiere: el IPC de agosto lleva fecha del 1 de agosto y se publica a
 * mediados de septiembre. Aplicarle este filtro lo tiraría siempre, que es justo
 * el dato por el que existe el monitor. Ahí la novedad la decide el registro de
 * vistos, no el calendario.
 */
const FECHADOS_AL_PUBLICAR = new Set(["news", "filing"]);

export function recientes(
  events: NormalizedEvent[],
  opts: { now: Date; maxAgeHours: number },
): NormalizedEvent[] {
  const limite = opts.now.getTime() - opts.maxAgeHours * 3600_000;
  return events.filter((e) => {
    if (!FECHADOS_AL_PUBLICAR.has(e.kind)) return true;
    const t = Date.parse(e.observed_at);
    if (!Number.isFinite(t)) return true; // Sin fecha interpretable, que decida el scoring.
    return t >= limite;
  });
}

/** Lo más nuevo primero: si el techo del ciclo corta, que corte por lo viejo. */
export function porFecha(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
}
