/**
 * Cliente HTTP con timeout y reintentos.
 *
 * Un `fetch` sin timeout puede quedarse colgado indefinidamente, y en un cron eso
 * no es una petición lenta: es el job entero atascado hasta que GitHub lo mata.
 */

export interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  /** Espera base en ms; crece exponencialmente. */
  backoffMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ¿Merece la pena reintentar? 4xx que no sea 408/429 es culpa nuestra: no insistas. */
function retryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true; // red, DNS, timeout
}

export async function fetchJson<T = unknown>(url: string, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffMs = opts.backoffMs ?? 500;

  let lastError: Error = new Error("sin intentos");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "news-monitor/0.1 (personal market intelligence)" },
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 500);
        throw new HttpError(`${res.status} ${res.statusText}`, res.status, body);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === attempts || !retryable(lastError)) break;
      opts.onRetry?.(attempt, lastError);
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
