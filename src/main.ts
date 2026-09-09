/**
 * El ciclo completo:
 *
 *   FRED + feeds + SEC EDGAR → normalización → frescura → filtro por reglas →
 *   dedupe → scoring → análisis (solo si importa) → Telegram → Neon
 *
 * Ya no es un slice vertical de un solo dato: son tres fuentes y N eventos por
 * vuelta. Tres reglas gobiernan el bucle, y las tres nacen del mismo miedo —que
 * el monitor se calle justo cuando hay noticia—:
 *
 * 1. Una fuente caída no tumba el ciclo; se sigue con las demás y se dice cuál.
 * 2. Un evento que falla no tumba a los siguientes.
 * 3. Hay techo de llamadas al modelo por ciclo. El ciclo corre cada 30 minutos y
 *    un feed puede soltar treinta elementos de golpe el primer día.
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
import { loadConfig, loadDotEnv, missingVars, type Config } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { agrupar, tambienLoCuentan, type Grupo } from "./pipeline/agrupar.ts";
import { collectEvents, porFecha, recientes } from "./pipeline/collect.ts";
import { createLogger, type LogFields, type LogStage } from "./lib/log.ts";
import { applyRules, mereceAlerta } from "./pipeline/rules.ts";
import { fileSeenStore, type Puntuacion, type SeenStore } from "./pipeline/seen.ts";
import { formatAlert, sendTelegram } from "./notify/telegram.ts";
import type { NormalizedEvent } from "./schema/event.ts";

// Seguro desde el arranque, incluso antes de cargar configuración y watchlist.
const log = createLogger();
let stage: LogStage = "startup";

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");

  loadDotEnv();
  const config = loadConfig();
  const missing = missingVars(config);

  log("CYCLE_START", { stage });
  for (const variable of missing) {
    // El logger valida también el nombre contra su enum cerrado en ejecución.
    log("CONFIG_MISSING", { stage, count: missing.length, variable: variable.name as LogFields["variable"] });
  }

  const seen = abrirEstado(config);
  const retrievedAt = new Date().toISOString();

  // ── Ingesta ────────────────────────────────────────────────────────────────
  stage = "collect";
  const { events, failures, ok, vigilados } = await collectEvents(config, { retrievedAt, logger: log });
  if (ok === 0) {
    log("NO_SOURCES", { stage, failed: failures.length });
    return 1;
  }
  if (failures.length > 0) {
    log("SOURCES_PARTIAL", { stage, failed: failures.length, ok });
  }

  // ── Frescura ───────────────────────────────────────────────────────────────
  stage = "freshness";
  const frescos = recientes(events, { now: new Date(), maxAgeHours: config.maxItemAgeHours });
  log("FRESHNESS", { stage, total: events.length, count: frescos.length });

  // ── Paso 1: reglas ─────────────────────────────────────────────────────────
  // La watchlist del filtro es la misma que la de la ingesta: si se vigila a una
  // empresa, su nombre en un titular también cuenta.
  stage = "rules";
  const watchlist = vigilados.map((v) => v.ticker);
  const candidatos = frescos.filter((e) => applyRules(e, { watchlist }).pass);
  log("RULES", { stage, count: candidatos.length, discarded: frescos.length - candidatos.length });

  // ── Paso 2: deduplicación ──────────────────────────────────────────────────
  stage = "dedupe";
  const nuevos: NormalizedEvent[] = [];
  for (const event of porFecha(candidatos)) {
    if (force || !(await seen.has(event.id))) nuevos.push(event);
  }
  log("DEDUPE", { stage, count: nuevos.length, discarded: candidatos.length - nuevos.length });
  if (nuevos.length === 0) return 0;

  // ── Paso 2b: la misma historia contada por varios ──────────────────────────
  stage = "group";
  const grupos = agrupar(nuevos, { umbral: config.umbralAgrupacion });
  const fundidos = nuevos.length - grupos.length;
  if (fundidos > 0) {
    log("GROUPED", { stage, count: grupos.length, discarded: fundidos });
  }

  if (!config.anthropicApiKey) {
    log("SCORING_UNAVAILABLE", { stage: "scoring" });
    return 1;
  }

  const deps: CascadeDeps = {
    client: new Anthropic({ apiKey: config.anthropicApiKey }),
    modelScoring: config.modelScoring,
    modelAnalysis: config.modelAnalysis,
    onFabrication: (intento, violations) =>
      log("FABRICATION_RETRY", { stage: "analysis", attempt: intento, count: violations.length }),
  };

  const porPuntuar = grupos.slice(0, config.maxScoringPerCycle);
  if (grupos.length > porPuntuar.length) {
    log("SCORING_LIMIT", { stage: "scoring", count: porPuntuar.length, discarded: grupos.length - porPuntuar.length });
  }

  // ── Pasos 3 y 4, y alerta ──────────────────────────────────────────────────
  let profundos = 0;
  let enviadas = 0;
  let fallidos = 0;

  for (const [index, grupo] of porPuntuar.entries()) {
    try {
      const resultado = await procesar(grupo, {
        config,
        deps,
        seen,
        dry,
        // El techo del modelo caro se comprueba aquí y no dentro: el orden del
        // bucle (lo más reciente primero) es el que decide quién se lo lleva.
        analisisProfundo: profundos < config.maxDeepPerCycle,
      });
      if (resultado.deep) profundos++;
      if (resultado.enviada) enviadas++;
    } catch (err) {
      // Un evento que revienta no puede llevarse por delante a los que quedan:
      // el siguiente puede ser el que importaba.
      fallidos++;
      log("EVENT_FAILED", { stage, source: grupo.representante.source, index: index + 1, error: err });
    }
  }

  log("CYCLE_END", { stage: "cycle", sent: enviadas, deep: profundos, failed: fallidos });

  // Que no haya nada que contar es un final normal. Que fallara todo lo que se
  // intentó, no: eso tiene que salir en rojo y disparar el aviso del workflow.
  return fallidos > 0 && enviadas === 0 ? 1 : 0;
}

interface ProcesarDeps {
  config: Config;
  deps: CascadeDeps;
  seen: SeenStore;
  dry: boolean;
  analisisProfundo: boolean;
}

async function procesar(
  grupo: Grupo,
  { config, deps, seen, dry, analisisProfundo }: ProcesarDeps,
): Promise<{ enviada: boolean; deep: boolean }> {
  const event = grupo.representante;
  stage = "scoring";
  const scoring = await scoreEvent(event, deps);
  log("SCORED", { stage, source: event.source });

  const puntuacion: Puntuacion = {
    importance: scoring.importance_score,
    impact: scoring.market_impact_score,
    sentiment: scoring.sentiment,
    oneLiner: scoring.one_liner,
  };

  if (!mereceAlerta(event, scoring, config.alertThreshold)) {
    log("ALERT_SKIPPED", { stage, source: event.source });
    stage = "persist";
    if (!dry) await marcarGrupo(seen, grupo, puntuacion);
    return { enviada: false, deep: false };
  }

  let analysis: Analysis | null = null;
  if (scoring.importance_score >= config.deepAnalysisThreshold && analisisProfundo) {
    try {
      stage = "analysis";
      analysis = await analyzeEvent(event, deps);
      log("ANALYSIS_OK", { stage, source: event.source });
    } catch (err) {
      // Que el modelo se invente una cifra no puede tumbar el ciclo: se manda la
      // alerta corta, que es cierta, en vez de callarse. Cualquier otro error sí
      // sube: un fallo de red o de credenciales no debe pasar desapercibido.
      if (!(err instanceof FabricationError)) throw err;
      log("ANALYSIS_FALLBACK", { stage, source: event.source });
    }
  } else if (scoring.importance_score >= config.deepAnalysisThreshold) {
    log("ANALYSIS_LIMIT", { stage: "analysis", source: event.source });
  }

  stage = "format";
  const text = formatAlert(event, scoring, analysis, { tambien: tambienLoCuentan(grupo) });
  log("ALERT_READY", { stage, source: event.source });

  if (dry) {
    log("DRY_RUN", { stage });
    return { enviada: false, deep: analysis !== null };
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("TELEGRAM_MISSING", { stage: "telegram" });
    return { enviada: false, deep: analysis !== null };
  }

  stage = "telegram";
  const sent = await sendTelegram(config.telegramBotToken, config.telegramChatId, text);
  if (!sent.ok) {
    // Sin registrar: se reintenta en la vuelta siguiente. Es preferible arriesgar
    // un duplicado a perder la alerta.
    throw new Error("TELEGRAM_REJECTED");
  }

  // `analysis` viaja entero a la base, además de formateado dentro de `text`.
  // Antes solo iba la prosa: se pagaba Opus por un análisis que la base no podía
  // consultar y la ficha de detalle no tenía de dónde sacar catalizadores,
  // riesgos ni activos afectados.
  stage = "persist";
  await seen.saveAlert(event, { ...puntuacion, deep: analysis !== null, body: text, analysis });
  await marcarDuplicados(seen, grupo);
  log("ALERT_SENT", { stage, source: event.source });
  return { enviada: true, deep: analysis !== null };
}

/**
 * El grupo entero queda registrado, no solo el que se anunció.
 *
 * Si los duplicados no se marcan, vuelven en la vuelta siguiente sin su
 * representante —que ya está visto— y entonces sí se puntúan y se anuncian por
 * separado. El agrupamiento habría servido para retrasar el ruido quince
 * minutos.
 */
async function marcarGrupo(seen: SeenStore, grupo: Grupo, puntuacion: Puntuacion): Promise<void> {
  await seen.mark(grupo.representante, puntuacion);
  await marcarDuplicados(seen, grupo);
}

/**
 * Los duplicados se marcan **sin** nota. Se parecen al representante lo bastante
 * para no anunciarse dos veces, pero nadie los ha puntuado: copiarle la suya
 * sería inventar una nota que ningún modelo dio.
 */
async function marcarDuplicados(seen: SeenStore, grupo: Grupo): Promise<void> {
  for (const duplicado of grupo.duplicados) await seen.mark(duplicado);
}

/** El archivo local no sobrevive a un job de Actions: en producción manda Neon. */
function abrirEstado(config: Config): SeenStore {
  stage = "persist";
  if (config.databaseUrl) {
    log("STATE_OPEN", { stage, source: "neon" });
    return neonSeenStore(config.databaseUrl);
  }
  log("STATE_OPEN", { stage, source: "file" });
  return fileSeenStore(config.stateDir);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log("UNHANDLED", { stage, error: err });
    process.exit(1);
  });
