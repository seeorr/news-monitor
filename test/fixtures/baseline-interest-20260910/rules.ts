/** Paso 1: candidatos sin LLM. Pasar no significa enviar alerta: quedan dedupe,
 * presupuesto y puntuación. El log público usa solo reasonCode. */
import type { NormalizedEvent } from "../../../src/schema/event.ts";

export const RULE_REASON_CODES = [
  "official", "watchlist_symbol", "watchlist_name", "macro", "market",
  "geopolitics", "corporate", "low_signal", "no_match",
] as const;
export type RuleReasonCode = (typeof RULE_REASON_CODES)[number];

export interface RuleDecision {
  pass: boolean;
  reasonCode: RuleReasonCode;
  /** Explicación para auditoría privada, nunca para el log público de Actions. */
  reason: string;
}

/** Nombres y símbolos de la misma watchlist privada que usa la ingesta. */
export interface RuleWatchlistEntry {
  ticker: string;
  nombre?: string | null;
  quoteSymbol?: string | null;
}
export interface RuleOptions {
  /** Se admiten los tickers simples del respaldo por entorno. */
  watchlist?: ReadonlyArray<string | RuleWatchlistEntry>;
}

/** Términos concretos: «rates» a secas también describe ofertas de tarjetas. */
export const MACRO_KEYWORDS = [
  "cpi", "ipc", "ppi", "pce", "inflation", "inflacion", "deflation", "deflacion",
  "consumer price", "consumer prices", "producer price", "producer prices",
  "fomc", "fed", "federal reserve", "ecb", "bce", "bank of japan", "bank of england",
  "central bank", "banco central", "rate decision", "interest rate", "interest rates",
  "boe", "boj", "rate hike", "rate cut", "monetary policy", "employment situation",
  "benchmark rate", "policy rate", "tipos de interes", "tipo de interes",
  "payrolls", "jobs report", "jobless claims", "unemployment", "desempleo", "paro",
  "gdp", "pib", "retail sales", "ventas minoristas", "industrial production",
  "industrial output", "produccion industrial", "pmi", "ism", "jolts", "recession", "recesion",
  "eurozone", "euro area", "zona euro", "eurostat", "treasury yields", "bond yields",
  "treasury yield", "bond yield", "sovereign debt", "deuda soberana", "credit spreads", "quantitative easing",
  "quantitative tightening", "sanctions", "sanciones", "tariff", "tariffs", "arancel", "aranceles",
];

/** La entradilla puede identificar el hecho que el titular deja implícito. */
export type Enjuiciable = Pick<NormalizedEvent, "title" | "official"> &
  Partial<Pick<NormalizedEvent, "summary" | "kind" | "series_id">>;

const CORPORATE_KEYWORDS = [
  "earnings", "guidance", "merger", "mergers", "acquisition", "acquisitions",
  "takeover", "ipo", "bankruptcy", "bankrupt", "insolvency", "quiebra",
  "downgrade", "downgrades", "upgrade", "upgrades", "profit warning",
];
// Dos señales: conflicto y canal económico. Sin países o guerras prefijados.
const CONFLICT = /\b(?:war|conflict|attack\w*|strike[sd]?|blockade|disrupt\w*|closure|closed?|stranglehold|guerra|conflicto|ataque\w*|bloqueo|cierre)\b/u;
const TRANSMISSION = /\b(?:oil|crude|brent|tankers?|hormuz|energy|gas|shipping|supply|trade|exports?|imports?|strait|canal|port|ports|petroleo|energia|suministro|comercio|estrecho|puerto\w*)\b/u;
const MARKET_ASSET = /\b(?:oil|crude|brent|wti|opec|natural gas|gold|silver|copper|dollar|yen|sterling|pound|euro|yuan|treasur\w*|bonds?|stocks?|equities|s&p\s*500|nasdaq|dow|banks?|insurers?|petroleo|oro|plata|cobre|dolar|bonos?|bancos?)\b/u;
const MARKET_EVENT = /\b(?:surge[sd]?|surging|plunge[sd]?|plunging|crash\w*|sell[ -]?off|rall(?:y|ies)|tumble[sd]?|slump[sd]?|jump[sd]?|spike[sd]?|squeeze|shortage|inventor\w*|stocks? (?:fall|rise)|bailout|recapital\w*|inject\w*|pump|rescat\w*|inyeccion|desplom\w*|escasez)\b/u;

export function applyRules(event: Enjuiciable, opts: RuleOptions = {}): RuleDecision {
  if (event.official) return decision(true, "official", "fuente oficial");

  const raw = `${event.title}\n${event.summary ?? ""}`;
  const text = fold(raw);
  for (const entry of opts.watchlist ?? []) {
    const company = typeof entry === "string" ? { ticker: entry } : entry;
    if (event.kind === "market_move" && event.series_id &&
        event.series_id.toUpperCase() === company.ticker.trim().toUpperCase()) {
      return decision(true, "watchlist_symbol", "movimiento del simbolo vigilado");
    }
    for (const symbol of [company.ticker, company.quoteSymbol]) {
      if (symbol && matchesSymbol(raw, symbol)) {
        return decision(true, "watchlist_symbol", "menciona un simbolo de la watchlist");
      }
    }
    if (company.nombre && matchesName(text, company.nombre)) {
      return decision(true, "watchlist_name", "menciona el nombre de una empresa vigilada");
    }
  }

  // «earnings» abría la puerta a cualquier transcripción. Las de una empresa
  // vigilada conservan su paso; el resto no consume el cupo por esa palabra.
  const title = fold(event.title);
  if (/\b(?:earnings call (?:transcript|highlights)|earnings transcript|transcript of.{0,30}earnings|transcripcion de resultados)\b/u.test(title) ||
      /\b(?:hourly levels|live levels|technical (?:levels|analysis)|morning bid)\b/u.test(title) ||
      /\b(?:welcome offer|sign[ -]?up bonus|stocks? to buy|best (?:cd|savings|credit card|mortgage) rates)\b/u.test(title)) {
    return decision(false, "low_signal", "transcripcion u oferta sin empresa vigilada");
  }

  const macro = MACRO_KEYWORDS.find((word) => phrase(text, word));
  if (macro) return decision(true, "macro", `termino macro: ${macro}`);
  if (CONFLICT.test(text) && TRANSMISSION.test(text)) {
    return decision(true, "geopolitics", "conflicto o interrupcion con canal economico identificable");
  }
  if (MARKET_ASSET.test(text) && MARKET_EVENT.test(text)) {
    return decision(true, "market", "movimiento o tension de mercado, energia o banca");
  }
  if (MARKET_ASSET.test(text) && /\b(?:output|production|supply|inventories)\s+(?:falls?|rises?|drops?|cuts?|declines?|increases?)\b/u.test(text)) {
    return decision(true, "market", "cambio concreto de produccion, oferta o inventarios");
  }
  const corporate = CORPORATE_KEYWORDS.find((word) => phrase(text, word));
  if (corporate) return decision(true, "corporate", `hecho corporativo: ${corporate}`);
  return decision(false, "no_match", "sin ticker, nombre vigilado ni señal macro, de mercado o corporativa");
}

function decision(pass: boolean, reasonCode: RuleReasonCode, reason: string): RuleDecision {
  return { pass, reasonCode, reason };
}

/** «fed» no es FedEx, «ipo» no es Chipotle ni «paro» comparó. */
function phrase(text: string, term: string): boolean {
  const pattern = escapeRegExp(fold(term)).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

function matchesSymbol(text: string, symbol: string): boolean {
  const clean = symbol.trim();
  if (!clean) return false;
  // ON, IT o A son palabras: para símbolos de hasta dos letras se exige
  // notación financiera ($A, (ON), NASDAQ:IT), no una mayúscula casual.
  if (/^[a-z]{1,2}$/i.test(clean)) {
    const escaped = escapeRegExp(clean);
    return new RegExp(`(?:\\$${escaped}(?![\\p{L}\\p{N}_])|\\(${escaped}\\)|\\b[A-Z][A-Z0-9.]*:\\s*${escaped}(?![\\p{L}\\p{N}_]))`, "iu").test(text);
  }
  // A diferencia de \b, encuentra índices ^INDX y símbolos BRK.B.
  return phrase(fold(text), clean);
}

function matchesName(text: string, name: string): boolean {
  const clean = fold(name).trim();
  // Solo sufijos legales finales: «Acme Robotics Inc.» identifica «Acme
  // Robotics», no cualquier noticia que mencione «Robotics».
  const short = clean.replace(/(?:[\s,]+(?:incorporated|corporation|corp|inc|limited|ltd|plc|s\.a|sa)\.?)+$/u, "").trim();
  return [clean, short].some((candidate) =>
    candidate.replace(/[^\p{L}\p{N}]/gu, "").length >= 4 && phrase(text, candidate));
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** La prensa exige el umbral. Una primaria puede adelantar un aviso un punto
 * si el modelo identifica un hecho material; oficial no significa urgente. */
export function mereceAlerta(
  event: NormalizedEvent,
  scoring: { needs_alert: boolean; importance_score: number },
  umbral: number,
): boolean {
  if (scoring.importance_score >= umbral) return true;
  return event.official && scoring.needs_alert && scoring.importance_score >= umbral - 1;
}
