import { sinHtml, decodeEntities } from "../lib/feed.ts";
import type { NormalizedEvent } from "../schema/event.ts";
/** RSS del BCE observado: título, enlace y pubDate, sin entradilla. Se guarda
 * primero; SOLO al procesar una decisión se lee su comunicado original. */
export async function enrichEcbDecision(event: NormalizedEvent, transport: typeof fetch = fetch): Promise<NormalizedEvent> {
  if (event.source !== "rss" || event.series_id !== "ecb-press" || !event.official ||
      !/^\s*monetary policy decisions?\s*$/i.test(event.title) || (event.summary?.length ?? 0) >= 80) return event;
  const fail = () => new Error("official_release_unavailable");
  let url: URL;
  try { url = new URL(event.source_url ?? ""); } catch { throw fail(); }
  if (url.origin !== "https://www.ecb.europa.eu" || url.username || url.password || url.search ||
      !/^\/{1,2}press\/pr\/date\/\d{4}\/html\/ecb\.mp\d{6}~[a-f0-9]+\.en\.html$/.test(url.pathname)) throw fail();
  const signal = AbortSignal.timeout(8_000);
  try {
    const response = await transport(url.href, { signal, redirect: "error", headers: { "User-Agent": "news-monitor/0.1" } });
    if (!response.ok || !response.body) throw fail();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 1_000_000) throw fail();
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); }
    const html = new TextDecoder().decode(Buffer.concat(chunks));
    return { ...event, summary: parseEcbDecision(html) };
  } catch { throw fail(); }
}
export function parseEcbDecision(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main || !/<h1[^>]*>\s*Monetary policy decisions?\s*<\/h1>/i.test(main)) throw new Error("official_release_shape");
  const paragraphs = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => sinHtml(decodeEntities(match[1]!)));
  const first = paragraphs.findIndex((text) => /Governing Council/i.test(text));
  const summary = paragraphs.slice(first, first + 16).join("\n").slice(0, 12_000);
  if (first < 0 || !/interest rates?/i.test(summary) || summary.length < 100) throw new Error("official_release_shape");
  return summary;
}
