import { describe, expect, it, vi } from "vitest";
import { analyzeEvent, scoreEvent, type CascadeDeps } from "../src/ai/cascade.ts";
import { createFreeRouter } from "../src/ai/providers.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const event: NormalizedEvent = {
  id: "test:ecb", title: "El BCE recorta sus tipos en 25 puntos básicos", summary: "El tipo de depósito queda en el 3,75 %.",
  source: "rss", series_id: "ecb-press", source_url: "https://www.ecb.europa.eu/", kind: "news", country: "EA",
  observed_at: "2024-06-06T12:15:00Z", retrieved_at: "2024-06-06T12:15:00Z", actual: null, previous: null,
  consensus: null, unit: null, surprises: [], stale: false, official: true,
};
const scoring = { importance_score: 8, market_impact_score: 7, sentiment: "neutral", needs_alert: true,
  one_liner: "El BCE recorta sus tipos en 25 puntos básicos." };
const analysis = { why_it_matters: "Podría aliviar el coste de financiación.", catalysts: [], risks: [], affected_assets: [], what_to_watch: [] };
function response(output: unknown) {
  return new Response(JSON.stringify({ model: "test-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 150, completion_tokens: 80 } }));
}
describe("cascada real con transporte gratuito simulado", () => {
  it("usa los esquemas reales, cambia de proveedor al puntuar y registra cada intento", async () => {
    const providers = [{ name: "groq" as const, apiKey: "test", modelScoring: "openai/gpt-oss-120b", modelAnalysis: "openai/gpt-oss-120b" },
      { name: "openrouter" as const, apiKey: "test", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("", { status: 402 }))
      .mockResolvedValueOnce(response(scoring));
    const before = vi.fn(async () => "reservation"), after = vi.fn(async () => {});
    const deps: CascadeDeps = { modelScoring: "unused", modelAnalysis: "unused", generate: createFreeRouter({
      providers, timeoutMs: 1000, fetch, beforeRequest: before, afterRequest: after,
    }) };
    expect(await scoreEvent(event, deps)).toEqual(scoring);
    expect(before).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: "groq", stage: "scoring" }));
    expect(before).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: "openrouter", stage: "scoring" }));
    expect(after).toHaveBeenNthCalledWith(2, "reservation", expect.objectContaining({ result: "success", inputTokens: 150, outputTokens: 80 }));
    // Groq quedó apartado y OpenRouter no analiza: el análisis espera, sin reservar ni llamar.
    await expect(analyzeEvent(event, deps)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(before).toHaveBeenCalledTimes(2);

    // Ciclo siguiente con Groq sano: el análisis sale con el esquema real.
    const nextFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(analysis));
    const next: CascadeDeps = { ...deps, generate: createFreeRouter({ providers, timeoutMs: 1000, fetch: nextFetch }) };
    expect(await analyzeEvent(event, next)).toEqual(analysis);
    expect(nextFetch.mock.calls[0]![0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    const request = JSON.parse(String(nextFetch.mock.calls[0]![1]!.body));
    expect(request.response_format.json_schema.schema.properties).toHaveProperty("affected_assets");
    expect(request.messages[1].content).toContain(event.title);
  });
  it("corrige cifras inventadas por el proveedor antes de persistir la puntuación", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...scoring, one_liner: "El BCE recorta tipos 100 puntos." }));
    const deps: CascadeDeps = { modelScoring: "unused", modelAnalysis: "unused", generate: createFreeRouter({
      providers: [{ name: "groq", apiKey: "test", modelScoring: "openai/gpt-oss-120b", modelAnalysis: "openai/gpt-oss-120b" }], timeoutMs: 1000, fetch,
    }) };
    expect((await scoreEvent(event, deps)).one_liner).toBe(event.title);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
