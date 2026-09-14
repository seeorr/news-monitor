import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFreeRouter } from "../src/ai/providers.ts";
import { memoryControlStore, type ControlStore } from "../src/pipeline/control.ts";
import { neonControlStore } from "../src/db/control.ts";
import type { Ejecutor } from "../src/db/cliente.ts";

const BIG = "openai/gpt-oss-120b", SMALL = "openai/gpt-oss-20b";
const GROQ = "https://api.groq.com/openai/v1/chat/completions", OR = "https://openrouter.ai/api/v1/chat/completions";
const groq = { name: "groq" as const, apiKey: "test", modelScoring: BIG, modelAnalysis: BIG, modelFallback: SMALL };
const openrouter = { name: "openrouter" as const, apiKey: "test", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" };
const request = { stage: "scoring" as const, attempt: 1, promptVersion: "test", system: "Public", user: "Public", schema: z.object({ ok: z.boolean() }), maxTokens: 50 };
const ok = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }));
const limited = (retryAfter = "3600") => new Response("private", { status: 429, headers: { "retry-after": retryAfter } });
const modelOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit | undefined)?.body)).model as string;

/** Un ciclo con el ledger real en memoria: reserva, registra y lee la espera como producción. */
function cycle(store: ControlStore, transport: typeof fetch, providers: Parameters<typeof createFreeRouter>[0]["providers"] = [groq], onModelFallback = vi.fn()) {
  const meta = new Map<string, { provider: string; model: string; stage: "scoring" | "analysis"; promptVersion: string; attempt: number }>();
  return createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, onModelFallback,
    getRetryAt: (provider, now, model) => store.providerRetryAt!(provider, now, model),
    beforeRequest: async (info) => {
      const id = crypto.randomUUID();
      await store.reserve({ id, resource: "ai", units: 1, now: new Date().toISOString(), dayLimit: 1000 });
      meta.set(id, info);
      await store.recordAi(id, { ...info, inputTokens: null, outputTokens: null, costUsd: null, result: "uncertain" });
      return id;
    },
    afterRequest: async (id, result) => store.recordAi(id, { ...meta.get(id)!, costUsd: null, ...result }),
  });
}
afterEach(() => vi.useRealTimers());

describe("respaldo de modelo en Groq ante 429", () => {
  it("un 429 del 120b pasa en la misma petición al 20b, sin gastar el respaldo de otro proveedor", async () => {
    const store = memoryControlStore(), fallback = vi.fn();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockImplementation(async () => ok());
    await expect(cycle(store, transport, [groq, openrouter], fallback)(request)).resolves.toEqual({ ok: true });
    expect(transport.mock.calls.map((call) => [call[0], modelOf(call)])).toEqual([[GROQ, BIG], [GROQ, SMALL]]);
    expect(fallback).toHaveBeenCalledWith("groq", "scoring");
    const now = new Date().toISOString();
    expect(await store.providerRetryAt!("groq", now, BIG)).toBeTruthy();
    expect(await store.providerRetryAt!("groq", now, SMALL)).toBeNull();
    // La pausa es del modelo: preguntar por el proveedor no la ve.
    expect(await store.providerRetryAt!("groq", now)).toBeNull();
  });

  it("el ciclo siguiente va directo al 20b sin intentar el 120b, y vuelve al 120b al vencer la espera", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-09-14T15:00:00.000Z");
    const store = memoryControlStore();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(limited("3600")).mockImplementation(async () => ok());
    await cycle(store, transport)(request);
    vi.setSystemTime("2026-09-14T15:10:00.000Z");
    await cycle(store, transport)(request);
    expect(transport.mock.calls.slice(2).map(modelOf)).toEqual([SMALL]);
    vi.setSystemTime("2026-09-14T16:00:01.000Z");
    await cycle(store, transport)(request);
    expect(modelOf(transport.mock.calls.at(-1)!)).toBe(BIG);
  });

  it("con los dos modelos limitados Groq queda indisponible, sin HTTP mientras dura; puntuar sigue en OpenRouter", async () => {
    const store = memoryControlStore();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockImplementation(async () => ok());
    await expect(cycle(store, transport)(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(cycle(store, transport)(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(cycle(store, transport, [groq, openrouter])(request)).resolves.toEqual({ ok: true });
    expect(transport.mock.calls.at(-1)![0]).toBe(OR);
  });

  it("un 401 del 120b pausa Groq entero: no prueba el 20b, porque la clave es la misma", async () => {
    const store = memoryControlStore();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private", { status: 401 })).mockImplementation(async () => ok());
    await expect(cycle(store, transport)(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(1);
    const now = new Date().toISOString();
    expect(await store.providerRetryAt!("groq", now)).toBeTruthy();
    expect(await store.providerRetryAt!("groq", now, SMALL)).toBeTruthy();
  });

  it("sin respaldo configurado, un 429 deja Groq indisponible como antes", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockImplementation(async () => ok());
    await expect(cycle(memoryControlStore(), transport, [{ ...groq, modelFallback: null }])(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("el análisis también cae al 20b", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockImplementation(async () => ok());
    await expect(cycle(memoryControlStore(), transport)({ ...request, stage: "analysis" })).resolves.toEqual({ ok: true });
    expect(transport.mock.calls.map(modelOf)).toEqual([BIG, SMALL]);
  });

  it("Neon filtra la espera de modelo por su nombre, con parámetros", async () => {
    const calls: string[] = [], values: unknown[][] = [];
    const sql: Ejecutor = async (parts, ...params) => { calls.push(parts.join("?")); values.push(params); return [{ retry_at: null }]; };
    await neonControlStore("unused", sql).providerRetryAt!("groq", "2026-09-14T15:00:00.000Z", SMALL);
    expect(calls[0]).toMatch(/retryScope/);
    expect(values[0]).toContain(SMALL);
    await neonControlStore("unused", sql).providerRetryAt!("groq", "2026-09-14T15:00:00.000Z");
    expect(values[1]).toContain(null);
  });
});
