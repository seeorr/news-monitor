/** Solo reloj: sin fetch handler, estado de noticias ni credenciales de Telegram. */
export interface Env {
  ENABLED: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  GITHUB_TOKEN?: string;
  STRATEGY: "mixed" | "fast-only";
  MONITOR_MODE: "full" | "capture-only";
}
export type DispatchProfile = "fast" | "full";
// `invalid_request` es aditivo y separa un fallo DETERMINISTA de la petición
// —el runtime la rechaza al construirla— de `uncertain`, que sigue significando
// «no se sabe si GitHub la recibió». Mezclarlos costó cinco horas de diagnóstico
// el 10-09: un TypeError permanente parecía una red inestable e invitaba a esperar.
export type DispatchState = "disabled" | "accepted" | "rejected" | "timeout" | "uncertain" | "invalid_config" | "invalid_request";
export type SafeRecord = { state: DispatchState; profile?: DispatchProfile; http?: number };
export const CRON = "3,13,23,33,43,53 * * * *";
/**
 * workerd —el runtime real de Cloudflare, no Node— NO implementa `redirect: "error"`.
 * Lanza un TypeError SÍNCRONO al construir la petición, antes de que salga un byte:
 *
 *   TypeError: Invalid redirect value, must be one of "follow" or "manual"
 *   ("error" won't be implemented since it does not make sense at the edge;
 *    use "manual" and check the response status code).
 *
 * (Literal del binario de wrangler 4.130.0.) Con `"error"` el reloj falló en TODAS
 * sus invocaciones —`wallTime: 1 ms`, `cpuTime: 0`— y GitHub no recibió ni un
 * dispatch en cinco horas. `"manual"` conserva la garantía: la redirección NO se
 * sigue, llega como respuesta 3xx y cae en la clasificación del final de
 * `dispatch` (302 → `uncertain` con su `http`, ya probado). El tipo de abajo
 * existe para que nadie pueda revertirlo: `"error"` no compila.
 */
type RedirectSoportadoPorWorkerd = "follow" | "manual";
const REDIRECT: RedirectSoportadoPorWorkerd = "manual";
export function selectProfile(scheduledTime: number, strategy: Env["STRATEGY"]): DispatchProfile {
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (![3, 13, 23, 33, 43, 53].includes(minute) || !["mixed", "fast-only"].includes(strategy)) throw new Error("invalid_config");
  return strategy === "mixed" && (minute === 3 || minute === 33) ? "full" : "fast";
}
export async function dispatch(scheduledTime: number, env: Env, dependencies: {
  fetch?: typeof fetch; log?: (record: SafeRecord) => void; timeoutMs?: number;
} = {}): Promise<SafeRecord> {
  const log = dependencies.log ?? ((record) => console.log(JSON.stringify(record)));
  let profile: DispatchProfile | undefined;
  const fail = (state: DispatchState, http?: number): never => {
    log({ state, ...(profile ? { profile } : {}), ...(http ? { http } : {}) });
    // Nunca propagar errores de fetch, del proveedor ni datos configurados.
    throw new Error(`dispatch_${state}`);
  };
  if (env.ENABLED === "false") { const result = { state: "disabled" } as const; log(result); return result; }
  try {
    profile = selectProfile(scheduledTime, env.STRATEGY);
    if (env.ENABLED !== "true" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(env.GITHUB_OWNER) ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(env.GITHUB_REPO) || [".", ".."].includes(env.GITHUB_REPO) || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(env.GITHUB_WORKFLOW) ||
        !env.GITHUB_REF || env.GITHUB_REF.length > 200 || /[\x00-\x20\x7f]/.test(env.GITHUB_REF) ||
        !env.GITHUB_TOKEN || !["full", "capture-only"].includes(env.MONITOR_MODE)) throw new Error();
  } catch { return fail("invalid_config"); }
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? 8_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail("invalid_config");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    // La carrera acota también un transporte que no atienda AbortSignal.
    response = await Promise.race([
      (dependencies.fetch ?? fetch)(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
        method: "POST", redirect: REDIRECT, signal: controller.signal,
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json", "User-Agent": "news-monitor-clock" },
        body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { profile, origin: "external", mode: env.MONITOR_MODE } }),
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs); }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) return fail("timeout");
    // Un TypeError aquí no es la red: es la petición mal construida, y el runtime
    // la rechaza igual en cada intento. Devolver `uncertain` invitaba a esperar a
    // que escampara algo que no iba a escampar nunca. El error NO se registra: su
    // mensaje puede llevar la URL, y la URL lleva el destino configurado.
    return fail(error instanceof TypeError ? "invalid_request" : "uncertain");
  }
  finally { clearTimeout(timer); }
  // 204: contrato anterior; 200: contrato oficial API 2026-03-10. El cuerpo no se lee.
  if (response.status === 204 || response.status === 200) {
    const result = { state: "accepted", profile, http: response.status } as const; log(result); return result;
  }
  return fail([401, 403, 404, 422, 429].includes(response.status) ? "rejected" : "uncertain", response.status);
}
export default {
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    await dispatch(controller.scheduledTime, env);
  },
};
