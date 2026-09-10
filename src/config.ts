/**
 * Configuración por entorno.
 *
 * Regla del spec §8: si falta una variable, **se detecta y se dice cuál**, y se
 * sigue con lo que se pueda. Nunca se inventa una credencial ni se asume que
 * habrá presupuesto para una alternativa de pago.
 */
import { existsSync } from "node:fs";

export interface Config {
  anthropicApiKey: string | null;
  fredApiKey: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /**
   * Grupo opcional donde se copia la misma alerta, según la decisión registrada
   * en main.ts/copiarAlGrupo. No entra en
   * `missingVars`: sin ella el sistema se comporta exactamente igual que antes
   * de que el grupo existiera. Es un id negativo, no un @nombre.
   */
  telegramGroupChatId: string | null;
  databaseUrl: string | null;
  /**
   * Contacto que la SEC exige en el User-Agent ("Nombre correo"). Sin esto,
   * EDGAR responde 403 y la fuente se salta. No puede estar en el repositorio:
   * es público.
   */
  secUserAgent: string | null;
  /** Tickers cuyos documentos de la SEC se vigilan. Dato personal: viene de fuera. */
  secWatchlist: string[];
  /** Tickers de respaldo que aportan contexto personal, no admisión automática. */
  watchlist: string[];
  /** Ids habilitados de `FEEDS`. Vacío = tandas seleccionadas, core por defecto. */
  feeds: string[];
  rssFeedBatches?: string[];
  sourceConcurrency?: number;
  sourceTimeoutMs?: number;
  collectionTimeoutMs?: number;
  edgarMaxFilings?: number;
  queueScanLimit?: number;
  processingLeaseMs?: number;
  runTelemetry?: boolean;
  newsDeliveryMode?: "legacy" | "two-level";
  briefNewsThreshold?: number;
  watchlistImportantThreshold?: number;
  briefNewsHour?: number;
  briefNewsDay?: number;
  importantNewsHour?: number;
  importantNewsDay?: number;
  briefBatchSize?: number;
  briefIntervalMinutes?: number;
  maxPendingHours?: number;
  aiCallsDay?: number;
  aiScoringInputUsd?: number | null;
  aiScoringOutputUsd?: number | null;
  aiAnalysisInputUsd?: number | null;
  aiAnalysisOutputUsd?: number | null;
  /** Tipos de documento de EDGAR que interesan. Vacío = los de por defecto. */
  edgarForms: string[];
  /** Más viejo que esto, ni se puntúa: un feed trae su historial, y eso no es noticia. */
  maxItemAgeHours: number;
  /** Techo de llamadas al modelo barato por ciclo. El ciclo corre cada 30 minutos. */
  maxScoringPerCycle: number;
  /** Techo de eventos con análisis profundo; cada análisis admite 2 intentos. */
  maxDeepPerCycle: number;
  /** Cuántos días mira hacia delante la agenda macro. */
  agendaDias: number;
  /** Parecido mínimo entre titulares para tratarlos como la misma historia. */
  umbralAgrupacion: number;
  /** Modelo barato del paso 3 de la cascada (§5). */
  modelScoring: string;
  /** Modelo capaz del paso 4, solo para importance_score >= umbral. */
  modelAnalysis: string;
  deepAnalysisThreshold: number;
  alertThreshold: number;
  stateDir: string;
}

export interface MissingVar {
  name: string;
  needed_for: string;
  where: string;
}

/** Carga `.env` si existe. En GitHub Actions no existe: las variables vienen de Secrets. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : null;
}

/** Lista separada por comas. Vacía si la variable no está. */
function lista(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function loadConfig(): Config {
  return {
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    fredApiKey: env("FRED_API_KEY"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    telegramChatId: env("TELEGRAM_CHAT_ID"),
    telegramGroupChatId: env("TELEGRAM_GROUP_CHAT_ID"),
    databaseUrl: env("DATABASE_URL"),
    secUserAgent: env("SEC_USER_AGENT"),
    secWatchlist: lista("SEC_WATCHLIST"),
    watchlist: lista("WATCHLIST"),
    feeds: lista("RSS_FEEDS"),
    rssFeedBatches: lista("RSS_FEED_BATCHES").length ? lista("RSS_FEED_BATCHES") : ["core"],
    sourceConcurrency: entero("SOURCE_CONCURRENCY", 3, 1, 8),
    sourceTimeoutMs: entero("SOURCE_TIMEOUT_MS", 45_000, 1_000, 120_000),
    collectionTimeoutMs: entero("COLLECTION_TIMEOUT_MS", 180_000, 5_000, 300_000),
    edgarMaxFilings: entero("EDGAR_MAX_FILINGS", 1000, 1, 5000),
    queueScanLimit: entero("QUEUE_SCAN_LIMIT", 500, 12, 5000),
    processingLeaseMs: entero("PROCESSING_LEASE_MS", 900_000, 60_000, 3600_000),
    runTelemetry: env("RUN_TELEMETRY") !== "false",
    newsDeliveryMode: deliveryMode(),
    briefNewsThreshold: entero("BRIEF_NEWS_THRESHOLD", 5, 3, 8),
    watchlistImportantThreshold: entero("WATCHLIST_IMPORTANT_THRESHOLD", 6, 5, 10),
    briefNewsHour: entero("BRIEF_NEWS_PER_HOUR", 6, 0, 100),
    briefNewsDay: entero("BRIEF_NEWS_PER_DAY", 24, 0, 500),
    importantNewsHour: entero("IMPORTANT_NEWS_PER_HOUR", 3, 0, 50),
    importantNewsDay: entero("IMPORTANT_NEWS_PER_DAY", 12, 0, 100),
    briefBatchSize: entero("BRIEF_BATCH_SIZE", 3, 1, 6),
    briefIntervalMinutes: entero("BRIEF_INTERVAL_MINUTES", 60, 0, 360),
    maxPendingHours: entero("MAX_PENDING_HOURS", 48, 1, 168),
    aiCallsDay: entero("AI_CALLS_PER_DAY", 120, 0, 2000),
    aiScoringInputUsd: optionalPrice("AI_SCORING_INPUT_USD_PER_MILLION"),
    aiScoringOutputUsd: optionalPrice("AI_SCORING_OUTPUT_USD_PER_MILLION"),
    aiAnalysisInputUsd: optionalPrice("AI_ANALYSIS_INPUT_USD_PER_MILLION"),
    aiAnalysisOutputUsd: optionalPrice("AI_ANALYSIS_OUTPUT_USD_PER_MILLION"),
    edgarForms: lista("EDGAR_FORMS"),
    maxItemAgeHours: Number(env("MAX_ITEM_AGE_HOURS") ?? 72),
    maxScoringPerCycle: entero("MAX_SCORING_PER_CYCLE", 12, 1, 100),
    maxDeepPerCycle: entero("MAX_DEEP_PER_CYCLE", 3, 0, 20),
    agendaDias: Number(env("AGENDA_DIAS") ?? 7),
    umbralAgrupacion: Number(env("GROUP_THRESHOLD") ?? 0.6),
    modelScoring: env("MODEL_SCORING") ?? "claude-haiku-4-5",
    modelAnalysis: env("MODEL_ANALYSIS") ?? "claude-opus-5",
    deepAnalysisThreshold: Number(env("DEEP_ANALYSIS_THRESHOLD") ?? 7),
    alertThreshold: Number(env("ALERT_THRESHOLD") ?? 7),
    stateDir: env("STATE_DIR") ?? ".cache",
  };
}

function deliveryMode(): "legacy" | "two-level" {
  const value = env("NEWS_DELIVERY_MODE") ?? "two-level";
  if (value !== "legacy" && value !== "two-level") throw new Error("invalid_news_delivery_mode");
  return value;
}

function optionalPrice(name: string): number | null {
  const raw = env(name); if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_model_price");
  return value;
}

function entero(name: string, fallback: number, min: number, max: number): number {
  const value = Number(env(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("invalid_bounded_configuration");
  }
  return value;
}

/** Qué falta y para qué, con dónde conseguirlo. Vacío = todo listo. */
export function missingVars(c: Config): MissingVar[] {
  const missing: MissingVar[] = [];
  if (!c.fredApiKey)
    missing.push({
      name: "FRED_API_KEY",
      needed_for: "leer los datos macro. Sin esto no hay nada que analizar.",
      where: "https://fredaccount.stlouisfed.org/apikeys — gratis, sin tarjeta",
    });
  if (!c.anthropicApiKey)
    missing.push({
      name: "ANTHROPIC_API_KEY",
      needed_for: "los pasos 3 y 4 de la cascada. Sin esto se filtra por reglas y no se puntúa.",
      where: "console.anthropic.com → API keys",
    });
  if (!c.telegramBotToken)
    missing.push({
      name: "TELEGRAM_BOT_TOKEN",
      needed_for: "enviar la alerta",
      where: "@BotFather en Telegram → /newbot",
    });
  if (!c.telegramChatId)
    missing.push({
      name: "TELEGRAM_CHAT_ID",
      needed_for: "saber a quién enviarla",
      where: "escribe a tu bot y abre https://api.telegram.org/bot<TOKEN>/getUpdates",
    });
  if (!c.databaseUrl)
    missing.push({
      name: "DATABASE_URL",
      needed_for:
        "recordar lo ya alertado. En GitHub Actions el disco empieza vacío cada vez: sin base de datos, la misma alerta se repite en cada ejecución.",
      where: "panel de Neon → Connection string (pooled)",
    });
  if (!c.secUserAgent)
    missing.push({
      name: "SEC_USER_AGENT",
      needed_for:
        "leer SEC EDGAR. La SEC exige un contacto en el User-Agent y sin él responde 403. Sin esta variable el resto del ciclo corre igual, solo que sin documentos regulatorios.",
      where: 'una cadena tuya con nombre y correo: "Nombre Apellido correo@dominio". Va en los secretos del repositorio, nunca en el código: este repositorio es público',
    });
  return missing;
}

export function describeMissing(missing: MissingVar[]): string {
  if (missing.length === 0) return "Configuración completa.";
  const lines = missing.map((m) => `  ✕ ${m.name}\n      para: ${m.needed_for}\n      dónde: ${m.where}`);
  return `Faltan ${missing.length} variable(s) de entorno:\n${lines.join("\n")}`;
}
