/**
 * Formateo y envío de la alerta (formato del §1 del spec).
 *
 * El formateo es una función pura y se prueba sola. El envío es lo único que
 * toca la red.
 */
import type { Analysis, Scoring } from "../ai/cascade.ts";
import type { NormalizedEvent, SurpriseBasis } from "../schema/event.ts";

const IMPACT: Record<Scoring["sentiment"], string> = {
  bullish: "🟢 BULLISH",
  bearish: "🔴 BEARISH",
  neutral: "⚪ NEUTRAL",
};

/** Contra qué se compara la sorpresa. Se dice SIEMPRE: sin base, la cifra miente por omisión. */
const BASIS_LABEL: Record<SurpriseBasis, string> = {
  consensus: "vs consenso",
  previous: "vs anterior",
  mean_3m: "vs media 3m",
};

/** Número en formato español: coma decimal. */
export function es(n: number, decimals = 1): string {
  return n.toFixed(decimals).replace(".", ",");
}

function signo(n: number, decimals = 1): string {
  return (n > 0 ? "+" : "") + es(n, decimals);
}

export function formatAlert(
  event: NormalizedEvent,
  scoring: Scoring,
  analysis: Analysis | null,
): string {
  const unit = event.unit ?? "";
  const lines: string[] = ["🚨 MARKET ALERT", `${event.country ?? ""} ${event.title}`.trim()];

  // Linea de cifras. Solo aparece lo que existe: un hueco es preferible a un cero.
  const cifras: string[] = [];
  if (event.actual !== null) cifras.push(`Actual: ${es(event.actual)}${unit}`);
  if (event.consensus !== null) cifras.push(`Consenso: ${es(event.consensus)}${unit}`);
  else if (event.previous !== null) cifras.push(`Anterior: ${es(event.previous)}${unit}`);
  if (event.surprise) {
    cifras.push(`Sorpresa: ${signo(event.surprise.value)} pp (${BASIS_LABEL[event.surprise.basis]})`);
  }
  if (cifras.length > 0) lines.push(cifras.join(" | "));

  lines.push(
    `IMPORTANCIA: ${Math.round(scoring.importance_score)}/10 | IMPACTO: ${IMPACT[scoring.sentiment]}`,
  );

  if (analysis) {
    lines.push(`Por qué importa: ${analysis.why_it_matters}`);
    if (analysis.affected_assets.length > 0) {
      const assets = analysis.affected_assets
        .map((a) => `${a.symbol} ${arrows(a.direction, a.confidence)}`)
        .join(", ");
      lines.push(`Activos afectados: ${assets}`);
    }
    if (analysis.what_to_watch.length > 0) {
      // El modelo escribe cada punto como una frase, con su punto final. Unirlos
      // con comas produce "vivienda y servicios., La variación...". Se limpian.
      lines.push(`Qué vigilar ahora: ${analysis.what_to_watch.map(limpiar).join(" · ")}`);
    }
  } else {
    lines.push(`Resumen: ${scoring.one_liner}`);
  }

  if (event.stale) {
    lines.push("⚠️ Dato obsoleto: es el último válido conocido, no uno fresco.");
  }
  lines.push(`Fuente: ${event.source_url ?? event.source} · dato de ${event.observed_at}`);

  return lines.join("\n");
}

/** Quita el punto final y los espacios de un elemento de lista. */
function limpiar(s: string): string {
  return s.trim().replace(/\.+$/, "");
}

function arrows(direction: "up" | "down" | "unclear", confidence: number): string {
  if (direction === "unclear") return "⚪";
  const icon = direction === "up" ? "🟢" : "🔴";
  return icon.repeat(Math.max(1, Math.min(3, Math.round(confidence))));
}

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  return { ok: res.ok && body.ok === true, description: body.description };
}
