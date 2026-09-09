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
   * Grupo opcional donde se comparte **solo** lo que el monitor habría marcado
   * con la watchlist vacía (ver `src/notify/compartir.ts`). No entra en
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
  /** Tickers que, mencionados en un titular, lo hacen pasar el filtro por reglas. */
  watchlist: string[];
  /** Ids de `FEEDS` que se leen. Vacío = todos. */
  feeds: string[];
  /** Tipos de documento de EDGAR que interesan. Vacío = los de por defecto. */
  edgarForms: string[];
  /** Más viejo que esto, ni se puntúa: un feed trae su historial, y eso no es noticia. */
  maxItemAgeHours: number;
  /** Techo de llamadas al modelo barato por ciclo. El ciclo corre cada 30 minutos. */
  maxScoringPerCycle: number;
  /** Techo de llamadas al modelo caro por ciclo. Ahí está el gasto de verdad. */
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
    edgarForms: lista("EDGAR_FORMS"),
    maxItemAgeHours: Number(env("MAX_ITEM_AGE_HOURS") ?? 72),
    maxScoringPerCycle: Number(env("MAX_SCORING_PER_CYCLE") ?? 12),
    maxDeepPerCycle: Number(env("MAX_DEEP_PER_CYCLE") ?? 3),
    agendaDias: Number(env("AGENDA_DIAS") ?? 7),
    umbralAgrupacion: Number(env("GROUP_THRESHOLD") ?? 0.6),
    modelScoring: env("MODEL_SCORING") ?? "claude-haiku-4-5",
    modelAnalysis: env("MODEL_ANALYSIS") ?? "claude-opus-5",
    deepAnalysisThreshold: Number(env("DEEP_ANALYSIS_THRESHOLD") ?? 7),
    alertThreshold: Number(env("ALERT_THRESHOLD") ?? 7),
    stateDir: env("STATE_DIR") ?? ".cache",
  };
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
