import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFreeRouter, type StructuredRequest } from "../src/ai/providers.ts";

const providers = [
  { name: "groq" as const, apiKey: "SECRET-GROQ", modelScoring: "openai/gpt-oss-120b", modelAnalysis: "openai/gpt-oss-120b" },
  { name: "openrouter" as const, apiKey: "SECRET-OR", modelScoring: "openrouter/free", modelAnalysis: "openrouter/free" },
];
const schema = z.object({ score: z.number().int().min(0).max(10), summary: z.string().max(50) });
const request: StructuredRequest<z.infer<typeof schema>> = {
  stage: "scoring", attempt: 1, promptVersion: "test-v1", system: "SYSTEM-PRIVATE",
  user: "NEWS-PRIVATE", schema, maxTokens: 512,
};
const valid = { score: 7, summary: "Hecho comprobado" };
function response(content: unknown = valid, options: { finish?: string; refusal?: string; usage?: unknown; model?: string } = {}): Response {
  return new Response(JSON.stringify({
    ...(options.model === undefined ? {} : { model: options.model }),
    choices: [{ finish_reason: options.finish ?? "stop", message: {
      content: typeof content === "string" ? content : JSON.stringify(content), refusal: options.refusal ?? null,
    } }],
    usage: options.usage ?? { prompt_tokens: 121, completion_tokens: 34 },
  }), { headers: { "content-type": "application/json" } });
}
afterEach(() => vi.useRealTimers());

describe("router LLM gratuito: HTTP real simulado solo en fetch", () => {
  it("envía esquema estricto, reserva antes de red y contabiliza los tokens", async () => {
    const order: string[] = [];
    const transport = vi.fn(async () => { order.push("http"); return response(); });
    const beforeRequest = vi.fn(async () => { order.push("reserve"); return "req-1"; });
    const afterRequest = vi.fn(async () => { order.push("persist"); });
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest, afterRequest });
    await expect(generate(request)).resolves.toEqual(valid);
    expect(order).toEqual(["reserve", "http", "persist"]);
    expect(beforeRequest).toHaveBeenCalledWith({ stage: "scoring", model: "openai/gpt-oss-120b", provider: "groq", promptVersion: "test-v1", attempt: 1 });
    expect(afterRequest).toHaveBeenCalledWith("req-1", { inputTokens: 121, outputTokens: 34, result: "success" });
  });

  it.each([400, 401, 402, 403, 404, 429, 500, 503])("HTTP %s abre circuito y usa fallback sin volver al proveedor caído", async status => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("SECRET-SERVER-BODY", { status }))
      .mockImplementation(async () => response());
    const beforeRequest = vi.fn(async () => "reserved");
    const afterRequest = vi.fn(async () => {});
    const onFailure = vi.fn();
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest, afterRequest, onFailure });
    await expect(generate(request)).resolves.toEqual(valid);
    await expect(generate(request)).resolves.toEqual(valid);
    expect(transport.mock.calls.map(call => call[0])).toEqual([
      "https://api.groq.com/openai/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    expect(afterRequest.mock.calls[0]).toEqual(["reserved", { inputTokens: null, outputTokens: null, result: "failed", retryAt: expect.any(String) }]);
    expect(String(onFailure.mock.calls[0]?.[1])).not.toContain("SECRET");
    expect(onFailure.mock.calls[0]?.[1]).toMatchObject({ code: "LLM_REQUEST_FAILED", status });
  });

  it("red incierta abre circuito, se contabiliza y no expone el error original", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("SECRET-GROQ SYSTEM-PRIVATE NEWS-PRIVATE"))
      .mockImplementation(async () => response());
    const afterRequest = vi.fn(async () => {});
    const onFailure = vi.fn();
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => "id", afterRequest, onFailure });
    await generate(request);
    await generate(request);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(afterRequest.mock.calls[0]).toEqual(["id", { inputTokens: null, outputTokens: null, result: "uncertain", retryAt: expect.any(String) }]);
    expect(String(onFailure.mock.calls[0]?.[1])).toBe("ProviderFailure: LLM gratuito: network");
  });

  it.each([
    ["JSON", () => response("no-json")],
    ["rango", () => response({ ...valid, score: 99 })],
    ["longitud", () => response({ ...valid, summary: "x".repeat(51) })],
    ["refusal", () => response(valid, { refusal: "no" })],
    ["truncada", () => response(valid, { finish: "length" })],
    ["filtro", () => response(valid, { finish: "content_filter" })],
  ] as const)("salida inválida (%s) consume tokens y usa fallback sin cerrar el circuito", async (_name, badResponse) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(badResponse()).mockImplementation(async () => response());
    const afterRequest = vi.fn(async () => {});
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => "id", afterRequest });
    await generate(request);
    await generate(request);
    expect(transport.mock.calls[2]?.[0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(afterRequest.mock.calls[0]).toEqual(["id", { inputTokens: 121, outputTokens: 34, result: "failed" }]);
  });

  it("distingue agotamiento de proveedores y salida inválida", async () => {
    const unavailableFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 402 }));
    const unavailable = createFreeRouter({ providers, timeoutMs: 1000, fetch: unavailableFetch });
    await expect(unavailable(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    await expect(unavailable(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(unavailableFetch).toHaveBeenCalledTimes(2);
    const invalid = createFreeRouter({ providers, timeoutMs: 1000, fetch: async () => response("oops") });
    await expect(invalid(request)).rejects.toMatchObject({ code: "LLM_OUTPUT_INVALID" });
    const empty = createFreeRouter({ providers: [], timeoutMs: 1000 });
    await expect(empty(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
  });

  it("OpenRouter solo puntúa: el análisis no cae en él aunque Groq falle", async () => {
    const analysis = { ...request, stage: "analysis" as const };
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 500 }));
    const beforeRequest = vi.fn(async () => "id");
    const both = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest });
    await expect(both(analysis)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(transport.mock.calls.map(call => call[0])).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    expect(beforeRequest).toHaveBeenCalledTimes(1);

    // Solo OpenRouter: indisponible sin reservar cupo ni tocar la red, para que la noticia se reintente.
    const orFetch = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const orReserve = vi.fn(async () => "id");
    const onlyOr = createFreeRouter({ providers: [providers[1]!], timeoutMs: 1000, fetch: orFetch, beforeRequest: orReserve });
    await expect(onlyOr(analysis)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(orFetch).not.toHaveBeenCalled();
    expect(orReserve).not.toHaveBeenCalled();
    await expect(onlyOr(request)).resolves.toEqual(valid);
  });

  it("prohíbe modelos OpenRouter de pago y fija el filtro de coste cero", async () => {
    expect(() => createFreeRouter({ providers: [{ ...providers[1]!, modelAnalysis: "anthropic/claude-sonnet-4" }], timeoutMs: 1000 })).toThrow("exige");
    expect(() => createFreeRouter({ providers: [{ ...providers[1]!, modelScoring: "openrouter/free " }], timeoutMs: 1000 })).toThrow("exige");
    expect(() => createFreeRouter({ providers: [{ ...providers[1]!, modelScoring: "vendor/model:v1.2:free" }], timeoutMs: 1000 })).not.toThrow();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const generate = createFreeRouter({ providers: [providers[1]!], timeoutMs: 1000, fetch: transport });
    await generate({ ...request, maxTokens: 100_000 });
    const init = transport.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "openrouter/free", max_tokens: 8192 });
    // Igualdad exacta: sin data_collection (decisión del 14-09) y sin perder el precio cero.
    expect(body.provider).toEqual({ require_parameters: true, max_price: { prompt: 0, completion: 0 } });
  });

  it("esquema anidado cerrado y límite de tokens fijado por el caller", async () => {
    const nested = z.object({ object: z.object({ optional: z.string().optional() }), list: z.array(z.object({ x: z.number() })) });
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response({ object: { optional: "ok" }, list: [{ x: 1 }] }));
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport });
    await generate({ ...request, schema: nested, stage: "analysis", maxTokens: 4096 });
    const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.reasoning_effort).toBe("low");
    expect(body.response_format.json_schema.strict).toBe(true);
    const jsonSchema = body.response_format.json_schema.schema;
    expect(jsonSchema.required).toEqual(["object", "list"]);
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties.object.required).toEqual(["optional"]);
    expect(jsonSchema.properties.object.additionalProperties).toBe(false);
    expect(jsonSchema.properties.list.items.additionalProperties).toBe(false);
    await generate({ ...request, schema: nested, maxTokens: 256 });
    expect(JSON.parse(String(transport.mock.calls[1]?.[1]?.body)).max_completion_tokens).toBe(256);
  });

  it("persiste el modelo resuelto y descarta nombres sin formato o excesivos", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(valid, { model: "vendor/model:v1.2:free" }))
      .mockResolvedValueOnce(response(valid, { model: "texto secreto con espacios" }))
      .mockResolvedValueOnce(response(valid, { model: "x".repeat(201) }));
    const afterRequest = vi.fn(async () => {});
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => "id", afterRequest });
    await generate(request);
    await generate(request);
    await generate(request);
    expect(afterRequest.mock.calls[0]).toEqual(["id", { inputTokens: 121, outputTokens: 34, result: "success", resolvedModel: "vendor/model:v1.2:free" }]);
    expect(afterRequest.mock.calls[1]).toEqual(["id", { inputTokens: 121, outputTokens: 34, result: "success" }]);
    expect(afterRequest.mock.calls[2]).toEqual(["id", { inputTokens: 121, outputTokens: 34, result: "success" }]);
  });

  it("presupuesto agotado impide cualquier petición y no intenta fallback", async () => {
    const transport = vi.fn<typeof fetch>();
    const budget = Object.assign(new Error("limit"), { code: "AI_BUDGET_EXHAUSTED" });
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => { throw budget; } });
    await expect(generate(request)).rejects.toBe(budget);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([200, 429])("persistencia fallida tras HTTP %s nunca repite la petición en otro proveedor", async status => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => status === 200 ? response() : new Response("", { status }));
    const databaseError = new Error("DB unavailable");
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => "id", afterRequest: async () => { throw databaseError; } });
    await expect(generate(request)).rejects.toBe(databaseError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reserva tiempo al fallback y aborta el proveedor que excede su parte", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Promise<Response>(() => {}))
      .mockImplementation(async () => response());
    const afterRequest = vi.fn(async () => {});
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport, beforeRequest: async () => "id", afterRequest });
    const result = generate(request);
    await vi.advanceTimersByTimeAsync(501);
    await expect(result).resolves.toEqual(valid);
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(afterRequest.mock.calls[0]).toEqual(["id", { inputTokens: null, outputTokens: null, result: "uncertain", retryAt: expect.any(String) }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dos proveedores colgados comparten un único límite temporal", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport });
    const result = expect(generate(request)).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limita respuestas HTTP excesivas y sigue al fallback", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("x".repeat(128 * 1024 + 1)))
      .mockImplementation(async () => response());
    const generate = createFreeRouter({ providers, timeoutMs: 1000, fetch: transport });
    await expect(generate(request)).resolves.toEqual(valid);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
