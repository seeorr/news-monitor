/** Prueba aislada: una noticia pública fija, sin Neon, watchlist ni Telegram. */
import { configuredFreeProviders, loadConfig, loadDotEnv } from "../src/config.ts";
import { analyzes, createFreeRouter } from "../src/ai/providers.ts";
import { analyzeEvent, scoreEvent, type CascadeDeps } from "../src/ai/cascade.ts";
import { createLogger } from "../src/lib/log.ts";
import { formatImportant, formatInteresting } from "../src/notify/news-formats.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const providers = configuredFreeProviders(config);
  const live = process.argv.slice(2);
  if (live.length > 1 || (live.length === 1 && live[0] !== "--live")) throw new Error("invalid_flags");
  const log = createLogger();
  console.log(JSON.stringify({ code: "LLM_CHECK_CONFIG", configured: providers.map((p) => p.name),
    live: live.length === 1, database: false, telegram: false }));
  if (!providers.length) {
    console.log(JSON.stringify({ code: "LLM_CHECK_MISSING_KEYS" }));
    process.exitCode = 1;
    return;
  }
  if (!live.length) return;
  // Comunicado público histórico del BCE; no se lee la cola ni datos personales.
  const event: NormalizedEvent = {
    id: "verification:ecb:20240606", kind: "news", source: "rss", series_id: "ecb-press",
    source_url: "https://www.ecb.europa.eu/press/pr/date/2024/html/ecb.mp240606~2148ecdb3c.en.html",
    title: "El BCE decide recortar los tres tipos de interés oficiales en 25 puntos básicos",
    summary: "El Consejo de Gobierno decidió recortar los tres tipos de interés oficiales del BCE en 25 puntos básicos. El tipo de la facilidad de depósito queda en el 3,75 %.",
    observed_at: "2024-06-06T12:15:00Z", retrieved_at: "2024-06-06T12:15:00Z",
    country: "EA", actual: null, previous: null, consensus: null, unit: null, surprises: [], stale: false, official: true,
  };
  let calls = 0;
  const deps: CascadeDeps = { modelScoring: "free", modelAnalysis: "free",
    generate: createFreeRouter({ providers, timeoutMs: 60_000,
      beforeRequest: async () => String(++calls),
      afterRequest: async (_id, result) => {
        console.log(JSON.stringify({ code: "LLM_CHECK_ATTEMPT", result: result.result,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
      },
      onFailure: (provider, error) => log("LLM_PROVIDER_FAILED", { provider, error }),
    }) };
  const score = await scoreEvent(event, deps);
  formatInteresting(event, score);
  // OpenRouter no analiza (ver analyzes()): probarlo ahí fallaría siempre y no diría nada nuevo.
  const analysisUsed = providers.some((p) => analyzes(p.name));
  if (analysisUsed) formatImportant(event, score, await analyzeEvent(event, deps));
  console.log(JSON.stringify({ code: "LLM_CHECK_OK", calls, scoring: true, analysis: analysisUsed,
    analysisSkippedByDesign: !analysisUsed, schemaAndNumericalChecks: true, editorialQualityReviewed: false }));
}
main().catch((error) => { createLogger()("EVENT_FAILED", { error }); process.exitCode = 1; });
