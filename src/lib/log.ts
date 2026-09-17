/**
 * Único borde de salida del ciclo. Solo admite vocabulario operativo cerrado.
 * Ni Actions ni local reciben títulos, URLs, prosa del modelo, SQL, mensajes,
 * stacks o cuerpos HTTP. No depende de conocer la watchlist ni las claves.
 * Para diagnosticar: código + etapa + fuente + ordinal del ciclo + conteos.
 */
import { FEEDS } from "../sources/rss.ts";
import { RULE_REASON_CODES } from "../pipeline/rules.ts";
import { QUEUE_REASONS } from "../pipeline/queue.ts";
import { PROFILES, TRIGGERS, type Profile, type Trigger } from "../pipeline/profile.ts";
import { PROVIDER_ERROR_CODES } from "../ai/providers.ts";

const PRIORITIES = ["critical_macro", "macro_release", "watchlist", "material_news", "news", "routine_official"] as const;
const PUBLISHERS = [...new Set(Object.values(FEEDS).map((feed) => feed.publisher)), "fred", "eurostat", "sec", "yahoo", "yahoo-market", "rss-unknown", "coingecko"];

const CODES = [
  "CYCLE_START", "RUN_RECORDED", "CONFIG_MISSING", "STATE_OPEN", "WATCHLIST_EMPTY",
  "WATCHLIST_FAILED", "FEED_UNKNOWN", "FEED_DISABLED", "SEC_CONTACT_MISSING", "SEC_UNKNOWN",
  "SOURCE_OK", "SOURCE_FAILED", "FEED_NORMALIZED", "FEED_FUNNEL", "RULE_REASON",
  "AUDIT_COMPLETE", "NO_SOURCES", "SOURCES_PARTIAL", "FRESHNESS",
  "RULES", "DEDUPE", "GROUPED", "SCORING_UNAVAILABLE", "SCORING_LIMIT",
  "SCORED", "SCORING_SUMMARY_FALLBACK", "ALERT_SKIPPED", "FABRICATION_RETRY", "ANALYSIS_OK",
  "ANALYSIS_FALLBACK", "ANALYSIS_LIMIT", "ALERT_READY", "DRY_RUN",
  "TELEGRAM_MISSING", "ALERT_SENT",
  // Los cuatro finales que no son "entregada", y que existen para no tener que
  // abrir el job de Actions para saber qué pasó. Se leen junto a la tabla
  // `alert_deliveries`, que es donde queda el estado: BLOCKED, la entrega ya
  // tenía dueño y no se reenvía; REJECTED, Telegram dijo que no y el mensaje no
  // salió; UNCERTAIN, pudo salir y pudo no salir; RECORD_FAILED, se perdió el
  // acuse de Neon y la entrega se queda en `sending`, que nadie libera.
  "ALERT_BLOCKED", "ALERT_REJECTED", "ALERT_UNCERTAIN", "ALERT_RECORD_FAILED",
  "EVENT_FAILED", "CYCLE_END", "LLM_PROVIDER_FAILED",
  // Groq pasa a su modelo de respaldo porque el principal está limitado (429).
  "LLM_MODEL_FALLBACK",
  // Cupo diario de IA agotado: el ciclo no falla y avisa una vez al día. `sent` dice si salió.
  "AI_BUDGET_NOTICE",
  // Copia al grupo compartido. Dicen si salió o si Telegram la rechazó. No dicen
  // de qué evento: la fuente ya es vocabulario cerrado y con ella basta para
  // diagnosticar.
  "GROUP_SENT", "GROUP_REJECTED", "GROUP_FAILED",
  // Breves cerrados por viejos al llegarles el turno (`stale_at_delivery`).
  // No es un fallo y no cuenta como tal: es la cola diciendo que va por detras.
  // Existe porque sin el, un ciclo que cierra setenta breves y no manda ninguno
  // sale en verde con `sent: 0`, indistinguible de un ciclo sin nada que mandar.
  "BRIEF_STALE_CLOSED",
  "QUEUE_CAPTURE", "QUEUE_STATS", "QUEUE_DISCARDED", "QUEUE_PLAN", "QUEUE_RETRY",
  "QUEUE_DELIVERY_PENDING", "SEC_COVERAGE", "CAPTURE_ONLY", "UNHANDLED", "LOG_SUPPRESSED",
] as const;
const SOURCES = ["fred", "eurostat", "rss", "sec-edgar", "yahoo", "coingecko", "neon", "file"] as const;
const STAGES = ["startup", "watchlist", "collect", "freshness", "rules", "dedupe",
  "group", "scoring", "analysis", "format", "telegram", "persist", "cycle"] as const;
const COUNTS = ["count", "total", "discarded", "ok", "failed", "deep", "sent", "index", "attempt",
  "fresh", "passed", "new", "seen", "captured", "unique", "pending", "processed",
  "scored", "retryable", "processing", "oldestHours", "deliveryPending", "points", "agePoints"] as const;
// Solo ids de fuentes públicas. Nunca series_id libre (puede ser un ticker).
const FEED_IDS = Object.keys(FEEDS);
const CONFIG_VARS = ["FRED_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID", "DATABASE_URL", "SEC_USER_AGENT"] as const;

export type LogCode = typeof CODES[number];
export type LogStage = typeof STAGES[number];
export interface LogFields extends Partial<Record<typeof COUNTS[number], number>> {
  provider?: "groq" | "openrouter" | "anthropic";
  profile?: Profile;
  trigger?: Trigger;
  source?: typeof SOURCES[number];
  stage?: LogStage;
  variable?: typeof CONFIG_VARS[number];
  feed?: string;
  reason?: typeof RULE_REASON_CODES[number];
  queueReason?: typeof QUEUE_REASONS[number];
  priority?: typeof PRIORITIES[number];
  publisher?: string;
  importance?: number;
  impact?: number;
  /** Nunca se serializa: solo se examinan códigos públicos concretos. */
  error?: unknown;
}
export type Logger = (code: LogCode, fields?: LogFields) => void;

/**
 * Códigos de red, TLS y base reconocidos. Son identificadores del sistema
 * operativo, del driver o nuestros: nunca traen cuerpo de respuesta ni URL.
 */
const ERROR_CODES = [
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  // undici sí pone código propio cuando el fallo es suyo, pero lo deja en
  // `cause`; sin recorrer la cadena se perdían todos.
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  // TLS: un certificado caducado no es "no responde" y no se arregla esperando.
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "28P01", "42P01", "42703", "53300", "57P01",
  // Eurostat responde 200 a una consulta que no vigila nada: sin estos
  // codigos, "no responde" y "responde y no trae nada" se leerian
  // igual en el log, y es justo la diferencia que hay que ver.
  "EUROSTAT_EMPTY", "EUROSTAT_DIMENSION", "EUROSTAT_NO_AGGREGATE",
  "EUROSTAT_SHAPE", "FEED_INVALID", "SOURCE_TIMEOUT", "COLLECTION_TIMEOUT", "SEC_SHAPE",
  "SEC_COVERAGE_LIMIT", "SEC_ARCHIVE_FAILED", "AI_BUDGET_EXHAUSTED", "LLM_UNAVAILABLE", "LLM_OUTPUT_INVALID", "LLM_REQUEST_FAILED", "REQUEST_TIMEOUT",
] as const;
/**
 * Fallos propios con código estable (C5). Son literales de este repositorio, no
 * texto de terceros: publicarlos no filtra nada, y evita que una configuración
 * inválida o un reclamo perdido —justo los errores que explican por qué el
 * ciclo no funciona— se lean como UNKNOWN.
 */
const SAFE_FAILURES = [
  "invalid_llm_providers", "invalid_groq_model", "invalid_openrouter_free_model", "invalid_llm_retry_at",
  "invalid_health_limit", "invalid_health_arguments", "invalid_monitor_profile", "invalid_monitor_origin",
  "invalid_cycle_mode", "incompatible_cycle_modes", "invalid_capture_profile", "invalid_news_delivery_mode",
  "invalid_agenda_days", "invalid_bounded_configuration", "invalid_model_price", "invalid_flags",
  "health_database_required", "health_notice_configuration_missing",
  "invalid_budget_reservation", "budget_reservation_conflict", "budget_reservation_missing",
  "ai_reservation_missing", "invalid_control_state", "control_file_busy",
  "queue_file_busy", "alert_delivery_file_busy", "invalid_alert_claim", "invalid_alert_delivery_state",
  "alert_claim_lost", "brief_claim_lost", "processing_claim_lost", "capture_ack_missing",
  "invalid_queue_state", "invalid_queue_limit", "invalid_queue_response", "invalid_queue_stats",
  "queue_enrichment_identity_changed", "duplicate_queue_entry", "scored_queue_entry_missing",
] as const;

/** Lee propiedades de datos sin ejecutar getters, toJSON, inspect ni toString. */
function dato(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

/**
 * Clasifica un eslabón de la cadena de errores. Devuelve `null` cuando no
 * reconoce nada: quien llama sigue bajando por `cause`. Solo publica vocabulario
 * cerrado; ningún mensaje libre llega al log, ni siquiera recortado.
 */
function clasificarError(value: unknown): Record<string, string | number> | null {
  const status = dato(value, "status");
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
    // El código del proveedor ya viene reducido a la lista cerrada; se vuelve a comprobar aquí.
    const providerCode = dato(value, "providerCode");
    return { error: "HTTP", status,
      ...(typeof providerCode === "string" && (PROVIDER_ERROR_CODES as readonly string[]).includes(providerCode) ? { providerCode } : {}) };
  }
  const code = dato(value, "code");
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) return { error: code };
  // DOMException guarda `name` en el prototipo: `dato` no lo ve y el getter es
  // nativo, así que leerlo aquí no ejecuta código ajeno. Un plazo agotado y una
  // cancelación son dos diagnósticos distintos y ninguno es UNKNOWN.
  if (value instanceof DOMException) {
    if (value.name === "TimeoutError") return { error: "REQUEST_TIMEOUT" };
    if (value.name === "AbortError") return { error: "REQUEST_ABORTED" };
    return null;
  }
  // Un esquema que no valida no es un fallo de red. `issues` es propiedad
  // propia de ZodError; su contenido nunca se publica, solo su existencia.
  if (Array.isArray(dato(value, "issues"))) return { error: "SCHEMA_INVALID" };
  // Una respuesta que no es JSON: su mensaje incluye el fragmento recibido, así
  // que se publica el hecho y no el texto.
  if (value instanceof SyntaxError) return { error: "PAYLOAD_INVALID_JSON" };
  const message = dato(value, "message");
  if (typeof message !== "string") return null;
  // El SDK envuelve los errores de Zod en un Error sin código ni status.
  // Solo se reconoce su prefijo fijo; nunca se publica la explicación,
  // que puede contener fragmentos de la respuesta del modelo.
  if (message.startsWith("Failed to parse structured output")) return { error: "MODEL_OUTPUT_INVALID" };
  // Igualdad exacta contra la lista cerrada: un mensaje que *contenga* un código
  // conocido sigue siendo texto libre y no entra.
  if ((SAFE_FAILURES as readonly string[]).includes(message)) return { error: message.toUpperCase() };
  return null;
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  return (code, fields) => {
    const record: Record<string, string | number> = {
      code: typeof code === "string" && CODES.includes(code) ? code : "LOG_SUPPRESSED",
    };
    // También se valida en ejecución: TypeScript no protege frente a un cast,
    // un Error u objetos procedentes de un SDK.
    if (record.code !== "LOG_SUPPRESSED") {
      const provider = dato(fields, "provider");
      if (typeof provider === "string" && ["groq", "openrouter", "anthropic"].includes(provider)) record.provider = provider;
      const source = dato(fields, "source");
      const stage = dato(fields, "stage");
      const variable = dato(fields, "variable");
      const feed = dato(fields, "feed");
      const reason = dato(fields, "reason");
      if (typeof source === "string" && SOURCES.some((s) => s === source)) record.source = source;
      if (typeof stage === "string" && STAGES.some((s) => s === stage)) record.stage = stage;
      if (typeof feed === "string" && FEED_IDS.includes(feed)) record.feed = feed;
      if (typeof reason === "string" && RULE_REASON_CODES.some((r) => r === reason)) record.reason = reason;
      for (const [field, allowed] of [["queueReason", QUEUE_REASONS], ["priority", PRIORITIES], ["publisher", PUBLISHERS], ["profile", PROFILES], ["trigger", TRIGGERS]] as const) {
        const value = dato(fields, field);
        if (typeof value === "string" && allowed.some((item) => item === value)) record[field] = value;
      }
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
        // `fetch` envuelve el fallo real: TypeError("fetch failed") por fuera y
        // ECONNRESET/ENOTFOUND en `cause`. Sin bajar por la cadena, quedarse sin
        // DNS y que el modelo devuelva basura se leían igual —UNKNOWN— y era
        // justo la diferencia que hay que ver. Profundidad acotada: una cadena
        // cíclica no puede colgar el logger, y `dato` no ejecuta el getter.
        for (let link: unknown = error, hop = 0; link !== undefined && hop < 4; link = dato(link, "cause"), hop++) {
          const clasificado = clasificarError(link);
          if (clasificado) { Object.assign(record, clasificado); break; }
        }
      }
    }
    sink(JSON.stringify(record));
  };
}
