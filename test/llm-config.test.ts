import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredFreeProviders, loadConfig, missingVars } from "../src/config.ts";

afterEach(() => vi.unstubAllEnvs());
function clean() {
  for (const name of ["LLM_PROVIDERS", "GROQ_API_KEY", "OPENROUTER_API_KEY", "GROQ_MODEL_SCORING", "GROQ_MODEL_ANALYSIS", "GROQ_MODEL_FALLBACK", "OPENROUTER_MODEL"]) vi.stubEnv(name, "");
}
describe("configuración gratuita real", () => {
  it("una clave Anthropic antigua no activa pagos en la ruta por defecto", () => {
    clean(); vi.stubEnv("ANTHROPIC_API_KEY", "private-placeholder");
    const c = loadConfig();
    expect(c.llmProviders).toEqual(["groq", "openrouter"]);
    expect(configuredFreeProviders(c)).toEqual([]);
    expect(missingVars(c).map((x) => x.name)).toContain("GROQ_API_KEY");
  });
  it("basta una clave de respaldo y se respeta el orden configurado", () => {
    clean(); vi.stubEnv("OPENROUTER_API_KEY", "test");
    expect(configuredFreeProviders(loadConfig()).map((x) => x.name)).toEqual(["openrouter"]);
    expect(missingVars(loadConfig()).map((x) => x.name)).not.toContain("GROQ_API_KEY");
    vi.stubEnv("GROQ_API_KEY", "test"); vi.stubEnv("LLM_PROVIDERS", "openrouter,groq");
    expect(configuredFreeProviders(loadConfig()).map((x) => x.name)).toEqual(["openrouter", "groq"]);
  });
  it.each(["anthropic,groq", "groq,groq", "gemini", "groq,", "__proto__"])("rechaza rutas ambiguas o de pago accidental: %s", (value) => {
    clean(); vi.stubEnv("LLM_PROVIDERS", value);
    expect(() => loadConfig()).toThrow("invalid_llm_providers");
  });
  it("Anthropic requiere ruta exclusiva explícita", () => {
    clean(); vi.stubEnv("LLM_PROVIDERS", "anthropic"); vi.stubEnv("ANTHROPIC_API_KEY", "test");
    expect(configuredFreeProviders(loadConfig())).toEqual([]);
    expect(missingVars(loadConfig()).map((x) => x.name)).not.toContain("ANTHROPIC_API_KEY");
  });
  it("rechaza modelos OpenRouter de pago", () => {
    clean(); vi.stubEnv("OPENROUTER_MODEL", "openai/paid");
    expect(() => loadConfig()).toThrow("invalid_openrouter_free_model");
  });
  it("solo acepta modelos Groq auditados con structured outputs", () => {
    clean(); vi.stubEnv("GROQ_MODEL_ANALYSIS", "arbitrary-model");
    expect(() => loadConfig()).toThrow("invalid_groq_model");
  });
  it("Groq usa gpt-oss-20b como respaldo ante 429 salvo que se apague con none", () => {
    clean(); vi.stubEnv("GROQ_API_KEY", "test"); vi.stubEnv("LLM_PROVIDERS", "groq");
    expect(configuredFreeProviders(loadConfig())[0]).toMatchObject({ modelScoring: "openai/gpt-oss-120b", modelFallback: "openai/gpt-oss-20b" });
    vi.stubEnv("GROQ_MODEL_FALLBACK", "none");
    expect(configuredFreeProviders(loadConfig())[0]!.modelFallback).toBeNull();
    vi.stubEnv("GROQ_MODEL_FALLBACK", "llama-de-pago");
    expect(() => loadConfig()).toThrow("invalid_groq_model");
  });
  it("cargar configuración comprueba relaciones de cuotas sin llamada adicional", () => {
    clean(); vi.stubEnv("BRIEF_NEWS_PER_HOUR", "7"); vi.stubEnv("BRIEF_NEWS_PER_DAY", "1");
    expect(() => loadConfig()).toThrow("invalid_quota_relation");
  });
});
