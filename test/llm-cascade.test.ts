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
  it("usa los esquemas reales, cambia de proveedor y registra cada intento", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response("", { status: 402 }))
      .mockResolvedValueOnce(response(scoring)).mockResolvedValueOnce(response(analysis));
    const before = vi.fn(async () => "reservation"), after = vi.fn(async () => {});
    const deps: CascadeDeps = { modelScoring: "unused", modelAnalysis: "unused", generate: createFreeRouter({
      providers: [{ name: "groq", apiKey: "test", modelScoring: "openai/gpt-oss-120b", modelAnalysis: "openai/gpt-oss-120b" },
        { name: "openrouter", apiKey: "test", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" }],
      timeoutMs: 1000, fetch, beforeRequest: before, afterRequest: after,
    }) };
    expect(await scoreEvent(event, deps)).toEqual(scoring);
    expect(await analyzeEvent(event, deps)).toEqual(analysis);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(before).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: "groq", stage: "scoring" }));
    expect(before).toHaveBeenNthCalledWith(3, expect.objectContaining({ provider: "openrouter", stage: "analysis" }));
    expect(after).toHaveBeenNthCalledWith(3, "reservation", expect.objectContaining({ result: "success", inputTokens: 150, outputTokens: 80 }));
    const request = JSON.parse(String(fetch.mock.calls[2]![1]!.body));
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
