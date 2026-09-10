/**
 * Formateo y envío de la alerta (formato del §1 del spec).
 *
 * El formateo es una función pura y se prueba sola. El envío es lo único que
 * toca la red.
 */
import type { Analysis, Scoring } from "../ai/cascade.ts";
// El desenlace de un envío se declara donde vive la máquina de estados de la
// entrega, y no otra vez aquí: dos uniones idénticas con dos nombres son dos
// uniones que un día dicen cosas distintas.
import type { EstadoEntrega } from "../pipeline/seen.ts";
import type { NormalizedEvent, Surprise, SurpriseBasis } from "../schema/event.ts";

const IMPACT: Record<Scoring["sentiment"], string> = {
  bullish: "🟢 BULLISH",
  bearish: "🔴 BEARISH",
  neutral: "⚪ NEUTRAL",
};

/**
 * Contra qué se compara la sorpresa. Se dice SIEMPRE: sin base, la cifra miente
 * por omisión.
 *
 * Se exporta porque el dashboard imprime la misma línea de cifras y esa etiqueta
 * no es opcional allí tampoco. Tres cadenas duplicadas son tres cadenas que un
 * día dicen cosas distintas en el móvil y en la pantalla.
 */
export const BASIS_LABEL: Record<SurpriseBasis, string> = {
  consensus: "vs consenso",
  previous: "vs anterior",
  mean_3m: "vs media 3m",
};

/**
 * La sorpresa, escrita entera: signo, magnitud, unidad y base.
 *
 * Existe como funcion —y no como dos lineas repetidas— porque la escriben dos
 * sitios, la alerta de Telegram y el dashboard, y ya se habian separado: la
 * alerta decia "-0,2 pp (vs anterior)" y la pantalla "-0,2% vs anterior" para la
 * misma cifra del mismo evento. La misma cifra leida de dos formas es un fallo
 * de coherencia, y de los que nadie reporta porque cada pantalla, por separado,
 * parece correcta.
 *
 * La diferencia entre dos porcentajes son **puntos porcentuales**, no un
 * porcentaje: por eso `pp` cuando la unidad es `%`. Con cualquier otra unidad se
 * escribe esa unidad, que es lo unico que se puede afirmar.
 */
export function sorpresa(s: Surprise): string {
  const unidad = s.unit === "%" ? " pp" : s.unit;
  return `${signo(s.value)}${unidad} (${BASIS_LABEL[s.basis]})`;
}

/**
 * Las sorpresas de un evento, escritas juntas y en el mismo orden siempre.
 *
 * Un evento lleva varias: contra el consenso si alguien lo tecleó, contra el
 * dato anterior y contra la media de 3 meses. La lista ya viene ordenada de más
 * a menos informativa desde `computeSurprises()`, y aquí no se reordena ni se
 * recorta: enseñar una y callar la otra es volver a elegir por el lector.
 *
 * Existe por el mismo motivo que `sorpresa()`: la escriben la alerta de Telegram
 * y el dashboard, y si cada uno junta la lista a su manera vuelve a haber dos
 * lecturas de la misma cifra —el fallo que obligó a unificar `sorpresa()`—. El
 * separador es el mismo ` · ` que usa el resto de la alerta.
 *
 * Devuelve null con la lista vacía, y no una cadena vacía: quien llama tiene que
 * decidir si escribe la etiqueta "Sorpresa:", y una cadena vacía la dejaría
 * colgando sin nada detrás.
 */
export function sorpresas(lista: readonly Surprise[]): string | null {
  if (lista.length === 0) return null;
  return lista.map(sorpresa).join(" · ");
}

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
  opts: { tambien?: string[] } = {},
): string {
  const unit = event.unit ?? "";
  const lines: string[] = ["🚨 MARKET ALERT", `${event.country ?? ""} ${event.title}`.trim()];

  // Linea de cifras. Solo aparece lo que existe: un hueco es preferible a un cero.
  const cifras: string[] = [];
  if (event.actual !== null) cifras.push(`Actual: ${es(event.actual)}${unit}`);
  if (event.consensus !== null) cifras.push(`Consenso: ${es(event.consensus)}${unit}`);
  else if (event.previous !== null) cifras.push(`Anterior: ${es(event.previous)}${unit}`);
  const linea = sorpresas(event.surprises);
  if (linea !== null) cifras.push(`Sorpresa: ${linea}`);
  if (cifras.length > 0) lines.push(cifras.join(" | "));

  lines.push(
    `IMPORTANCIA: ${Math.round(scoring.importance_score)}/10 | IMPACTO: ${IMPACT[scoring.sentiment]}`,
  );

  if (analysis) {
    lines.push(`Por qué importa: ${analysis.why_it_matters}`);
    const assets = analysis.affected_assets
      .filter((a) => limpiar(a.symbol) !== "")
      .map((a) => `${limpiar(a.symbol)} ${arrows(a.direction, a.confidence)}`);
    if (assets.length > 0) lines.push(`Activos afectados: ${assets.join(", ")}`);

    // El modelo escribe cada punto como una frase con su punto final. Unirlos
    // con comas produce "vivienda y servicios., La variación...". Se limpian, y
    // se filtra DESPUÉS de limpiar: si no, un elemento que era solo un punto deja
    // la etiqueta colgando sin nada detrás. Paso justo en la primera alerta real.
    const vigilar = analysis.what_to_watch.map(limpiar).filter((x) => x !== "");
    if (vigilar.length > 0) lines.push(`Qué vigilar ahora: ${vigilar.join(" · ")}`);
  } else {
    lines.push(`Resumen: ${scoring.one_liner}`);
  }

  // Que tres medios cuenten lo mismo es información: dice que la historia corre.
  // Y explica por qué llega un solo aviso y no tres.
  if (opts.tambien && opts.tambien.length > 0) {
    lines.push(`También lo cuentan: ${opts.tambien.join(", ")}`);
  }

  if (event.stale) {
    lines.push("⚠️ Dato obsoleto: es el último válido conocido, no uno fresco.");
  }
  lines.push(
    `Fuente: ${event.source_url ?? event.source} · ${ETIQUETA_FECHA[event.kind]} ${fecha(event.observed_at)}`,
  );

  return lines.join("\n");
}

/**
 * Un dato macro se fecha por el periodo al que se refiere; una noticia, por
 * cuándo se publicó. Decir "dato de" delante del instante de publicación de un
 * titular confunde las dos cosas, y esa confusión es justo la que el contrato
 * separa en `observed_at` y `retrieved_at`.
 */
const ETIQUETA_FECHA: Record<NormalizedEvent["kind"], string> = {
  macro_release: "dato de",
  news: "publicado",
  filing: "presentado",
  market_move: "visto",
  calendar: "agenda del",
};

/**
 * Fecha legible. Un instante ISO se queda en minutos y en UTC —la hora local de
 * quien lee no la sabemos, y fingirla sería inventar—; una fecha sin hora se
 * imprime tal cual, porque el dato no tiene más precisión que esa.
 */
export function fecha(observedAt: string): string {
  if (!observedAt.includes("T")) return observedAt;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return observedAt;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
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

/**
 * Manda el mensaje y dice **qué se puede afirmar** de lo que pasó.
 *
 * `ok` seguía respondiendo a "¿salió?" con un booleano, y un booleano no tiene
 * sitio para la tercera respuesta, que es la que hay casi siempre que algo va
 * mal: no se sabe. Un 502 de un proxy, un JSON ilegible o un cuerpo sin
 * `message_id` no demuestran ni que llegara ni que no.
 *
 * Solo un rechazo coherente —4xx que no sea 408, con `ok:false` y un
 * `error_code` que coincida con el estado HTTP— demuestra que el mensaje no
 * salió. Es la misma regla que ya aplica `sendBriefTelegram()` en el resumen
 * matinal, y se escribe igual a propósito: dos lecturas distintas de la misma
 * respuesta acabarían tratando el mismo fallo de dos maneras.
 *
 * `ok` se mantiene para quien solo necesita saber si salió —la agenda y la copia
 * al grupo— y ahora significa exactamente `state === "sent"`.
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; state: EstadoEntrega; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: unknown; error_code?: unknown; description?: string; result?: { message_id?: unknown };
  };
  const entregado = res.ok && body.ok === true && Number.isInteger(body.result?.message_id);
  const rechazado = res.status >= 400 && res.status < 500 && res.status !== 408 &&
    body.ok === false && body.error_code === res.status;
  const state: EstadoEntrega = entregado ? "sent" : rechazado ? "rejected" : "uncertain";
  return { ok: state === "sent", state, description: body.description };
}
