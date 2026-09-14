import type { Analysis, Scoring } from "../ai/cascade.ts";
import type { NormalizedEvent } from "../schema/event.ts";
import { extractNumbers } from "../lib/fabrication.ts";
const clean = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();
const sentence = (s: string, limit: number) => {
  const text = clean(s);
  if (text.length <= limit) return text;
  // Nunca cortar a mitad de frase: podría borrar la negación o una condición.
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [];
  let out = "";
  for (const part of parts) { if ((out + part).length > limit) break; out += part; }
  return out.trim();
};
/**
 * Lo que el control estricto necesita de un evento. Estructural a propósito: vale
 * igual para un evento del ciclo que para una fila del dashboard, y así las dos
 * rutas comprueban con la misma función y no con dos copias que acaben discrepando.
 */
export interface FuenteDeCifras {
  title: string;
  summary: string | null;
  actual: number | null;
  previous: number | null;
  consensus: number | null;
  surprises: ReadonlyArray<{ value: number }>;
  series_id?: string | null;
}

/** Cifras del texto que no están en la fuente: titular, entradilla, dato, anterior, consenso o sorpresas. */
export function unsupportedNumbers(event: FuenteDeCifras, proposed: string): number[] {
  const input = extractNumbers(`${event.title} ${event.summary ?? ""}`);
  for (const value of [event.actual, event.previous, event.consensus, ...event.surprises.map((x) => x.value)]) if (value !== null) input.push(value);
  // Los números estructurales admitidos en análisis no sirven como hechos:
  // un 5 % también tiene que estar realmente en la fuente del aviso.
  return [...new Set(extractNumbers(proposed).filter((n) => !input.some((v) => Math.abs(n - v) < 0.001)))];
}

export function factualText(event: FuenteDeCifras, proposed: string): boolean {
  return unsupportedNumbers(event, proposed).length === 0;
}

/** Toda la prosa del análisis, que es lo que se comprueba entero: también `what_to_watch`. */
export function prosaDelAnalisis(analysis: Pick<Analysis, "why_it_matters" | "catalysts" | "risks" | "what_to_watch">): string {
  return [analysis.why_it_matters, ...analysis.catalysts, ...analysis.risks, ...analysis.what_to_watch].join(" ");
}

/** Activos que aparecen de verdad en la fuente. Un símbolo que el modelo trae de memoria no se enseña. */
export function supportedAssets<T extends { symbol: string }>(event: FuenteDeCifras, assets: readonly T[]): T[] {
  const tokens = new Set(`${event.title} ${event.summary ?? ""} ${event.series_id ?? ""}`.toUpperCase().split(/[^\p{L}\p{N}.$^]+/u));
  return assets.filter((a) => tokens.has(a.symbol.toUpperCase()));
}
function source(event: NormalizedEvent): string {
  if (event.source_url) {
    const url = new URL(event.source_url);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return `Fuente: ${url.href}`;
  }
  return `Fuente: ${event.source} (enlace no disponible)`;
}
export function formatInteresting(event: NormalizedEvent, scoring: Scoring, update = false): string {
  const fact = factualText(event, scoring.one_liner) ? sentence(scoring.one_liner, 260) : "";
  if (!fact) throw new Error("short_fact_not_supported");
  const title = sentence(fact, 105) || "Novedad económica confirmada";
  return [`📰 ${update ? "Actualización: " : ""}${title}`, ...(title === fact ? [] : [`Qué pasó: ${fact}`]), source(event)].join("\n\n");
}
export function formatImportant(event: NormalizedEvent, scoring: Scoring, analysis: Analysis, update = false): string {
  const fact = factualText(event, scoring.one_liner) ? sentence(scoring.one_liner, 240) : "";
  if (!fact) throw new Error("important_fact_not_supported");
  if (!factualText(event, prosaDelAnalisis(analysis))) throw new Error("analysis_numbers_not_supported");
  const why = sentence(analysis.why_it_matters, 300);
  const watch = sentence(analysis.what_to_watch.join(" "), 260);
  const risk = sentence(analysis.risks.join(" "), 220);
  const assets = supportedAssets(event, analysis.affected_assets)
    .map((a) => `${a.symbol}: ${a.direction === "up" ? "presión al alza posible" : a.direction === "down" ? "presión a la baja posible" : "dirección incierta"}`).slice(0, 3).join("; ");
  return [`🚨 ${update ? "Actualización material: " : ""}${sentence(fact, 105) || "Noticia importante"}`,
    `Qué ha ocurrido: ${fact}`, ...(why ? [`Por qué importa (inferencia): ${why}`] : []),
    ...(assets ? [`Impacto posible (hipótesis): ${assets}`] : []),
    ...(risk ? [`Incertidumbre: ${risk}`] : []), ...(watch ? [`Qué vigilar: ${watch}`] : []), source(event)].join("\n\n");
}
export function formatNewsBatch(items: { event: NormalizedEvent; scoring: Scoring }[]): string {
  const sections = items.map((item) => formatInteresting(item.event, item.scoring));
  const body = `📰 Actualización de noticias\n\n${sections.join("\n\n")}`;
  if (body.length > 3900) throw new Error("news_batch_too_long");
  return body;
}
