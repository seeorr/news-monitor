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
export function factualText(event: NormalizedEvent, proposed: string): boolean {
  const input = extractNumbers(`${event.title} ${event.summary ?? ""}`);
  for (const value of [event.actual, event.previous, event.consensus, ...event.surprises.map((x) => x.value)]) if (value !== null) input.push(value);
  // Los números estructurales admitidos en análisis no sirven como hechos:
  // un 5 % también tiene que estar realmente en la fuente del aviso.
  return extractNumbers(proposed).every((n) => input.some((v) => Math.abs(n - v) < 0.001));
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
  const all = [analysis.why_it_matters, ...analysis.what_to_watch, ...analysis.risks, ...analysis.catalysts].join(" ");
  if (!factualText(event, all)) throw new Error("analysis_numbers_not_supported");
  const why = sentence(analysis.why_it_matters, 300);
  const watch = sentence(analysis.what_to_watch.join(" "), 260);
  const risk = sentence(analysis.risks.join(" "), 220);
  const inputTokens = new Set(`${event.title} ${event.summary ?? ""} ${event.series_id ?? ""}`.toUpperCase().split(/[^\p{L}\p{N}.$^]+/u));
  const assets = analysis.affected_assets.filter((a) => inputTokens.has(a.symbol.toUpperCase()))
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
