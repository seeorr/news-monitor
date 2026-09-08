/**
 * Slice vertical del bloque 1, ya con persistencia:
 *   FRED → normalización → filtro por reglas → dedupe → scoring → análisis → Telegram
 *
 * Sin dashboard todavía. El objetivo es demostrar el pipeline entero con un dato
 * real, no tenerlo todo.
 *
 *   npm start              ejecuta el ciclo
 *   npm start -- --dry     todo menos enviar a Telegram
 *   npm start -- --force   ignora el registro de vistos (reenvía)
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  analyzeEvent,
  FabricationError,
  scoreEvent,
  type Analysis,
  type CascadeDeps,
} from "./ai/cascade.ts";
import { describeMissing, loadConfig, loadDotEnv, missingVars } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { HttpError } from "./lib/http.ts";
import { applyRules } from "./pipeline/rules.ts";
import { fileSeenStore, type SeenStore } from "./pipeline/seen.ts";
import { applyTransform, fetchObservations, SERIES, toEvent } from "./sources/fred.ts";
import { formatAlert, sendTelegram } from "./notify/telegram.ts";
import type { NormalizedEvent } from "./schema/event.ts";

const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");

  loadDotEnv();
  const config = loadConfig();
  const missing = missingVars(config);

  log("── News Monitor · bloque 1 ──");
  if (missing.length > 0) {
    log(describeMissing(missing));
    // Sin FRED no hay nada que hacer. Sin lo demás, se degrada y se sigue.
    if (missing.some((m) => m.name === "FRED_API_KEY")) {
      log("\nFRED_API_KEY es imprescindible. Nada que ingerir.");
      return 1;
    }
    log("");
  }

  // El archivo local no sobrevive a un job de Actions: en producción manda Neon.
  let seen: SeenStore;
  if (config.databaseUrl) {
    seen = neonSeenStore(config.databaseUrl);
    log("· Estado en Neon.");
  } else {
    seen = fileSeenStore(config.stateDir);
    log(`· Estado en ${config.stateDir}/seen.json (local; en Actions no persiste).`);
  }

  const spec = SERIES["CPIAUCSL"];
  if (!spec) throw new Error("Serie CPIAUCSL no registrada");

  // ── Ingesta ────────────────────────────────────────────────────────────────
  let event: NormalizedEvent;
  try {
    const raw = await fetchObservations(spec, config.fredApiKey!);
    const series = applyTransform(raw, spec);
    event = toEvent(series, spec, { retrievedAt: new Date().toISOString() });
    log(`✓ FRED: ${spec.title} = ${event.actual}${event.unit} (dato de ${event.observed_at})`);
  } catch (err) {
    const detail = err instanceof HttpError ? `${err.message} — ${err.body}` : String(err);
    log(`✕ FRED falló: ${detail}`);
    log("  Sin dato previo en caché todavía: no se degrada, se aborta el ciclo.");
    return 1;
  }

  // ── Paso 1: reglas ─────────────────────────────────────────────────────────
  const decision = applyRules(event);
  log(`${decision.pass ? "✓" : "·"} Filtro: ${decision.reason}`);
  if (!decision.pass) return 0;

  // ── Paso 2: deduplicación ──────────────────────────────────────────────────
  if ((await seen.has(event.id)) && !force) {
    log(`· Ya procesado (${event.id}). Nada que enviar.`);
    return 0;
  }

  // ── Pasos 3 y 4: cascada ───────────────────────────────────────────────────
  if (!config.anthropicApiKey) {
    log("· Sin ANTHROPIC_API_KEY: no se puede puntuar. Se detiene aquí.");
    return 1;
  }
  const deps: CascadeDeps = {
    client: new Anthropic({ apiKey: config.anthropicApiKey }),
    modelScoring: config.modelScoring,
    modelAnalysis: config.modelAnalysis,
    onFabrication: (intento, violations) =>
      log(`· Intento ${intento} descartado: ${violations.join("; ")}`),
  };

  const scoring = await scoreEvent(event, deps);
  log(`✓ Scoring (${config.modelScoring}): importancia ${scoring.importance_score}/10, ${scoring.sentiment}`);

  let analysis: Analysis | null = null;
  if (scoring.importance_score >= config.deepAnalysisThreshold) {
    try {
      analysis = await analyzeEvent(event, deps);
      log(`✓ Análisis profundo (${config.modelAnalysis})`);
    } catch (err) {
      // Que el modelo se invente una cifra no puede tumbar el ciclo: se manda la
      // alerta corta, que es cierta, en vez de callarse. Cualquier otro error sí
      // sube: un fallo de red o de credenciales no debe pasar desapercibido.
      if (!(err instanceof FabricationError)) throw err;
      log(`· ${err.message}`);
      log("  Se degrada al resumen del scoring: mejor corta y cierta que larga e inventada.");
    }
  } else {
    log(`· Por debajo de ${config.deepAnalysisThreshold}: sin análisis profundo. Ese es el ahorro.`);
  }

  // ── Alerta ─────────────────────────────────────────────────────────────────
  if (!scoring.needs_alert && scoring.importance_score < config.alertThreshold) {
    log("· No merece alerta. Registrado y fin.");
    await seen.mark(event);
    return 0;
  }

  const text = formatAlert(event, scoring, analysis);
  log("\n" + text + "\n");

  if (dry) {
    log("--dry: no se envía ni se registra.");
    return 0;
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("· Sin credenciales de Telegram: alerta compuesta pero no enviada.");
    return 1;
  }

  const sent = await sendTelegram(config.telegramBotToken, config.telegramChatId, text);
  if (!sent.ok) {
    log(`✕ Telegram rechazó el mensaje: ${sent.description ?? "sin detalle"}`);
    return 1; // No se registra: se reintentará en la siguiente ejecución.
  }
  await seen.saveAlert(event, {
    importance: scoring.importance_score,
    impact: scoring.market_impact_score,
    sentiment: scoring.sentiment,
    deep: analysis !== null,
    body: text,
  });
  log("✓ Alerta enviada a Telegram y registrada.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("✕ Error no controlado:", err);
    process.exit(1);
  });
