/** Límites de concurrencia y cancelación compartidos por los recolectores. */
export class DeadlineError extends Error {
  constructor(readonly code: "SOURCE_TIMEOUT" | "COLLECTION_TIMEOUT") {
    super(code);
    this.name = "DeadlineError";
  }
}

export function positiveInteger(value: number | undefined, fallback: number, max = 100): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max) : fallback;
}

/** Cancela también promesas de adaptadores que no respetan todavía AbortSignal. */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // La promesa puede haber arrancado justo antes de la señal. Consumir su
    // rechazo evita un unhandledRejection de fetch al cancelar en esa carrera.
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** El plazo incluye todos los reintentos de una fuente; al vencer aborta HTTP. */
export async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new DeadlineError("SOURCE_TIMEOUT")), timeoutMs);
  try {
    return await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }), signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trabajadores acotados. Espera los que ya arrancaron antes de propagar un fallo
 * de infraestructura; así no quedan escrituras concurrentes después de cerrar
 * la base de datos. Los fallos aislables de fuente se resuelven dentro de run.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(items.length, positiveInteger(concurrency, 3, 16)) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index]!, index); }
      catch (err) { if (!failed) { failed = true; failure = err; } }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

/** Reserva atómica de cada inicio HTTP, incluidos reintentos, sin ráfagas. */
export function createRateLimiter(intervalMs: number): (signal?: AbortSignal) => Promise<void> {
  let lastStart = -Infinity;
  let turn: Promise<void> = Promise.resolve();
  return (signal) => {
    const ready = turn.then(async () => {
      signal?.throwIfAborted();
      const delay = Math.max(0, lastStart + intervalMs - Date.now());
      if (delay > 0) await sleep(delay, signal);
      signal?.throwIfAborted();
      // Usar el inicio real, no reservar todos los tiempos de antemano: si el
      // event loop se pausa, las reservas vencidas crearían una ráfaga al volver.
      lastStart = Date.now();
    });
    turn = ready.catch(() => {});
    return ready;
  };
}
