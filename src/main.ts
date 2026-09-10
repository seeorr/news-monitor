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
 *   npm start -- --force   ignora el registro de vistos y el reclamo de entrega;
 *                          es la única forma de reenviar una alerta a mano
 */
import { randomUUID } from "node:crypto";
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
import { registrarEmbudoFeeds } from "./pipeline/diagnostico.ts";
import { priorizarGrupos } from "./pipeline/prioridad.ts";
import { createLogger, type LogFields, type LogStage } from "./lib/log.ts";
import { applyRules, mereceAlerta } from "./pipeline/rules.ts";
import {
  fileSeenStore, type EstadoEntrega, type Puntuacion, type SeenStore,
} from "./pipeline/seen.ts";

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
  const watchlist = vigilados;
  const candidatos = frescos.filter((e) => applyRules(e, { watchlist }).pass);
  log("RULES", { stage, count: candidatos.length, discarded: frescos.length - candidatos.length });

  // ── Paso 2: deduplicación ──────────────────────────────────────────────────
  stage = "dedupe";
  const nuevos: NormalizedEvent[] = [];
  for (const event of porFecha(candidatos)) {
    if (force || !(await seen.has(event.id))) nuevos.push(event);
  }
  log("DEDUPE", { stage, count: nuevos.length, discarded: candidatos.length - nuevos.length });
  registrarEmbudoFeeds({ events, fresh: frescos, candidates: candidatos, nuevos, watchlist }, log);
  if (nuevos.length === 0) return 0;

  // ── Paso 2b: la misma historia contada por varios ──────────────────────────
  stage = "group";
  const grupos = priorizarGrupos(agrupar(nuevos, { umbral: config.umbralAgrupacion }));
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
        force,
        // El techo del modelo caro se comprueba aquí y no dentro: el orden del
        // bucle (oficiales primero, después rondas por feed) reparte ese cupo.
        analisisProfundo: profundos < config.maxDeepPerCycle,
      });
      if (resultado.deep) profundos++;
      if (resultado.enviada) enviadas++;
      // Una alerta que se compuso y no llegó a entregarse cuenta como fallo
      // aunque nadie lanzara: es lo que tiene que poner el job en rojo.
      if (resultado.fallida) fallidos++;
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
  /** `--force`: reclama la entrega aunque ya tenga dueño. Lo pide una persona. */
  force: boolean;
  analisisProfundo: boolean;
}

/**
 * `fallida` no es lo contrario de `enviada`: un evento que no llega al umbral no
 * se envía y no ha fallado nada. Marca las alertas que sí se compusieron y no se
 * pudieron dar por entregadas, que son las que hay que mirar.
 */
interface Resultado {
  enviada: boolean;
  deep: boolean;
  fallida?: boolean;
}

async function procesar(
  grupo: Grupo,
  { config, deps, seen, dry, force, analisisProfundo }: ProcesarDeps,
): Promise<Resultado> {
  const event = grupo.representante;
  stage = "scoring";
  const scoring = await scoreEvent(event, deps);
  log("SCORED", { stage, source: event.source, feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
    importance: scoring.importance_score, impact: scoring.market_impact_score });

  const puntuacion: Puntuacion = {
    importance: scoring.importance_score,
    impact: scoring.market_impact_score,
    sentiment: scoring.sentiment,
    oneLiner: scoring.one_liner,
  };

  if (!mereceAlerta(event, scoring, config.alertThreshold)) {
    log("ALERT_SKIPPED", { stage, source: event.source, feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
      importance: scoring.importance_score, impact: scoring.market_impact_score });
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

  const deep = analysis !== null;

  if (dry) {
    log("DRY_RUN", { stage });
    return { enviada: false, deep };
  }
  // Sin credenciales no se reclama nada: el evento vuelve entero en la siguiente
  // vuelta, que es lo que se quiere cuando falta una variable de entorno.
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("TELEGRAM_MISSING", { stage: "telegram" });
    return { enviada: false, deep };
  }

  // ── Reclamar, enviar, cerrar ───────────────────────────────────────────────
  // El orden es el arreglo entero. Antes se enviaba y se registraba después, así
  // que morir en los quince segundos de red de Telegram dejaba el registro vacío
  // y la vuelta siguiente escribía otra vez al teléfono de alguien: el índice
  // único de `alerts` impide duplicar la fila, no retirar un mensaje entregado.
  //
  // Es el mismo patrón que ya usa el resumen matinal en `src/pipeline/brief.ts`.
  stage = "persist";
  const token = randomUUID();
  const reclamada = await seen.claimAlert(event.id, { token, force });

  // Marcar va justo después del reclamo y **pase lo que pase con él**. Si el
  // reclamo es ajeno y el evento se quedara sin marcar, volvería cada media hora
  // a puntuarse con Haiku para chocar otra vez contra el mismo reclamo.
  await marcarGrupo(seen, grupo, puntuacion);

  if (!reclamada) {
    // Ni en vuelo, ni entregada, ni en duda: nada de eso se reenvía solo.
    log("ALERT_BLOCKED", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }

  stage = "telegram";
  let estado: EstadoEntrega;
  try {
    estado = (await sendTelegram(config.telegramBotToken, config.telegramChatId, text)).state;
  } catch {
    // Timeout, DNS, socket cortado. Pudo llegar: no se sabe y no se finge saber.
    estado = "uncertain";
  }

  stage = "persist";
  try {
    // `analysis` viaja entero a la base, además de formateado dentro de `text`.
    // Antes solo iba la prosa: se pagaba Opus por un análisis que la base no
    // podía consultar y la ficha de detalle no tenía de dónde sacar
    // catalizadores, riesgos ni activos afectados.
    //
    // Solo se escribe si Telegram lo aceptó, porque `alerts` significa lo que de
    // verdad salió y el dashboard lo lee con ese significado.
    if (estado === "sent") {
      await seen.saveAlert(event, { ...puntuacion, deep, body: text, analysis });
    }
    await seen.finishAlert(event.id, token, estado);
  } catch {
    // Se perdió el acuse de Neon. La entrega se queda en `sending` y nadie la
    // libera: preferible una alerta sin cerrar a una alerta repetida. No se
    // cuenta como enviada aunque saliera, porque lo que no se pudo registrar no
    // se puede afirmar.
    log("ALERT_RECORD_FAILED", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }

  if (estado !== "sent") {
    log(estado === "rejected" ? "ALERT_REJECTED" : "ALERT_UNCERTAIN", { stage, source: event.source });
    return { enviada: false, deep, fallida: true };
  }
  log("ALERT_SENT", { stage, source: event.source });

  await copiarAlGrupo(config, event, text);
  return { enviada: true, deep };
}

/**
 * La misma alerta, íntegra, al grupo compartido.
 *
 * **El grupo ve exactamente lo mismo que el chat privado**, y eso incluye los
 * movimientos de precio y los documentos ante la SEC de la watchlist, que solo
 * existen porque esos valores están vigilados. Es decisión explícita de Alberto,
 * tomada con la fuga delante: el sistema revela **qué** empresas sigue, no
 * **cuánto** tiene en cada una, y esa asimetría le vale.
 *
 * Se dice aquí porque es justo el tipo de cosa que dentro de seis meses parece
 * un descuido. No lo es. Si algún día deja de valer, el sitio donde filtrar es
 * este, y el criterio defendible sería "solo lo que el monitor habría marcado
 * con la watchlist vacía".
 *
 * Va al final, después de que la entrega privada esté cerrada, y sigue ahí por lo
 * mismo de siempre: si el proceso muere durante estos quince segundos de red, la
 * alerta privada ya está entregada y anotada, y no se repite en la vuelta
 * siguiente. El grupo es el destino secundario y paga él ese riesgo —no tiene
 * reclamo propio, así que un `--force` le manda una copia otra vez—.
 *
 * Nada de lo que ocurra aquí puede tumbar el ciclo ni tocar el resultado de la
 * alerta privada, que es la que importa: se registra qué pasó y se sigue. Un
 * fallo se reintenta solo si el evento vuelve a alertar, cosa que no pasará —el
 * registro de vistos ya lo tiene—, así que un rechazo del grupo es una alerta
 * perdida **para el grupo** y hay que poder verlo en el log.
 */
async function copiarAlGrupo(config: Config, event: NormalizedEvent, text: string): Promise<void> {
  if (!config.telegramGroupChatId || !config.telegramBotToken) return;
  try {
    const copia = await sendTelegram(config.telegramBotToken, config.telegramGroupChatId, text);
    log(copia.ok ? "GROUP_SENT" : "GROUP_REJECTED", { stage: "telegram", source: event.source });
  } catch (err) {
    log("GROUP_FAILED", { stage: "telegram", source: event.source, error: err });
  }
}

/**
 * El grupo entero queda registrado, no solo el que se anunció.
 *
 * Si los duplicados no se marcan, vuelven en la vuelta siguiente sin su
 * representante —que ya está visto— y entonces sí se puntúan y se anuncian por
 * separado. El agrupamiento habría servido para retrasar el ruido quince
 * minutos.
 *
 * En el camino de la alerta esto ocurre **antes** de enviar, y no después como
 * antes: marcar es barato y reversible, enviar no. Lo caro es lo que tiene que
 * quedarse para el final.
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
