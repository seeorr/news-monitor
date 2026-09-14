/** Transporte gratuito con circuito local y espera durable. Nunca registra prompts ni respuestas. */
import { z } from "zod";

export type ProviderName = "groq" | "openrouter" | "anthropic";
type FreeProviderName = Exclude<ProviderName, "anthropic">;
export type RequestInfo = {
  stage: "scoring" | "analysis";
  model: string;
  provider: ProviderName;
  promptVersion: string;
  attempt: number;
};
export type RequestResult = {
  inputTokens: number | null;
  outputTokens: number | null;
  result: "success" | "failed" | "uncertain";
  resolvedModel?: string;
  retryAt?: string;
};
export interface StructuredRequest<T> {
  stage: "scoring" | "analysis";
  attempt: number;
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
}
export type StructuredGenerate = <T>(request: StructuredRequest<T>) => Promise<T>;
interface FreeProvider {
  name: FreeProviderName;
  apiKey: string;
  modelScoring: string;
  modelAnalysis: string;
}
interface RouterOptions {
  providers: FreeProvider[];
  timeoutMs: number;
  fetch?: typeof fetch;
  beforeRequest?: (info: RequestInfo) => Promise<string>;
  afterRequest?: (id: string, result: RequestResult) => Promise<void>;
  onFailure?: (provider: FreeProviderName, error: unknown) => void;
  /** Lectura durable antes de reservar: una espera no consume intento. */
  getRetryAt?: (provider: FreeProviderName, now: string) => Promise<string | null>;
}

export class FreeLlmError extends Error {
  constructor(readonly code: "LLM_UNAVAILABLE" | "LLM_OUTPUT_INVALID", message: string) {
    super(message);
    this.name = "FreeLlmError";
  }
}

class ProviderFailure extends Error {
  readonly code: "LLM_OUTPUT_INVALID" | "LLM_REQUEST_FAILED" | "REQUEST_TIMEOUT";
  constructor(readonly reason: "http" | "network" | "timeout" | "output", readonly status?: number) {
    super(`LLM gratuito: ${reason}${status === undefined ? "" : ` (${status})`}`);
    this.name = "ProviderFailure";
    this.code = reason === "output" ? "LLM_OUTPUT_INVALID" : reason === "timeout" ? "REQUEST_TIMEOUT" : "LLM_REQUEST_FAILED";
  }
}
type Outcome<T> = {
  value: T;
  usage: RequestResult;
} | {
  error: ProviderFailure;
  disable: boolean;
  retry?: boolean;
  usage: RequestResult;
};

const ENDPOINTS: Record<FreeProviderName, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};
const MAX_RESPONSE_BYTES = 128 * 1024;
const emptyUsage = (result: RequestResult["result"]): RequestResult => ({
  inputTokens: null, outputTokens: null, result,
});

/** Retry-After admite segundos o fecha HTTP. Nunca se almacena su texto libre. */
export function providerRetryAt(status: number | undefined, header: string | null, now = Date.now()): string {
  const fallback = status && [400, 401, 402, 403, 404].includes(status) ? 6 * 3600_000
    : status === 429 ? 15 * 60_000 : 60_000;
  const raw = header?.trim();
  const requested = raw && /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000
    : raw ? Date.parse(raw) : NaN;
  const delay = Number.isFinite(requested) && requested > now ? requested - now : fallback;
  return new Date(now + Math.max(1000, Math.min(delay, 7 * 86400_000))).toISOString();
}
const Envelope = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({ content: z.string().nullable(), refusal: z.unknown().optional() }),
  })).min(1),
});

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function usageOf(body: unknown): RequestResult {
  const usage = body && typeof body === "object" && "usage" in body ? body.usage : undefined;
  const model = body && typeof body === "object" && "model" in body ? body.model : undefined;
  const resolved = typeof model === "string" && model.length <= 200 && /^[\w./:-]+$/.test(model) ? { resolvedModel: model } : {};
  if (!usage || typeof usage !== "object") return { ...emptyUsage("failed"), ...resolved };
  return {
    inputTokens: tokenCount("prompt_tokens" in usage ? usage.prompt_tokens : undefined),
    outputTokens: tokenCount("completion_tokens" in usage ? usage.completion_tokens : undefined),
    result: "failed",
    ...resolved,
  };
}

/** Los servidores de structured outputs exigen todas las claves y objetos cerrados. */
function strictSchema<T>(schema: z.ZodType<T>): unknown {
  const result = z.toJSONSchema(schema);
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as Record<string, unknown>;
    if (object.type === "object" && object.properties && typeof object.properties === "object") {
      object.required = Object.keys(object.properties);
      object.additionalProperties = false;
    }
    Object.values(object).forEach(visit);
  }
  visit(result);
  delete result.$schema;
  return result;
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) throw new ProviderFailure("output");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ProviderFailure("output");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProviderFailure("output");
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function perform<T>(
  transport: typeof fetch, provider: FreeProvider, body: string,
  schema: z.ZodType<T>, timeoutMs: number,
): Promise<Outcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race también limita transportes que no implementen correctamente AbortSignal.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderFailure("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  const call = async (): Promise<Outcome<T>> => {
    const response = await transport(ENDPOINTS[provider.name], {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
      body,
    });
    if (!response.ok) {
      if (response.status === 400 && provider.name === "groq") {
        // Groq puede rechazar una generación incluso con strict=true. Solo se
        // reconoce este código fijo; jamás se guarda ni imprime failed_generation.
        let raw: unknown;
        try { raw = await readBody(response); } catch { /* Se mantiene HTTP 400. */ }
        const failure = z.object({ error: z.object({ code: z.literal("json_validate_failed") }) }).safeParse(raw);
        if (failure.success) return { error: new ProviderFailure("output"), disable: false, retry: true, usage: emptyUsage("failed") };
      }
      // No leemos errores externos: pueden incluir el prompt o credenciales reflejadas.
      void response.body?.cancel().catch(() => {});
      return { error: new ProviderFailure("http", response.status), disable: true,
        usage: { ...emptyUsage("failed"), retryAt: providerRetryAt(response.status, response.headers.get("retry-after")) } };
    }
    const raw = await readBody(response);
    const usage = usageOf(raw);
    const envelope = Envelope.safeParse(raw);
    const choice = envelope.success ? envelope.data.choices[0] : undefined;
    if (!choice || choice.finish_reason !== "stop" || choice.message.refusal || !choice.message.content) {
      return { error: new ProviderFailure("output"), disable: false, usage };
    }
    try {
      const parsed = schema.safeParse(JSON.parse(choice.message.content));
      if (parsed.success) return { value: parsed.data, usage: { ...usage, result: "success" } };
    } catch { /* Un JSON inválido no se incluye nunca en el error. */ }
    return { error: new ProviderFailure("output"), disable: false, usage };
  };
  try {
    return await Promise.race([call(), timeout]);
  } catch (error) {
    const failure = error instanceof ProviderFailure ? error : new ProviderFailure("network");
    return {
      error: failure,
      disable: failure.reason !== "output",
      usage: { ...emptyUsage(failure.reason === "output" ? "failed" : "uncertain"),
        ...(failure.reason !== "output" ? { retryAt: providerRetryAt(undefined, null) } : {}) },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Crear por ciclo: consulta la espera durable y aparta fallos durante la ejecución. */
export function createFreeRouter(options: RouterOptions): StructuredGenerate {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("LLM: timeout inválido");
  const providers = options.providers.map(provider => ({ ...provider }));
  const names = new Set<string>();
  for (const provider of providers) {
    if (!Object.hasOwn(ENDPOINTS, provider.name) || names.has(provider.name) || !provider.apiKey.trim()) {
      throw new Error("LLM: proveedor duplicado o configuración inválida");
    }
    names.add(provider.name);
    for (const model of [provider.modelScoring, provider.modelAnalysis]) {
      if (!model.trim() || (provider.name === "openrouter" && model !== "openrouter/free" && !/^[\w.-]+\/[\w.:-]+:free$/.test(model))) {
        throw new Error("LLM: OpenRouter exige openrouter/free o un modelo :free");
      }
    }
  }
  const disabled = new Set<FreeProviderName>();
  const transport = options.fetch ?? globalThis.fetch;
  return async <T>(request: StructuredRequest<T>): Promise<T> => {
    if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0) throw new Error("LLM: maxTokens inválido");
    const deadline = Date.now() + options.timeoutMs;
    const schema = strictSchema(request.schema);
    const available: FreeProvider[] = [];
    let cooling = 0;
    for (const provider of providers.filter(provider => !disabled.has(provider.name))) {
      const now = new Date().toISOString();
      const retryAt = await options.getRetryAt?.(provider.name, now);
      if (retryAt) {
        if (!z.iso.datetime().safeParse(retryAt).success) throw new Error("invalid_llm_retry_at");
        if (retryAt > now) { cooling++; continue; }
      }
      available.push(provider);
    }
    let deadlineExceeded = false;
    const attempts = new Map<FreeProviderName, number>();
    for (const [index, provider] of available.entries()) {
      if (disabled.has(provider.name)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { deadlineExceeded = true; break; }
      const model = request.stage === "scoring" ? provider.modelScoring : provider.modelAnalysis;
      const maxTokens = Math.min(8192, request.maxTokens);
      const body = JSON.stringify({
        model,
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        response_format: { type: "json_schema", json_schema: { name: request.stage, strict: true, schema } },
        ...(provider.name === "groq" ? { reasoning_effort: "low", max_completion_tokens: maxTokens } : {
          max_tokens: maxTokens,
          provider: { require_parameters: true, data_collection: "deny", max_price: { prompt: 0, completion: 0 } },
        }),
      });
      // La reserva y su persistencia son controles locales: fallar aquí no habilita fallback.
      const id = await options.beforeRequest?.({
        stage: request.stage, model, provider: provider.name,
        promptVersion: request.promptVersion, attempt: request.attempt + (attempts.get(provider.name) ?? 0),
      });
      attempts.set(provider.name, (attempts.get(provider.name) ?? 0) + 1);
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) {
        if (id !== undefined) await options.afterRequest?.(id, emptyUsage("failed"));
        deadlineExceeded = true;
        break;
      }
      const outcome = await perform(transport, provider, body, request.schema, Math.max(1, Math.floor(timeLeft / (available.length - index))));
      if ("error" in outcome && outcome.disable) disabled.add(provider.name);
      // También se contabilizan respuestas rechazadas por el esquema. Un fallo de BD se propaga.
      if (id !== undefined) await options.afterRequest?.(id, outcome.usage);
      if ("value" in outcome) return outcome.value;
      options.onFailure?.(provider.name, outcome.error);
      if (outcome.retry && attempts.get(provider.name) === 1) available.splice(index + 1, 0, provider);
    }
    if (deadlineExceeded || cooling > 0 || providers.every(provider => disabled.has(provider.name))) {
      throw new FreeLlmError("LLM_UNAVAILABLE", "No hay proveedores LLM gratuitos disponibles en este ciclo");
    }
    throw new FreeLlmError("LLM_OUTPUT_INVALID", "Los proveedores gratuitos no devolvieron una respuesta válida");
  };
}
