/**
 * Cliente HTTP con timeout y reintentos.
 *
 * Un `fetch` sin timeout puede quedarse colgado indefinidamente, y en un cron eso
 * no es una petición lenta: es el job entero atascado hasta que GitHub lo mata.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { abortable, positiveInteger, sleep } from "./concurrency.ts";

const requestContext = new AsyncLocalStorage<AbortSignal>();

/** El plazo de fuente llega también a clientes que hacen varias peticiones. */
export function withRequestSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return requestContext.run(signal, run);
}

export interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  /** Espera base en ms; crece exponencialmente. */
  backoffMs?: number;
  /** Cabeceras extra. SEC EDGAR exige un User-Agent con contacto; los demás no. */
  headers?: Record<string, string>;
  onRetry?: (attempt: number, error: Error) => void;
  signal?: AbortSignal;
  /** Limitador antes de cada intento; SEC comparte uno entre todas las empresas. */
  beforeAttempt?: (signal?: AbortSignal) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const UA = "news-monitor/0.1 (personal market intelligence)";

/** ¿Merece la pena reintentar? 4xx que no sea 408/429 es culpa nuestra: no insistas. */
function retryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true; // red, DNS, timeout
}

/**
 * Petición con reintentos. `read` decide qué se devuelve; el bucle es el mismo
 * para JSON y para XML, porque el que cambia es el cuerpo, no la política de red.
 */
async function request<T>(
  url: string,
  opts: RetryOptions,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const attempts = positiveInteger(opts.attempts, 3, 5);
  const timeoutMs = positiveInteger(opts.timeoutMs, 15_000, 60_000);
  const backoffMs = opts.backoffMs === 0 ? 0 : positiveInteger(opts.backoffMs, 500, 5_000);
  const inherited = requestContext.getStore();
  const outerSignal = opts.signal && inherited
    ? AbortSignal.any([opts.signal, inherited]) : opts.signal ?? inherited;

  let lastError: Error = new Error("sin intentos");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    outerSignal?.throwIfAborted();
    await opts.beforeAttempt?.(outerSignal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("HTTP timeout", "TimeoutError")), timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    try {
      const res = await abortable(fetch(url, {
        signal,
        headers: { "User-Agent": UA, ...opts.headers },
      }), signal);
      if (!res.ok) {
        const body = (await abortable(res.text(), signal).catch(() => "")).slice(0, 500);
        throw new HttpError(`${res.status} ${res.statusText}`, res.status, body);
      }
      return await abortable(read(res), signal);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      outerSignal?.throwIfAborted();
      if (attempt === attempts || !retryable(lastError)) break;
      opts.onRetry?.(attempt, lastError);
    } finally {
      clearTimeout(timer);
    }
    await sleep(backoffMs * 2 ** (attempt - 1), outerSignal);
  }
  throw lastError;
}

export async function fetchJson<T = unknown>(url: string, opts: RetryOptions = {}): Promise<T> {
  return request(url, opts, async (res) => (await res.json()) as T);
}

/** Para feeds: RSS y Atom son XML, y aquí no se parsean, solo se traen. */
export async function fetchText(url: string, opts: RetryOptions = {}): Promise<string> {
  return request(url, opts, (res) => res.text());
}
