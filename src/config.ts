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
  databaseUrl: string | null;
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

export function loadConfig(): Config {
  return {
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    fredApiKey: env("FRED_API_KEY"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    telegramChatId: env("TELEGRAM_CHAT_ID"),
    databaseUrl: env("DATABASE_URL"),
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
  return missing;
}

export function describeMissing(missing: MissingVar[]): string {
  if (missing.length === 0) return "Configuración completa.";
  const lines = missing.map((m) => `  ✕ ${m.name}\n      para: ${m.needed_for}\n      dónde: ${m.where}`);
  return `Faltan ${missing.length} variable(s) de entorno:\n${lines.join("\n")}`;
}
