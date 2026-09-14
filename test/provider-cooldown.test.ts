import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createFreeRouter, providerRetryAt } from "../src/ai/providers.ts";
import { fileControlStore, memoryControlStore, type ControlStore } from "../src/pipeline/control.ts";
import { neonControlStore } from "../src/db/control.ts";
import type { Ejecutor } from "../src/db/cliente.ts";

const at = "2026-09-14T10:00:00.000Z";
const providers = [{ name: "groq" as const, apiKey: "test", modelScoring: "openai/gpt-oss-120b", modelAnalysis: "openai/gpt-oss-120b" }];
const request = { stage: "scoring" as const, attempt: 1, promptVersion: "test", system: "Public", user: "Public", schema: z.object({ ok: z.boolean() }), maxTokens: 50 };
const ok = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }));
function router(store: ControlStore, transport: typeof fetch) {
  let id = "";
  return createFreeRouter({ providers, timeoutMs: 1000, fetch: transport,
    getRetryAt: (provider, now) => store.providerRetryAt!(provider, now),
    beforeRequest: async (info) => {
      id = crypto.randomUUID();
      await store.reserve({ id, resource: "ai", units: 1, now: new Date().toISOString(), dayLimit: 180 });
      await store.recordAi(id, { ...info, inputTokens: null, outputTokens: null, costUsd: null, result: "uncertain" });
      return id;
    },
    afterRequest: async (reservation, result) => store.recordAi(reservation, { provider: "groq", model: "test", stage: "scoring", promptVersion: "test", attempt: 1, costUsd: null, ...result }),
  });
}
afterEach(() => vi.useRealTimers());
describe("espera LLM durable", () => {
  it("json_validate_failed de Groq permite un solo reintento contabilizado y no pausa seis horas", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "json_validate_failed", failed_generation: "private" } }), { status: 400 })).mockImplementation(async () => ok());
    const before = vi.fn(async () => "receipt"), after = vi.fn(), failures = vi.fn();
    await expect(createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: before, afterRequest: after, onFailure: failures })(request)).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(before).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2 }));
    expect(after.mock.calls[0]![1]).not.toHaveProperty("retryAt");
    expect(String(failures.mock.calls[0]![1])).not.toContain("private");
  });
  it("dos generaciones rechazadas no producen bucle ni cooldown de configuración", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: { code: "json_validate_failed" } }), { status: 400 }));
    await expect(createFreeRouter({ providers, timeoutMs: 1000, fetch: transport })(request)).rejects.toMatchObject({ code: "LLM_OUTPUT_INVALID" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("el respaldo en espera no roba la mitad del plazo al proveedor disponible", async () => {
    vi.useFakeTimers(); vi.setSystemTime(at);
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 12_000)); return ok();
    });
    const generate = createFreeRouter({ providers: [...providers, { name: "openrouter", apiKey: "test", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" }],
      timeoutMs: 20_000, fetch: transport, getRetryAt: async name => name === "openrouter" ? "2026-09-14T11:00:00.000Z" : null });
    const done = expect(generate(request)).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(12_001);
    await done; expect(transport).toHaveBeenCalledTimes(1);
  });
  it("interpreta Retry-After numérico y fecha HTTP, con límites seguros", () => {
    const now = Date.parse(at);
    expect(providerRetryAt(429, "3600", now)).toBe("2026-09-14T11:00:00.000Z");
    expect(providerRetryAt(429, "Mon, 14 Sep 2026 11:00:00 GMT", now)).toBe("2026-09-14T11:00:00.000Z");
    expect(providerRetryAt(429, "0", now)).toBe("2026-09-14T10:15:00.000Z");
    expect(providerRetryAt(401, "secreto reflejado", now)).toBe("2026-09-14T16:00:00.000Z");
    expect(providerRetryAt(503, "999999999999", now)).toBe("2026-09-21T10:00:00.000Z");
  });
  it.each(["memory", "file"])("un nuevo ciclo %s omite HTTP y reserva durante la espera; reanuda al vencer", async mode => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at);
    const directory = mkdtempSync(join(tmpdir(), "news-cooldown-"));
    const store = mode === "file" ? fileControlStore(directory) : memoryControlStore();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private error", { status: 429, headers: { "retry-after": "3600" } })).mockImplementation(async () => ok());
    await expect(router(store, transport)(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    const restarted = mode === "file" ? fileControlStore(directory) : store;
    vi.setSystemTime("2026-09-14T10:10:00.000Z");
    await expect(router(restarted, transport)(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await restarted.stats(at)).find(row => row.resource === "ai")?.calls).toBe(1);
    vi.setSystemTime("2026-09-14T11:00:00.000Z");
    await expect(router(restarted, transport)(request)).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("salta al respaldo antes de reservar contra el proveedor en espera", async () => {
    const before = vi.fn(async () => "receipt"), transport = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const generate = createFreeRouter({ providers: [...providers, { name: "openrouter", apiKey: "test", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" }], timeoutMs: 1000, fetch: transport,
      getRetryAt: async (name) => name === "groq" ? new Date(Date.now() + 3600_000).toISOString() : null,
      beforeRequest: before });
    await generate(request);
    expect(before).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter" }));
    expect(transport.mock.calls[0]![0]).toContain("openrouter.ai");
  });
  it("fallar la lectura del cooldown no genera tráfico ni reserva", async () => {
    const transport = vi.fn(), before = vi.fn();
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport,
      beforeRequest: before, getRetryAt: async () => { throw new Error("database unavailable"); } });
    await expect(generate(request)).rejects.toThrow("database unavailable");
    expect(before).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it("Neon lee el plazo persistido con parámetros, sin credenciales ni escritura", async () => {
    const calls: string[] = [], values: unknown[][] = [];
    const sql: Ejecutor = async (parts, ...params) => { calls.push(parts.join("?")); values.push(params); return [{ retry_at: "2026-09-14T11:00:00.000Z" }]; };
    expect(await neonControlStore("unused", sql).providerRetryAt!("groq", at)).toBe("2026-09-14T11:00:00.000Z");
    expect(calls[0]).toMatch(/select max/); expect(calls[0]).not.toMatch(/insert|update|delete/i);
    expect(values[0]).toContain("groq"); expect(values[0]).toContain(at);
  });
});
