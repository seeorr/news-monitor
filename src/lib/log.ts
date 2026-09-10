/**
 * Único borde de salida del ciclo. Solo admite vocabulario operativo cerrado.
 * Ni Actions ni local reciben títulos, URLs, prosa del modelo, SQL, mensajes,
 * stacks o cuerpos HTTP. No depende de conocer la watchlist ni las claves.
 * Para diagnosticar: código + etapa + fuente + ordinal del ciclo + conteos.
 */
import { FEEDS } from "../sources/rss.ts";
import { RULE_REASON_CODES } from "../pipeline/rules.ts";

const CODES = [
  "CYCLE_START", "CONFIG_MISSING", "STATE_OPEN", "WATCHLIST_EMPTY",
  "WATCHLIST_FAILED", "FEED_UNKNOWN", "SEC_CONTACT_MISSING", "SEC_UNKNOWN",
  "SOURCE_OK", "SOURCE_FAILED", "FEED_NORMALIZED", "FEED_FUNNEL", "RULE_REASON",
  "AUDIT_COMPLETE", "NO_SOURCES", "SOURCES_PARTIAL", "FRESHNESS",
  "RULES", "DEDUPE", "GROUPED", "SCORING_UNAVAILABLE", "SCORING_LIMIT",
  "SCORED", "ALERT_SKIPPED", "FABRICATION_RETRY", "ANALYSIS_OK",
  "ANALYSIS_FALLBACK", "ANALYSIS_LIMIT", "ALERT_READY", "DRY_RUN",
  "TELEGRAM_MISSING", "ALERT_SENT",
  // Los cuatro finales que no son "entregada", y que existen para no tener que
  // abrir el job de Actions para saber qué pasó. Se leen junto a la tabla
  // `alert_deliveries`, que es donde queda el estado: BLOCKED, la entrega ya
  // tenía dueño y no se reenvía; REJECTED, Telegram dijo que no y el mensaje no
  // salió; UNCERTAIN, pudo salir y pudo no salir; RECORD_FAILED, se perdió el
  // acuse de Neon y la entrega se queda en `sending`, que nadie libera.
  "ALERT_BLOCKED", "ALERT_REJECTED", "ALERT_UNCERTAIN", "ALERT_RECORD_FAILED",
  "EVENT_FAILED", "CYCLE_END",
  // Copia al grupo compartido. Dicen si salió o si Telegram la rechazó. No dicen
  // de qué evento: la fuente ya es vocabulario cerrado y con ella basta para
  // diagnosticar.
  "GROUP_SENT", "GROUP_REJECTED", "GROUP_FAILED",
  "UNHANDLED", "LOG_SUPPRESSED",
] as const;
const SOURCES = ["fred", "eurostat", "rss", "sec-edgar", "yahoo", "coingecko", "neon", "file"] as const;
const STAGES = ["startup", "watchlist", "collect", "freshness", "rules", "dedupe",
  "group", "scoring", "analysis", "format", "telegram", "persist", "cycle"] as const;
const COUNTS = ["count", "total", "discarded", "ok", "failed", "deep", "sent", "index", "attempt",
  "fresh", "passed", "new", "seen"] as const;
// Solo ids de fuentes públicas. Nunca series_id libre (puede ser un ticker).
const FEED_IDS = Object.keys(FEEDS);
const CONFIG_VARS = ["FRED_API_KEY", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID", "DATABASE_URL", "SEC_USER_AGENT"] as const;

export type LogCode = typeof CODES[number];
export type LogStage = typeof STAGES[number];
export interface LogFields extends Partial<Record<typeof COUNTS[number], number>> {
  source?: typeof SOURCES[number];
  stage?: LogStage;
  variable?: typeof CONFIG_VARS[number];
  feed?: string;
  reason?: typeof RULE_REASON_CODES[number];
  importance?: number;
  impact?: number;
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
      const feed = dato(fields, "feed");
      const reason = dato(fields, "reason");
      if (typeof source === "string" && SOURCES.some((s) => s === source)) record.source = source;
      if (typeof stage === "string" && STAGES.some((s) => s === stage)) record.stage = stage;
      if (typeof feed === "string" && FEED_IDS.includes(feed)) record.feed = feed;
      if (typeof reason === "string" && RULE_REASON_CODES.some((r) => r === reason)) record.reason = reason;
      for (const key of ["importance", "impact"] as const) {
        const value = dato(fields, key);
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10) record[key] = value;
      }
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
            "28P01", "42P01", "42703", "53300", "57P01",
            // Eurostat responde 200 a una consulta que no vigila nada: sin estos
            // codigos, "no responde" y "responde y no trae nada" se leerian
            // igual en el log, y es justo la diferencia que hay que ver.
            "EUROSTAT_EMPTY", "EUROSTAT_DIMENSION", "EUROSTAT_NO_AGGREGATE",
            "EUROSTAT_SHAPE", "FEED_INVALID"].includes(errorCode)) {
          record.error = errorCode;
        }
      }
    }
    sink(JSON.stringify(record));
  };
}
