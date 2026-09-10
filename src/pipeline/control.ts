/**
 * Decisiones y reservas durables: se cuenta el INTENTO antes de hacer red.
 *
 * Tres cosas distintas que es facil confundir aqui:
 *
 * - **Intento**: cada vez que este ciclo se dispone a mandar algo.
 * - **Reserva**: la fila que `reserve()` escribe en `news_usage`, con su `id`
 *   unico. Es lo que cuenta contra la cuota, y se escribe ANTES de la red.
 * - **Entrega efectiva**: lo que Telegram acepto, y eso vive en `alerts` y en
 *   `alert_deliveries`, no aqui.
 *
 * La cuota cuenta reservas, o sea intentos, y **no se devuelve** cuando el envio
 * falla despues. Suena a defecto y es deliberado: la cuota existe para proteger
 * el telefono de Alberto de una tormenta, y el escenario que la pone a prueba es
 * justo el de los fallos —un 429 o un 5xx sostenido con reintentos en cada
 * ciclo—. Devolver la cuota al fallar deja la unica proteccion que hay atada al
 * exito del sistema, que es cuando menos falta hace. El precio, dicho: una tarde
 * de errores de Telegram puede consumir la cuota del dia sin que haya salido una
 * sola noticia.
 *
 * **Decision pendiente, no cerrada** (Agente 2, oleada 1): si algun dia se
 * quiere separar, la forma correcta no es devolver la reserva, sino contar en
 * dos cubos —intentos y entregas— y poner el limite editorial sobre el segundo,
 * dejando el primero como cortacircuitos con un tope mas alto. Eso cambia la
 * politica editorial y por eso no se toca aqui sin pedirlo.
 *
 * `reason` es el vocabulario de la reserva y se queda como esta; quien lo
 * persiste en una decision le antepone `deferred_quota_` (C3), para que un tope
 * de mensajes no se confunda con un presupuesto de IA agotado ni con un texto
 * irredactable.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { NewsDecision } from "./news-policy.ts";
export type Resource = "brief" | "important" | "ai";
export type Reservation = { id: string; resource: Resource; units: number; now: string; hourLimit?: number; dayLimit: number; minimumIntervalMs?: number };
export type ReservationResult = { allowed: boolean; reason: "allowed" | "hour_limit" | "day_limit" | "interval"; nextAt: string | null };
export type AiRecord = { provider: string; model: string; promptVersion: string; stage: "scoring" | "analysis";
  inputTokens: number | null; outputTokens: number | null; attempt: number; costUsd: number | null; result: "success" | "failed" | "uncertain" };
export interface ControlStore {
  putDecision(id: string, decision: NewsDecision): Promise<void>;
  getDecision(id: string): Promise<NewsDecision | null>;
  reserve(request: Reservation): Promise<ReservationResult>;
  recordAi(id: string, record: AiRecord): Promise<void>;
  stats(now: string): Promise<{ resource: Resource; units: number; calls: number; costUsd: number | null }[]>;
}
type Usage = { id: string; resource: Resource; units: number; at: string; ai?: AiRecord };
type State = { version: 1; decisions: Record<string, NewsDecision>; usage: Usage[] };
const empty = (): State => ({ version: 1, decisions: {}, usage: [] });
const nextDay = (now: string) => new Date(Date.parse(now.slice(0, 10) + "T00:00:00Z") + 86400_000).toISOString();
export function validateReservation(r: Reservation) {
  if (!r.id || !["ai", "brief", "important"].includes(r.resource) || !Number.isFinite(Date.parse(r.now)) ||
      !Number.isSafeInteger(r.units) || r.units < 1 || !Number.isSafeInteger(r.dayLimit) || r.dayLimit < 0 ||
      (r.hourLimit !== undefined && (!Number.isSafeInteger(r.hourLimit) || r.hourLimit < 0)) ||
      (r.minimumIntervalMs !== undefined && (!Number.isSafeInteger(r.minimumIntervalMs) || r.minimumIntervalMs < 0))) throw new Error("invalid_budget_reservation");
}
function makeStore(access: <T>(fn: (state: State) => T, write: boolean) => Promise<T>): ControlStore {
  return {
    putDecision: (id, decision) => access((s) => { s.decisions[id] = structuredClone(decision); }, true),
    getDecision: (id) => access((s) => structuredClone(s.decisions[id] ?? null), false),
    reserve: (r) => {
      validateReservation(r);
      r = { ...r, now: new Date(r.now).toISOString() };
      return access((s) => {
        const existing = s.usage.find((u) => u.id === r.id);
        if (existing) {
          if (existing.resource !== r.resource || existing.units !== r.units) throw new Error("budget_reservation_conflict");
          return { allowed: true, reason: "allowed", nextAt: null };
        }
        const relevant = s.usage.filter((u) => u.resource === r.resource);
        const daily = relevant.filter((u) => u.at.slice(0, 10) === r.now.slice(0, 10));
        if (daily.reduce((n, u) => n + u.units, 0) + r.units > r.dayLimit) return { allowed: false, reason: "day_limit", nextAt: nextDay(r.now) };
        const hourly = relevant.filter((u) => Date.parse(u.at) > Date.parse(r.now) - 3600_000);
        if (r.hourLimit !== undefined && hourly.reduce((n, u) => n + u.units, 0) + r.units > r.hourLimit) {
          return { allowed: false, reason: "hour_limit", nextAt: new Date(Math.min(...hourly.map((u) => Date.parse(u.at)), Date.parse(r.now)) + 3600_000).toISOString() };
        }
        const last = relevant.sort((a, b) => b.at.localeCompare(a.at))[0];
        if (last && r.minimumIntervalMs && Date.parse(last.at) + r.minimumIntervalMs > Date.parse(r.now)) {
          return { allowed: false, reason: "interval", nextAt: new Date(Date.parse(last.at) + r.minimumIntervalMs).toISOString() };
        }
        s.usage.push({ id: r.id, resource: r.resource, units: r.units, at: r.now });
        return { allowed: true, reason: "allowed", nextAt: null };
      }, true);
    },
    recordAi: (id, record) => access((s) => {
      const row = s.usage.find((u) => u.id === id && u.resource === "ai");
      if (!row) throw new Error("ai_reservation_missing");
      row.ai = structuredClone(record);
    }, true),
    stats: (now) => access((s) => (["brief", "important", "ai"] as Resource[]).map((resource) => {
      const rows = s.usage.filter((u) => u.resource === resource && u.at.slice(0, 10) === now.slice(0, 10));
      return { resource, units: rows.reduce((n, u) => n + u.units, 0), calls: rows.length,
        costUsd: resource !== "ai" ? 0 : rows.some((u) => u.ai?.costUsd == null) ? null : rows.reduce((n, u) => n + u.ai!.costUsd!, 0) };
    }), false),
  };
}
export function memoryControlStore(): ControlStore {
  const state = empty(); return makeStore(async (fn) => fn(state));
}
export function fileControlStore(directory: string): ControlStore {
  const path = join(directory, "news-control.json"), lock = `${path}.lock`;
  const read = (): State => {
    if (!existsSync(path)) return empty();
    const data = JSON.parse(readFileSync(path, "utf8")) as State;
    if (data.version !== 1 || !Array.isArray(data.usage) || !data.decisions || typeof data.decisions !== "object") throw new Error("invalid_control_state");
    const ids = new Set<string>();
    for (const row of data.usage) {
      if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id) ||
          !["brief", "important", "ai"].includes(row.resource) || !Number.isSafeInteger(row.units) || row.units < 1 ||
          typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) throw new Error("invalid_control_state");
      ids.add(row.id);
    }
    return data;
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  return makeStore(async (fn, write) => {
    if (!write) return fn(read());
    mkdirSync(directory, { recursive: true });
    let fd: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { fd = openSync(lock, "wx"); break; }
      catch (error) { if (!["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await pause(); }
    }
    if (fd === undefined) throw new Error("control_file_busy");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      const state = read(), result = fn(state);
      const tmp = `${path}.${randomUUID()}.tmp`, output = openSync(tmp, "wx");
      try { writeFileSync(output, JSON.stringify(state)); fsyncSync(output); } finally { closeSync(output); }
      for (let attempt = 0; ; attempt++) {
        try { renameSync(tmp, path); break; }
        catch (error) {
          if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await pause();
        }
      }
      return result;
    } finally {
      closeSync(fd);
      for (let attempt = 0; ; attempt++) {
        try { unlinkSync(lock); break; }
        catch (error) {
          if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await pause();
        }
      }
    }
  });
}
export class BudgetExhausted extends Error {
  readonly code = "AI_BUDGET_EXHAUSTED";
  constructor(readonly nextAt: string | null) { super("ai_budget_exhausted"); }
}
