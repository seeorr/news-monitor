import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError, withRequestSignal } from "../src/lib/http.ts";
import { withDeadline } from "../src/lib/concurrency.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cliente HTTP", () => {
  it("reintenta un 500 y acaba devolviendo el cuerpo", async () => {
    const fake = vi.fn()
      .mockResolvedValueOnce(respond(500, { e: 1 }))
      .mockResolvedValueOnce(respond(200, { ok: true }));
    globalThis.fetch = fake as unknown as typeof fetch;

    const out = await fetchJson<{ ok: boolean }>("https://x.test", { backoffMs: 1 });
    expect(out.ok).toBe(true);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("NO reintenta un 400: el error es nuestro e insistir solo gasta cuota", async () => {
    const fake = vi.fn().mockResolvedValue(respond(400, { error: "bad series_id" }));
    globalThis.fetch = fake as unknown as typeof fetch;

    await expect(fetchJson("https://x.test", { backoffMs: 1 })).rejects.toBeInstanceOf(HttpError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("se rinde tras agotar los intentos y propaga el error", async () => {
    const fake = vi.fn().mockResolvedValue(respond(503, {}));
    globalThis.fetch = fake as unknown as typeof fetch;

    await expect(fetchJson("https://x.test", { attempts: 3, backoffMs: 1 })).rejects.toThrow();
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it("propaga un fallo de red en vez de devolver datos vacios", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    await expect(fetchJson("https://x.test", { attempts: 2, backoffMs: 1 })).rejects.toThrow("ECONNRESET");
  });

  it("el deadline de fuente cancela HTTP y no inicia otro intento", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url, init) => {
      seenSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const work = withDeadline((signal) => withRequestSignal(signal,
      () => fetchJson("https://x.test", { timeoutMs: 10_000, attempts: 5 })), 40);
    const assertion = expect(work).rejects.toMatchObject({ code: "SOURCE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cubre también un cuerpo HTTP colgado, con intentos acotados", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const work = fetchJson("https://x.test", { timeoutMs: 20, attempts: 2, backoffMs: 1 });
    const assertion = expect(work).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("interrumpe el backoff al cancelar y libera su temporizador", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    globalThis.fetch = vi.fn().mockResolvedValue(respond(503, {}));
    const work = fetchJson("https://x.test", { signal: controller.signal, attempts: 3, backoffMs: 1000 });
    const assertion = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
