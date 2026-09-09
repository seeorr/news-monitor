/** Resumen determinista: solo lecturas y aritmética; sin cascada ni LLM. */
import { randomUUID } from "node:crypto";
import type { Cita } from "../sources/calendario.ts";
import type { Regimen } from "../sources/regimen.ts";

export interface BriefEvent {
  id: string;
  source: string;
  source_url: string | null;
  kind: string;
  title: string;
  /** Contexto ya puntuado y persistido; nunca se vuelve a llamar a un modelo. */
  one_liner: string | null;
  observed_at: string;
  first_seen_at: Date | string;
  importance_score: number | null;
  stale: boolean;
}
export type Snapshot<T> = { status: "ok"; data: T } | { status: "unavailable" };
export interface BriefPayload {
  version: "morning-brief-v1";
  generatedAt: string;
  window: { from: string; to: string; field: "first_seen_at"; endExclusive: true };
  events: Snapshot<BriefEvent[]>;
  agenda: Snapshot<Cita[]>;
  agendaWindow: { from: string; to: string };
  regimen: Snapshot<Regimen>;
  regimenText: string | null;
  coverage: "unknown";
  gaps: string[];
}
export interface BriefDocument { date: string; body: string; payload: BriefPayload }
export type SendState = "sent" | "rejected" | "uncertain";
export interface StoredBrief extends BriefDocument {
  state: "generated" | "sending" | SendState;
}
/**
 * Los dos destinos del resumen, que reciben **el mismo cuerpo**: el chat de
 * siempre y el grupo compartido.
 *
 * Aun siendo idéntico el texto, cada uno lleva su propio estado de envío en
 * `daily_briefs`. Que el privado salga no dice nada de si el del grupo salió, y
 * compartir una sola fila haría que el segundo destino se diera por entregado
 * sin haberlo intentado nunca.
 */
export type BriefDestination = "private" | "group";
export interface BriefStore {
  persist(brief: BriefDocument, destination: BriefDestination): Promise<StoredBrief>;
  claim(date: string, destination: BriefDestination, token: string): Promise<StoredBrief | null>;
  finish(date: string, destination: BriefDestination, token: string, state: SendState): Promise<void>;
}
export interface BriefDependencies {
  events(now: Date): Promise<BriefEvent[]>;
  agenda(opts: { desde: string; dias: number }): Promise<Cita[]>;
  regimen(now: Date): Promise<Regimen>;
  formatRegimen(regimen: Regimen): string;
  store?: BriefStore;
  /** Se ejecuta ANTES del claim; no hace red. También dice si el destino existe. */
  canSend?: (destination: BriefDestination) => boolean;
  send?: (body: string, destination: BriefDestination) => Promise<SendState>;
  claimToken?: () => string;
}
export interface BriefOptions { now: Date; dry?: boolean; send?: boolean; agendaDays?: number }
export interface DeliverOptions { send?: boolean; destination?: BriefDestination }
export type BriefRunState = "dry" | "generated" | "blocked" | SendState |
  "failed_before_send" | "record_failed_after_send";
export interface BriefResult { state: BriefRunState; brief: BriefDocument }

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** También protege el contrato de las dependencias inyectadas. */
export function selectBriefEvents(events: BriefEvent[], now: Date): BriefEvent[] {
  const to = now.getTime();
  const from = to - 24 * 3_600_000;
  return events.filter((e) => {
    const seen = new Date(e.first_seen_at).getTime();
    return e.kind !== "calendar" && e.importance_score !== null &&
      Number.isFinite(e.importance_score) && seen >= from && seen < to;
  }).sort((a, b) => b.importance_score! - a.importance_score! ||
    new Date(b.first_seen_at).getTime() - new Date(a.first_seen_at).getTime() ||
    compare(a.id, b.id)).slice(0, 5);
}

/** UTF-16 conservador: no parte pares sustitutos, ni siquiera al recortar. */
function cut(text: string, limit: number, suffix = "…"): string {
  if (text.length <= limit) return text;
  let result = text.slice(0, Math.max(0, limit - suffix.length));
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result + suffix;
}
function line(text: string, limit: number): string {
  return cut(text.replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ").trim(), limit);
}
function source(url: string | null, fallback: string): string {
  if (url) {
    try {
      const parsed = new URL(url);
      if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        if (url.length <= 110) return url;
        return `${line(parsed.hostname, 70)} (URL completa en registro)`;
      }
    } catch { /* Una URL ausente o inválida es una carencia. */ }
  }
  return `${line(fallback, 50)} (sin enlace válido)`;
}
const SHORTENED = "\n… [recortado; detalle en registro]";

export function formatBrief(payload: BriefPayload): string {
  const header = `RESUMEN MATINAL · ${payload.generatedAt.slice(0, 10)} UTC\n` +
    `Ingesta 24 h: ${payload.window.from} → ${payload.window.to} (fin excluido)`;
  const footer = "Cobertura de ingesta no verificada: la ausencia de eventos no demuestra calma.";
  const gapText = payload.gaps.length ? `Carencias: ${payload.gaps.join("; ")}.` : "";
  const agendaHeader = `AGENDA FRED · ${payload.agendaWindow.from} → ${payload.agendaWindow.to}\n` +
    "https://fred.stlouisfed.org/releases · Fechas sin hora; cobertura limitada a publicaciones seguidas.\n";
  const agendaContent = payload.agenda.status === "unavailable"
    ? "Agenda no disponible; no equivale a ausencia de citas."
    : payload.agenda.data.length === 0 ? "Sin citas devueltas en la ventana consultada."
    : payload.agenda.data.map((c) => `${c.date} · ${line(c.title, 100)} (FRED ${c.releaseId})`).join("\n");
  const agenda = cut(agendaHeader + agendaContent, 600, SHORTENED);
  let regime = "RÉGIMEN\nNo disponible; no permite inferir un mercado estable.";
  if (payload.regimen.status === "ok") {
    const r = payload.regimen.data;
    // La prosa extensa original queda en payload.regimenText. En Telegram se
    // reservan primero las cuatro señales, incluidas las que no emiten voto.
    const signals = r.signals.map((s) =>
      `${line(s.label, 40)}: ${s.value === null ? "sin dato" : line(String(s.value), 25)} ${line(s.unit, 15)}` +
      ` · ${s.date === null ? "sin fecha" : line(s.date, 30)}${s.stale ? " · OBSOLETO" : ""}` +
      `\n${line(s.detail, 100)}\n${source(s.sourceUrl, s.id)}`,
    ).join("\n");
    regime = `RÉGIMEN · ${line(r.state, 24)} · ${line(r.asOf, 30)} · ${line(r.version, 40)}\n` +
      "Regla: unanimidad de VIX, tendencia y crédito; mixto si discrepan; insuficiente si faltan votos.\n" +
      "Heurística, no predicción. Dólar amplio: contexto sin voto. Liquidez no cubierta.\n" +
      (signals || "Sin señales disponibles.");
  }
  regime = cut(regime, 1700, SHORTENED);
  const rest = [header, agenda, regime, gapText, footer].filter(Boolean);
  const newsBudget = 4096 - rest.join("\n\n").length - 2;
  let news = "EVENTOS PUNTUADOS · top 5 por importancia\n";
  if (payload.events.status === "unavailable") news += "Lectura no disponible; actualidad desconocida.";
  else if (!payload.events.data.length) news += "Sin eventos puntuados en esta ventana. Puede faltar ingesta o puntuación.";
  else {
    const budget = Math.floor((newsBudget - news.length) / payload.events.data.length) - 1;
    news += payload.events.data.map((e, i) => {
      // Reservar fechas y fuente antes de acortar el titular privado.
      const meta = `\nDato/publicación: ${line(e.observed_at, 30)} · Ingesta: ${new Date(e.first_seen_at).toISOString()}` +
        `\nFuente: ${source(e.source_url, e.source)}${e.stale ? " · OBSOLETO" : ""}`;
      const rank = `${i + 1}. ${e.importance_score}/10 · `;
      const proseBudget = Math.max(10, budget - rank.length - meta.length);
      const context = e.one_liner?.trim();
      if (context && proseBudget >= 60) {
        const titleBudget = Math.floor((proseBudget - 11) * 0.4);
        return rank + line(e.title, titleBudget) + "\nContexto: " +
          line(context, proseBudget - titleBudget - 11) + meta;
      }
      return rank + line(e.title, proseBudget) + meta;
    }).join("\n");
  }
  return [header, cut(news, newsBudget, SHORTENED), agenda, regime, gapText, footer].filter(Boolean).join("\n\n");
}

export async function generateBrief(deps: BriefDependencies, opts: BriefOptions): Promise<BriefDocument> {
  const now = new Date(opts.now);
  const date = now.toISOString().slice(0, 10);
  const dias = opts.agendaDays ?? 7;
  if (!Number.isInteger(dias) || dias < 1 || dias > 31) throw new Error("invalid_agenda_days");
  const agendaTo = new Date(`${date}T00:00:00Z`);
  agendaTo.setUTCDate(agendaTo.getUTCDate() + dias);
  // Promise.resolve().then captura también fallos síncronos de adaptadores.
  const results = await Promise.allSettled([
    Promise.resolve().then(() => deps.events(now)).then((rows) => selectBriefEvents(rows, now)),
    Promise.resolve().then(() => deps.agenda({ desde: date, dias })).then((rows) => rows
      .filter((c) => c.date >= date && c.date <= agendaTo.toISOString().slice(0, 10))
      .sort((a, b) => compare(a.date, b.date) || a.releaseId - b.releaseId)),
    Promise.resolve().then(() => deps.regimen(now)).then((r) => ({ data: r, text: deps.formatRegimen(r) })),
  ]);
  const [events, agenda, regimen] = results;
  const payload: BriefPayload = {
    version: "morning-brief-v1", generatedAt: now.toISOString(),
    window: { from: new Date(now.getTime() - 24 * 3_600_000).toISOString(),
      to: now.toISOString(), field: "first_seen_at", endExclusive: true },
    events: events.status === "fulfilled" ? { status: "ok", data: events.value } : { status: "unavailable" },
    agenda: agenda.status === "fulfilled" ? { status: "ok", data: agenda.value } : { status: "unavailable" },
    agendaWindow: { from: date, to: agendaTo.toISOString().slice(0, 10) },
    regimen: regimen.status === "fulfilled" ? { status: "ok", data: regimen.value.data } : { status: "unavailable" },
    regimenText: regimen.status === "fulfilled" ? regimen.value.text : null,
    coverage: "unknown", gaps: [],
  };
  calcularCarencias(payload);
  return { date, payload, body: formatBrief(payload) };
}

/**
 * Escribe en `payload.gaps` lo que ese payload **no** puede afirmar.
 *
 * Vive aparte de `generateBrief` porque el resumen del grupo es otro payload:
 * lleva menos eventos, y sus carencias tienen que ser ciertas para lo que ese
 * destino ve. Heredar las del privado sería declarar una cobertura que el
 * documento filtrado no tiene.
 */
export function calcularCarencias(payload: BriefPayload): void {
  payload.gaps = [];
  if (payload.events.status === "unavailable") payload.gaps.push("eventos no disponibles");
  else {
    if (!payload.events.data.length) payload.gaps.push("sin eventos puntuados");
    if (payload.events.data.some((e) => e.stale)) payload.gaps.push("eventos obsoletos");
    if (payload.events.data.some((e) => !e.source_url)) payload.gaps.push("eventos sin enlace");
  }
  if (payload.agenda.status === "unavailable") payload.gaps.push("agenda no disponible");
  if (payload.regimen.status === "unavailable") payload.gaps.push("régimen no disponible");
  else if (payload.regimen.data.state === "insufficient_data" || payload.regimen.data.signals.some(
    (s) => s.stale || s.value === null || s.date === null,
  )) payload.gaps.push("régimen con datos insuficientes u obsoletos");
}

/**
 * Persistir, reclamar, enviar y registrar **un** documento en **un** destino.
 *
 * Separado de `runBrief` para que la CLI genere una sola vez y entregue a los
 * dos destinos: repetir `generateBrief` por destino significaría dos rondas de
 * FRED y de Neon, y dos documentos que podrían no coincidir si algo cambia entre
 * medias. El comportamiento por destino es exactamente el que tenía `runBrief`.
 */
export async function deliverBrief(
  deps: BriefDependencies, documento: BriefDocument, opts: DeliverOptions = {},
): Promise<BriefResult> {
  const destination = opts.destination ?? "private";
  let brief = documento;
  try {
    if (!deps.store) return { state: "failed_before_send", brief };
    brief = await deps.store.persist(brief, destination); // El primero gana, incluido su cuerpo.
    if (!opts.send) return { state: "generated", brief };
    if (!deps.send || !deps.canSend?.(destination)) return { state: "failed_before_send", brief };
    const token = deps.claimToken?.() ?? randomUUID();
    const claimed = await deps.store.claim(brief.date, destination, token);
    if (!claimed) return { state: "blocked", brief };
    brief = claimed;
    let state: SendState;
    try { state = await deps.send(brief.body, destination); }
    catch { state = "uncertain"; } // Timeout/red: podría haber llegado.
    try { await deps.store.finish(brief.date, destination, token, state); }
    catch {
      // Sigue en sending: jamás liberar ni reintentar al perder el acuse SQL.
      return { state: state === "sent" ? "record_failed_after_send" : "uncertain", brief };
    }
    return { state, brief };
  } catch {
    // Un claim cuya respuesta se pierde también queda bloqueado, sin enviar.
    return { state: "failed_before_send", brief };
  }
}

export async function runBrief(deps: BriefDependencies, opts: BriefOptions): Promise<BriefResult> {
  const brief = await generateBrief(deps, opts);
  if (opts.dry) return { state: "dry", brief }; // Sin persistencia, preflight ni claim.
  return deliverBrief(deps, brief, { send: opts.send, destination: "private" });
}
