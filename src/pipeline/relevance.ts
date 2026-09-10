/** Evidencia determinista, independiente de la puntuación y de la entrega. */
import { applySignals, type Enjuiciable, type RuleOptions } from "./rules-core.ts";
import { storySubject } from "./agrupar.ts";
export type RelevanceDecision = {
  admit: boolean;
  factuality: "fact" | "rumour" | "opinion" | "promotion" | "routine" | "unknown";
  evidence: "sufficient" | "limited";
  topic: string;
  factType: string | null;
  watchlistRelation: "direct_material" | "incidental" | "none";
  reasons: string[];
  entities: string[];
};
export type RelevanceOptions = RuleOptions;
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const NOISE = /\b(?:welcome offer|sign.up bonus|stocks? to buy|best .{0,20}rates|hourly levels|live levels|technical (?:analysis|levels)|analisis tecnico|morning bid|earnings call (?:transcript|highlights)|earnings transcript|transcripcion de resultados|oferta exclusiva|compra ahora|patrocinad[oa]|sponsored)\b/u;
const RUMOUR = /\b(?:rumou?rs?|unconfirmed|reportedly|sources say|could (?:buy|acquire|merge)|may (?:buy|acquire|merge)|considering (?:a bid|buying)|rumores?|sin confirmar|podria (?:comprar|adquirir)|segun fuentes)\b/u;
const OPINION = /\b(?:opinion|why you should|my prediction|what if|might happen|should you|podria pasar|mi prediccion|que pasaria si|is .{0,30}a buy)\b/u;
const ROUTINE = /\b(?:speech|remarks|fireside chat|working paper|conference|seminar|calendar reminder|discurso|seminario|agenda de hoy|recordatorio|research paper)\b/u;
const CORPORATE = /\b(?:acquir\w*|acquisition|merg\w*|takeover|sells?|sale of|divest\w*|asset sale|raises? .{0,25}(?:guidance|outlook)|cuts? .{0,25}(?:guidance|outlook)|guidance|results?|earnings|restructur\w*|bankrupt\w*|defaults?|financing|refinanc\w*|loan|contract|appoints?|resigns?|compra|adquiere|adquisicion|fusion|vende|desinversion|previsiones|resultados|beneficio|reestructur\w*|quiebra|impago|financiacion|contrato|dimite|nombra)\b/u;
const CHANGE = /\b(?:announc\w*|agrees?|signs?|wins?|secures?|files?|raises?|cuts?|reports?|posts?|approves?|blocks?|bans?|restricts?|suspends?|halts?|restarts?|closes?|falls?|rises?|drops?|increases?|declines?|surges?|plunges?|jumps?|tumbles?|rall(?:y|ies)|output|shortage|disruption|anuncia|acuerda|firma|gana|obtiene|presenta|eleva|recorta|publica|aprueba|bloquea|prohibe|restringe|suspende|interrumpe|reanuda|cierra|cae|sube|aumenta|reduce|escasez|interrupcion|salta|desploma|adquiere|compra|vende|quiebra|impago)\b/u;
const MATERIAL = /\b(?:acquisition|merger|takeover|bankruptcy|default|guidance|earnings|results|contract|financing|production|supply|regulat\w*|sanctions?|tariffs?|cpi|ppi|inflation|payrolls|rate (?:decision|cut|hike)|employment|gdp|pmi|oil|gas|gold|copper|silver|bonds?|yields?|dollar|yen|sterling|euro|brent|wti|opec|adquisicion|fusion|quiebra|previsiones|resultados|contrato|financiacion|produccion|suministro|regulacion|sanciones|aranceles|ipc|inflacion|empleo|pib|petroleo|energia|oro|cobre|plata|bonos|rendimientos|dolar|divisas)\b/u;
const CONCRETE_CORPORATE = /\b(?:acquires?|merges?|files for bankruptcy|declares bankruptcy|defaults? on|agrees to (?:buy|acquire|sell)|adquiere|se fusiona|declara (?:la )?quiebra|incumple (?:el )?pago)\b/u;

export function detectRelevance(event: Enjuiciable, opts: RelevanceOptions = {}): RelevanceDecision {
  const title = fold(event.title), text = fold(`${event.title}. ${event.summary ?? ""}`);
  const personal = applySignals({ ...event, official: false }, opts);
  const mentions = personal.reasonCode.startsWith("watchlist_");
  const base: RelevanceDecision = { admit: false, factuality: "unknown", evidence: "limited",
    topic: "other", factType: null, watchlistRelation: mentions ? "incidental" : "none", reasons: [], entities: storySubject(event.title) ? [storySubject(event.title)!] : [] };
  const reject = (kind: RelevanceDecision["factuality"], reason: string) => ({ ...base, factuality: kind, reasons: [reason] });
  if (NOISE.test(title)) return reject("promotion", "promotional_or_technical_noise");
  if (RUMOUR.test(title)) return reject("rumour", "unconfirmed_claim");
  if (OPINION.test(title)) return reject("opinion", "opinion_or_speculation");
  const structured = (event.kind === "macro_release" && event.official && event.actual != null) || event.kind === "market_move" || event.kind === "filing";
  const general = applySignals({ ...event, official: false }, {});
  const action = CHANGE.test(text) || /\b(?:holds?|unchanged|maintained|slows?|rebounds?|fell|rise|pump|disrupt\w*|shift\w*|upgrades?|downgrades?|signals?|gains?|climbs?|lifts?|deepens?|reacts?|points to|revisa|nuevos aranceles|involves|changes|sells?|restructures?|refinances?|appoints?|resigns?|partnership|agreement|completes?|completed|reported|names|explodes?|sink|slides?|slips?|set new|hits? .{0,25}high|record discounts|targets? .{0,35}valuation)\b/u.test(text);
  const sector = MATERIAL.test(text) || CORPORATE.test(text) || /\b(?:energy|crude|capital|banks?|insurers?|consumer price|retail sales|industrial output|monetary policy|policy rate|benchmark rate|interest rate|bank rate|tipos de interes|financial stability|shipping|tankers?|exports?|trade|partnership|agreement|outlook|ipo|ceo|futures|bitcoin|ethereum)\b/u.test(text);
  const concrete = structured || CONCRETE_CORPORATE.test(text) || (action && sector);
  if (ROUTINE.test(title) && !/\b(?:announces? (?:a )?(?:rate cut|rate hike)|anuncia (?:una )?(?:subida|bajada) de tipos)\b/u.test(text)) {
    return reject("routine", "routine_without_new_decision");
  }
  // Una señal temática aislada puede conservarse en el dashboard, pero no
  // demostrar un hecho suficiente para un aviso. El scoring no crea evidencia.
  const report = event.official && /\b(?:monetary policy report|summary of opinions|employment situation|cpi report|ppi report|market statistics|money stock|principal figures|basic figures|minutes of)\b/u.test(title);
  const prospective = /\b(?:considers? a rate|rate .{0,15}expectations)\b/u.test(title);
  const admit = concrete || report || prospective;
  const titlePersonal = applySignals({ ...event, title: event.title, summary: null, official: false }, opts);
  const direct = mentions && concrete &&
    (event.kind === "filing" || event.kind === "market_move" ||
      (titlePersonal.reasonCode.startsWith("watchlist_") && CORPORATE.test(title) &&
        !/\b(?:alongside|among|including|unlike|compared (?:to|with)|junto a|entre ellas|incluyendo|a diferencia de|comparado con)\b/u.test(title)));
  const topic = CORPORATE.test(text) ? "corporate" : /\b(?:oil|gas|brent|wti|opec|petroleo|energia)\b/u.test(text) ? "energy"
    : /\b(?:gold|copper|silver|oro|cobre|plata)\b/u.test(text) ? "metals"
      : general.reasonCode === "geopolitics" ? "geopolitics" : sector ? "macro_markets" : "other";
  return { ...base, admit: admit || (mentions && concrete), factuality: concrete ? "fact" : "unknown",
    evidence: concrete && (structured || (event.summary?.trim().length ?? 0) >= 40 || CONCRETE_CORPORATE.test(title)) ? "sufficient" : "limited",
    topic, factType: concrete ? topic : null, watchlistRelation: direct ? "direct_material" : mentions ? "incidental" : "none",
    reasons: [concrete ? "concrete_economic_fact" : admit ? "topic_without_confirmed_fact" : "no_concrete_economic_fact",
      ...(direct ? ["direct_material_watchlist"] : mentions ? ["incidental_watchlist"] : [])] };
}
