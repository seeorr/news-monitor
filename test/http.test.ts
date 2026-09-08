import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError } from "../src/lib/http.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
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
});
