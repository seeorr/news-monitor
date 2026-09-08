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
 * 3. Hay techo de llamadas al modelo por ciclo. El cron corre cada 15 minutos y
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
import { describeMissing, loadConfig, loadDotEnv, missingVars, type Config } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { agrupar, tambienLoCuentan, type Grupo } from "./pipeline/agrupar.ts";
import { collectEvents, porFecha, recientes } from "./pipeline/collect.ts";
import { applyRules, mereceAlerta } from "./pipeline/rules.ts";
import { fileSeenStore, type SeenStore } from "./pipeline/seen.ts";
import { formatAlert, sendTelegram } from "./notify/telegram.ts";
import type { NormalizedEvent } from "./schema/event.ts";

const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");

  loadDotEnv();
  const config = loadConfig();
  const missing = missingVars(config);

  log("── News Monitor ──");
  if (missing.length > 0) log(describeMissing(missing) + "\n");

  const seen = abrirEstado(config);
  const retrievedAt = new Date().toISOString();

  // ── Ingesta ────────────────────────────────────────────────────────────────
  const { events, failures, ok, vigilados } = await collectEvents(config, { retrievedAt, log });
  if (ok === 0) {
    log("\n✕ Ninguna fuente ha respondido. No hay nada que analizar: se aborta el ciclo.");
    return 1;
  }
  if (failures.length > 0) {
    log(`· ${failures.length} fuente(s) caída(s); se sigue con las ${ok} que respondieron.`);
  }

  // ── Frescura ───────────────────────────────────────────────────────────────
  const frescos = recientes(events, { now: new Date(), maxAgeHours: config.maxItemAgeHours });
  log(
    `· ${events.length} evento(s) recogidos; ${frescos.length} dentro de las últimas ` +
      `${config.maxItemAgeHours} h (un dato macro no caduca por fecha, un titular sí).`,
  );

  // ── Paso 1: reglas ─────────────────────────────────────────────────────────
  // La watchlist del filtro es la misma que la de la ingesta: si se vigila a una
  // empresa, su nombre en un titular también cuenta.
  const watchlist = vigilados.map((v) => v.ticker);
  const candidatos = frescos.filter((e) => applyRules(e, { watchlist }).pass);
  log(
    `· Filtro por reglas: pasan ${candidatos.length}, descartados ` +
      `${frescos.length - candidatos.length} sin gastar una llamada al modelo.`,
  );

  // ── Paso 2: deduplicación ──────────────────────────────────────────────────
  const nuevos: NormalizedEvent[] = [];
  for (const event of porFecha(candidatos)) {
    if (force || !(await seen.has(event.id))) nuevos.push(event);
  }
  log(`· Nuevos: ${nuevos.length} (${candidatos.length - nuevos.length} ya procesados).`);
  if (nuevos.length === 0) return 0;

  // ── Paso 2b: la misma historia contada por varios ──────────────────────────
  const grupos = agrupar(nuevos, { umbral: config.umbralAgrupacion });
  const fundidos = nuevos.length - grupos.length;
  if (fundidos > 0) {
    log(`· ${fundidos} titular(es) eran la misma historia ya contada: un aviso, no varios.`);
  }

  if (!config.anthropicApiKey) {
    log("\n✕ Sin ANTHROPIC_API_KEY no se puede puntuar nada. Se detiene aquí.");
    return 1;
  }

  const deps: CascadeDeps = {
    client: new Anthropic({ apiKey: config.anthropicApiKey }),
    modelScoring: config.modelScoring,
    modelAnalysis: config.modelAnalysis,
    onFabrication: (intento, violations) =>
      log(`  · Intento ${intento} descartado: ${violations.join("; ")}`),
  };

  const porPuntuar = grupos.slice(0, config.maxScoringPerCycle);
  if (grupos.length > porPuntuar.length) {
    log(
      `· Techo del ciclo: se puntúan ${porPuntuar.length} y ${grupos.length - porPuntuar.length} ` +
        "esperan a la vuelta siguiente. Lo más reciente va primero.",
    );
  }

  // ── Pasos 3 y 4, y alerta ──────────────────────────────────────────────────
  let profundos = 0;
  let enviadas = 0;
  let fallidos = 0;

  for (const grupo of porPuntuar) {
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
      log(`✕ ${grupo.representante.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `\n── Ciclo terminado: ${enviadas} alerta(s), ${profundos} análisis profundo(s), ` +
      `${fallidos} evento(s) con error. ──`,
  );

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
  const scoring = await scoreEvent(event, deps);
  log(
    `\n▸ ${event.title}\n  ${scoring.importance_score}/10 · ${scoring.sentiment} · ${event.source}`,
  );

  if (!mereceAlerta(event, scoring, config.alertThreshold)) {
    log("  · No merece alerta. Registrado y a otra cosa.");
    if (!dry) await marcarGrupo(seen, grupo);
    return { enviada: false, deep: false };
  }

  let analysis: Analysis | null = null;
  if (scoring.importance_score >= config.deepAnalysisThreshold && analisisProfundo) {
    try {
      analysis = await analyzeEvent(event, deps);
      log(`  ✓ Análisis profundo (${config.modelAnalysis})`);
    } catch (err) {
      // Que el modelo se invente una cifra no puede tumbar el ciclo: se manda la
      // alerta corta, que es cierta, en vez de callarse. Cualquier otro error sí
      // sube: un fallo de red o de credenciales no debe pasar desapercibido.
      if (!(err instanceof FabricationError)) throw err;
      log(`  · ${err.message}`);
      log("    Se degrada al resumen del scoring: mejor corta y cierta que larga e inventada.");
    }
  } else if (scoring.importance_score >= config.deepAnalysisThreshold) {
    log("  · Techo de análisis profundos del ciclo: va el resumen del scoring.");
  }

  const text = formatAlert(event, scoring, analysis, { tambien: tambienLoCuentan(grupo) });
  log("\n" + text + "\n");

  if (dry) {
    log("  --dry: no se envía ni se registra.");
    return { enviada: false, deep: analysis !== null };
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("  · Sin credenciales de Telegram: alerta compuesta pero no enviada. No se registra.");
    return { enviada: false, deep: analysis !== null };
  }

  const sent = await sendTelegram(config.telegramBotToken, config.telegramChatId, text);
  if (!sent.ok) {
    // Sin registrar: se reintenta en la vuelta siguiente. Es preferible arriesgar
    // un duplicado a perder la alerta.
    throw new Error(`Telegram rechazó el mensaje: ${sent.description ?? "sin detalle"}`);
  }

  await seen.saveAlert(event, {
    importance: scoring.importance_score,
    impact: scoring.market_impact_score,
    sentiment: scoring.sentiment,
    deep: analysis !== null,
    body: text,
  });
  await marcarDuplicados(seen, grupo);
  log("  ✓ Enviada a Telegram y registrada.");
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
async function marcarGrupo(seen: SeenStore, grupo: Grupo): Promise<void> {
  await seen.mark(grupo.representante);
  await marcarDuplicados(seen, grupo);
}

async function marcarDuplicados(seen: SeenStore, grupo: Grupo): Promise<void> {
  for (const duplicado of grupo.duplicados) await seen.mark(duplicado);
}

/** El archivo local no sobrevive a un job de Actions: en producción manda Neon. */
function abrirEstado(config: Config): SeenStore {
  if (config.databaseUrl) {
    log("· Estado en Neon.");
    return neonSeenStore(config.databaseUrl);
  }
  log(`· Estado en ${config.stateDir}/seen.json (local; en Actions no persiste).`);
  return fileSeenStore(config.stateDir);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("✕ Error no controlado:", err);
    process.exit(1);
  });
