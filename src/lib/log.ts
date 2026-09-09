/**
 * Único borde de salida del ciclo. Solo admite vocabulario operativo cerrado.
 * Ni Actions ni local reciben títulos, URLs, prosa del modelo, SQL, mensajes,
 * stacks o cuerpos HTTP. No depende de conocer la watchlist ni las claves.
 * Para diagnosticar: código + etapa + fuente + ordinal del ciclo + conteos.
 */
const CODES = [
  "CYCLE_START", "CONFIG_MISSING", "STATE_OPEN", "WATCHLIST_EMPTY",
  "WATCHLIST_FAILED", "FEED_UNKNOWN", "SEC_CONTACT_MISSING", "SEC_UNKNOWN",
  "SOURCE_OK", "SOURCE_FAILED", "NO_SOURCES", "SOURCES_PARTIAL", "FRESHNESS",
  "RULES", "DEDUPE", "GROUPED", "SCORING_UNAVAILABLE", "SCORING_LIMIT",
  "SCORED", "ALERT_SKIPPED", "FABRICATION_RETRY", "ANALYSIS_OK",
  "ANALYSIS_FALLBACK", "ANALYSIS_LIMIT", "ALERT_READY", "DRY_RUN",
  "TELEGRAM_MISSING", "ALERT_SENT", "EVENT_FAILED", "CYCLE_END",
  // Copia al grupo compartido. Dicen si salió o si Telegram la rechazó. No dicen
  // de qué evento: la fuente ya es vocabulario cerrado y con ella basta para
  // diagnosticar.
  "GROUP_SENT", "GROUP_REJECTED", "GROUP_FAILED",
  "UNHANDLED", "LOG_SUPPRESSED",
] as const;
const SOURCES = ["fred", "rss", "sec-edgar", "yahoo", "coingecko", "neon", "file"] as const;
const STAGES = ["startup", "watchlist", "collect", "freshness", "rules", "dedupe",
  "group", "scoring", "analysis", "format", "telegram", "persist", "cycle"] as const;
const COUNTS = ["count", "total", "discarded", "ok", "failed", "deep", "sent", "index", "attempt"] as const;
const CONFIG_VARS = ["FRED_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID", "DATABASE_URL", "SEC_USER_AGENT"] as const;

export type LogCode = typeof CODES[number];
export type LogStage = typeof STAGES[number];
export interface LogFields extends Partial<Record<typeof COUNTS[number], number>> {
  source?: typeof SOURCES[number];
  stage?: LogStage;
  variable?: typeof CONFIG_VARS[number];
  /** Nunca se serializa: solo se examinan códigos públicos concretos. */
  error?: unknown;
}
export type Logger = (code: LogCode, fields?: LogFields) => void;

/** Lee propiedades de datos sin ejecutar getters, toJSON, inspect ni toString. */
function dato(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  return (code, fields) => {
    const record: Record<string, string | number> = {
      code: typeof code === "string" && CODES.includes(code) ? code : "LOG_SUPPRESSED",
    };
    // También se valida en ejecución: TypeScript no protege frente a un cast,
    // un Error u objetos procedentes de un SDK.
    if (record.code !== "LOG_SUPPRESSED") {
      const source = dato(fields, "source");
      const stage = dato(fields, "stage");
      const variable = dato(fields, "variable");
      if (typeof source === "string" && SOURCES.some((s) => s === source)) record.source = source;
      if (typeof stage === "string" && STAGES.some((s) => s === stage)) record.stage = stage;
      if (code === "CONFIG_MISSING" && typeof variable === "string" &&
        CONFIG_VARS.some((v) => v === variable)) record.variable = variable;
      for (const key of COUNTS) {
        const value = dato(fields, key);
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) record[key] = value;
      }
      const error = dato(fields, "error");
      if (error !== undefined) {
        record.error = "UNKNOWN";
        const status = dato(error, "status");
        const errorCode = dato(error, "code");
        if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
          record.error = "HTTP";
          record.status = status;
        } else if (typeof errorCode === "string" &&
          ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
            "28P01", "42P01", "42703", "53300", "57P01"].includes(errorCode)) {
          record.error = errorCode;
        }
      }
    }
    sink(JSON.stringify(record));
  };
}
