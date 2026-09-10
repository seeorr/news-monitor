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
import { FEEDS, fetchFeed, selectFeeds, toEvents as feedEvents } from "../sources/rss.ts";
import { fetchCotizacion, toEvent as movimientoEvent } from "../sources/mercado.ts";
import {
  fetchFilings,
  resolveTickers,
  toEvents as filingEvents,
  type Company,
} from "../sources/sec-edgar.ts";
import { createLogger, type Logger } from "../lib/log.ts";
import { DeadlineError, mapConcurrent, positiveInteger, withDeadline } from "../lib/concurrency.ts";
import { withRequestSignal } from "../lib/http.ts";
import type { NormalizedEvent } from "../schema/event.ts";
import { FAST_FEEDS, type Profile } from "./profile.ts";

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

export interface CollectedSource {
  source: Task["source"];
  feed?: string;
  /** Ordinal público; no contiene ticker ni contacto. */
  index: number;
  /** Se entrega al filtro interno, nunca al logger público. */
  vigilados: Vigilado[];
}

export interface CollectOptions {
  profile?: Profile;
  onSourceResult?: (result: { feed?: string; ok: boolean; at: string }) => Promise<void>;
  retrievedAt: string;
  log?: (line: string) => void;
  logger?: Logger;
  /** Escritura temprana, serializada. Un fallo aquí aborta el ciclo y se propaga. */
  onCollected?: (events: NormalizedEvent[], source: CollectedSource) => Promise<void>;
}

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
  opts: CollectOptions,
): Promise<Collected> {
  if (opts.profile !== undefined && !["fast", "full"].includes(opts.profile)) throw new Error("invalid_capture_profile");
  const sourceTimeout = positiveInteger(config.sourceTimeoutMs, 45_000, 120_000);
  const collection = new AbortController();
  const globalTimer = setTimeout(() => collection.abort(new DeadlineError("COLLECTION_TIMEOUT")),
    positiveInteger(config.collectionTimeoutMs, 180_000, 600_000));
  try {
    return await collectWithinBudget(config, opts, collection, sourceTimeout);
  } finally {
    clearTimeout(globalTimer);
  }
}

async function collectWithinBudget(
  config: Config,
  opts: CollectOptions,
  collection: AbortController,
  sourceTimeout: number,
): Promise<Collected> {
  const log = opts.logger ?? createLogger(opts.log ?? (() => {}));
  const retrievedAt = opts.retrievedAt;
  // Un Neon sin respuesta no puede consumir todo el tiempo de captura. Si la
  // consulta no admite señal, el deadline permite continuar con el respaldo.
  const vigilados = await withDeadline(() => cargarWatchlist(config, log), sourceTimeout, collection.signal)
    .catch((err) => {
      log("WATCHLIST_FAILED", { stage: "watchlist", source: "neon", error: err });
      return desdeEntorno(config.watchlist, config.secWatchlist);
    });
  const tasks: Task[] = [];

  // ── FRED ───────────────────────────────────────────────────────────────────
  if (opts.profile !== "fast" && config.fredApiKey) {
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
  for (const spec of opts.profile === "fast" ? [] : Object.values(DATASETS)) {
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
  const configured = config.feeds.length > 0 ? config.feeds : selectFeeds(config.rssFeedBatches).map((feed) => feed.id);
  const elegidos = opts.profile === "fast" ? [...new Set(["ecb-press", ...configured.filter((id) => (FAST_FEEDS as readonly string[]).includes(id))])] : configured;
  for (const id of elegidos) {
    const spec = FEEDS[id];
    if (!spec) {
      log("FEED_UNKNOWN", { stage: "collect", source: "rss", count: 1 });
      continue;
    }
    if (spec.enabled === false) {
      log("FEED_DISABLED", { stage: "collect", source: "rss", feed: spec.id, count: 1 });
      continue;
    }
    tasks.push({
      name: `rss:${spec.id}`,
      source: "rss",
      feed: spec.id,
      run: async () => {
        const items = await fetchFeed(spec, opts.profile === "fast" ? { attempts: 1, timeoutMs: 10_000 } : undefined);
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
  const conFilings = opts.profile === "fast" ? [] : vigilados.filter((v) => v.vigilarFilings);
  if (conFilings.length > 0 && config.secUserAgent) {
    for (const [i, vigilado] of conFilings.entries()) {
      tasks.push({
        name: `sec-edgar:#${i + 1}`,
        source: "sec-edgar",
        run: async () => {
          const ua = config.secUserAgent!;
          let company: Company | undefined = vigilado.cik
            ? { cik: vigilado.cik, ticker: vigilado.ticker, name: vigilado.nombre } : undefined;
          if (!company) {
            // El mapa se comparte en memoria; si falla no afecta a empresas con
            // CIK propio, y cada empresa conserva su propio resultado y diagnóstico.
            const resolved = await resolveTickers([vigilado.ticker], ua);
            company = resolved.companies[0];
            if (resolved.unknown.length > 0) log("SEC_UNKNOWN", { stage: "collect", source: "sec-edgar", count: resolved.unknown.length });
          }
          if (!company) return [];
          const forms = config.edgarForms.length > 0 ? config.edgarForms : undefined;
          const filings = await fetchFilings(company, ua, {
            forms,
            count: config.edgarMaxFilings,
            since: new Date(Date.parse(retrievedAt) - config.maxItemAgeHours * 3600_000).toISOString(),
            onCoverage: (coverage) => {
              if (coverage.truncated) log("SEC_COVERAGE", { stage: "collect", source: "sec-edgar",
                total: coverage.total, count: coverage.returned, failed: coverage.archiveFailures });
            },
          });
          return filingEvents(filings, company, { retrievedAt, forms });
        },
      });
    }
  } else if (conFilings.length > 0) {
    log("SEC_CONTACT_MISSING", { stage: "collect", source: "sec-edgar" });
  }

  // ── Precios ────────────────────────────────────────────────────────────────
  // Una tarea por valor y no una sola: si Yahoo se atraganta con un símbolo, se
  // pierde ese y no la cartera entera.
  const conPrecio = opts.profile === "fast" ? [] : vigilados.filter((x) => x.vigilarPrecio);
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
  let persistence: Promise<void> = Promise.resolve();
  let persistenceFailed = false;
  let persistenceError: unknown;

  // También full consulta el BCE antes que las APIs lentas. La prioridad del
  // procesamiento no serviría si el comunicado aún estuviera esperando captura.
  const sourcePriority = (task: Task) => task.feed === "ecb-press" ? 2
    : task.feed && (FAST_FEEDS as readonly string[]).includes(task.feed) ? 1 : 0;
  tasks.sort((a, b) => sourcePriority(b) - sourcePriority(a));

  await mapConcurrent(tasks, positiveInteger(config.sourceConcurrency, 3, 16), async (task, index) => {
    let nuevos: NormalizedEvent[];
    try {
      nuevos = await withDeadline((signal) => withRequestSignal(signal, task.run), sourceTimeout, collection.signal);
    } catch (err) {
      if (persistenceFailed) throw persistenceError;
      // Tampoco devolver mensajes crudos que otro consumidor pudiera imprimir.
      failures.push({ source: task.name, detail: err instanceof DeadlineError ? err.code : "SOURCE_FAILED" });
      log("SOURCE_FAILED", { stage: "collect", source: task.source, feed: task.feed, index: index + 1, error: err });
      await opts.onSourceResult?.({ feed: task.feed, ok: false, at: new Date().toISOString() });
      return;
    }
    // Fuera del catch de fuente: si la base falla, no decir «RSS caído» ni
    // devolver éxito con candidatas sin guardar. No hay dos escrituras de lote
    // simultáneas, también cuando el respaldo es un fichero JSON.
    const write = persistence.then(async () => {
      await opts.onCollected?.(nuevos, { source: task.source, feed: task.feed, index: index + 1, vigilados });
      await opts.onSourceResult?.({ feed: task.feed, ok: true, at: new Date().toISOString() });
    });
    persistence = write;
    try { await write; }
    catch (err) { persistenceFailed = true; persistenceError = err; collection.abort(err); throw err; }
    events.push(...nuevos);
    ok++;
    log("SOURCE_OK", { stage: "collect", source: task.source, feed: task.feed, index: index + 1, count: nuevos.length });
  });

  return { events, failures, ok, vigilados };
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
