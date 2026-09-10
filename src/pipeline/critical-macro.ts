import type { NormalizedEvent } from "../schema/event.ts";
type Event = Pick<NormalizedEvent, "title" | "official"> & Partial<NormalizedEvent>;
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const speculative = /\b(?:could|might|may|expected to|preview|forecast to|rumou?r|reportedly|opinion|podria|se espera|preve que)\b/u;
const routine = /\b(?:speech|remarks|working paper|seminar|minutes|discurso|conference|appointment)\b/u;
export function criticalMacro(event: Event): boolean {
  const title = fold(event.title), text = fold(`${event.title} ${event.summary ?? ""}`);
  if (speculative.test(title)) return false;
  const decision = /\b(?:monetary policy decisions?|rate decision|fomc statement|policy statement|statement on monetary policy|decision de tipos)\b/u.test(title);
  const bank = ["ecb-press", "fed-press", "boe-news", "boe-publications", "boj-news"].includes(event.series_id ?? "") ||
    /\b(?:ecb|bce|fed|federal reserve|bank of england|bank of japan|boe|boj|banco central)\b/u.test(text);
  const action = /\b(?:raises?|cuts?|hikes?|increases?|reduces?|reduced|lowers?|lowered|holds?|held|keeps?|maintains?|maintained|unchanged|announces?|resumes?|ends?|eleva|sube|recorta|reduce|mantiene)\b/u.test(text);
  const rates = /\b(?:interest rates?|policy rates?|bank rate|deposit (?:facility|rate)|tipos|tasa|types of interest)\b/u.test(text);
  const explicit = bank && action && rates;
  if (routine.test(title) && !explicit) return false;
  if ((event.official && decision) || explicit) return true;
  if (event.kind === "macro_release") {
    if (event.series_id === "ECBDFR") return event.actual != null && event.previous != null && event.actual !== event.previous;
    return /\b(?:cpi|ipc|gdp|pib|unemployment|employment|payrolls|empleo|inflacion|armonizado)\b/u.test(text);
  }
  if (!event.official) return false;
  return /\b(?:employment situation|consumer price index|cpi release|gross domestic product|jobs report)\b/u.test(title) ||
    (action && /\b(?:asset purchases|reinvestments?|liquidity|quantitative easing|quantitative tightening|compras de activos|liquidez|inflation forecast|growth forecast|previsiones)\b/u.test(text));
}

/** Equivalencia estrecha del hecho de tipos, no similitud temática. Desconocido
 * => no deduplicar. La fecha del periodo estructurado NO se inventa como publicación. */
type RateFact = { bank: string; rate: number; delta: number; day: string; structured: boolean; update: boolean };
// Los snapshots se reemplazan al enriquecer, no se mutan. Como las traits de
// agrupar.ts, cada objeto se analiza una vez, no una vez por pareja del backlog.
const rateFacts = new WeakMap<object, RateFact | null>();
export function rateFact(event: Event): RateFact | null {
  const cached = rateFacts.get(event);
  if (cached !== undefined) return cached;
  const result = readRateFact(event);
  rateFacts.set(event, result);
  return result;
}
function readRateFact(event: Event): RateFact | null {
  if (event.kind === "macro_release" && event.series_id === "ECBDFR" && event.actual != null && event.previous != null && event.actual !== event.previous) {
    const day = (event.data_period_at ?? event.observed_at)?.slice(0, 10);
    return day ? { bank: "ecb", rate: event.actual, delta: Math.round((event.actual - event.previous) * 100), day, structured: true, update: false } : null;
  }
  const text = fold(`${event.title}. ${event.summary ?? ""}`);
  if (speculative.test(fold(event.title)) || !/\b(?:ecb|bce|european central bank|banco central europeo)\b/u.test(text) && event.series_id !== "ecb-press") return null;
  const amount = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:basis points?|bps|puntos basicos)\b/u);
  const rate = text.match(/(?:deposit (?:facility|rate)|facilidad de deposito|tipo de deposito)[^.;]{0,150}?(\d+[.,]\d+|\d+)\s*(?:%|per cent|percent|por ciento)/u);
  const actionText = amount?.index === undefined ? "" : text.slice(Math.max(0, amount.index - 180), amount.index);
  if (event.series_id !== "ecb-press" && !/\b(?:ecb|bce|european central bank|banco central europeo)\b/u.test(actionText)) return null;
  const up = /\b(?:raises?|raised|hikes?|hiked|increase[sd]?|eleva|sube|subida)\b/u.test(actionText);
  const down = /\b(?:cuts?|cut|lowers?|reduces?|recorta|reduce|bajada)\b/u.test(actionText);
  const day = (event.publication_at ?? event.observed_at)?.slice(0, 10);
  if (!amount || !rate || up === down || !day) return null;
  return { bank: "ecb", rate: Number(rate[1]!.replace(",", ".")), delta: Number(amount[1]!.replace(",", ".")) * (up ? 1 : -1),
    day, structured: false, update: /\b(?:correction|corrects?|revised|revises?|liquidity|asset purchases|reinversiones|liquidez|corrige)\b/u.test(fold(event.title)) ||
      /\b(?:raises?|cuts?|revises?|announces?|introduces?|expands?)\b[^.!?]{0,80}\b(?:inflation forecast|growth forecast|liquidity (?:programme|program)|asset purchases|reinvestments)\b/u.test(text) };
}
export function sameMacroFact(a: NormalizedEvent, b: NormalizedEvent): boolean {
  const x = rateFact(a), y = rateFact(b);
  if (!x || !y || x.bank !== y.bank || x.rate !== y.rate || x.delta !== y.delta) return false;
  if (x.structured === y.structured) return !x.update && !y.update && x.day === y.day;
  // El tipo efectivo puede aparecer días después del comunicado. Exigir ambos
  // valores (nivel y variación) y una ventana corta; no enlazar por fecha sola.
  const structured = x.structured ? x : y, release = x.structured ? y : x;
  const lag = Date.parse(structured.day) - Date.parse(release.day);
  return lag >= 0 && lag <= 14 * 86_400_000;
}
