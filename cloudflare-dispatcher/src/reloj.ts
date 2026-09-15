/**
 * La lógica del reloj: cuándo se dispara, a quién y cómo se clasifica la respuesta.
 *
 * Vive fuera de `worker.ts` a propósito. workerd —el runtime de Cloudflare, también
 * el de `wrangler dev`— trata cada export del módulo principal como un posible
 * punto de entrada, y una constante exportada allí (`CRON`) le hacía rechazar el
 * Worker entero en local: «Incorrect type for map entry 'CRON': the provided value
 * is not of type 'function or ExportedHandler'». En producción se toleraba, pero
 * dejaba el reloj sin forma de probarse antes de desplegar. `worker.ts` exporta
 * ahora solo el manejador; todo lo demás, y sus tests, está aquí.
 *
 * Solo reloj: sin fetch handler, estado de noticias ni credenciales de Telegram.
 */
export interface Env {
  ENABLED: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW: string;
  GITHUB_REF: string;
  GITHUB_TOKEN?: string;
  STRATEGY: "mixed" | "fast-only";
  /** Workflow del vigilante de salud (`salud.yml`). Sin él, el cron del vigilante falla visible. */
  GITHUB_HEALTH_WORKFLOW?: string;
}
/**
 * El reloj dice CUÁNDO, no EN QUÉ MODO. Y esto no es una simplificación: era una
 * trampa con fecha de caducidad.
 *
 * El worker mandaba su propio `MONITOR_MODE` como input del dispatch, y en
 * `monitor.yml` el input **gana** sobre `vars.MONITOR_MODE`. Con la variable del
 * repositorio en `full` y la del worker en `capture-only`, cada ejecución
 * automática habría capturado sin enviar mientras las manuales sí enviaban: el
 * sistema "funcionando" y sin mandar nada, que es exactamente el fallo del que
 * viene todo esto. Y se habría notado tarde, porque cada mitad, por separado,
 * parece bien configurada.
 *
 * `auto` deja que mande la variable del repositorio y nadie más. Un solo sitio
 * donde cambiar el modo, y ninguna forma de que dos configuraciones se
 * contradigan sin que nadie lo vea.
 */
const MODE = "auto";
export type DispatchProfile = "fast" | "full";
// `invalid_request` es aditivo y separa un fallo DETERMINISTA de la petición
// —el runtime la rechaza al construirla— de `uncertain`, que sigue significando
// «no se sabe si GitHub la recibió». Mezclarlos costó cinco horas de diagnóstico
// el 10-09: un TypeError permanente parecía una red inestable e invitaba a esperar.
export type DispatchState = "disabled" | "accepted" | "rejected" | "timeout" | "uncertain" | "invalid_config" | "invalid_request";
export type SafeRecord = { state: DispatchState; profile?: DispatchProfile; http?: number; target?: "health" };
export const CRON = "3,13,23,33,43,53 * * * *";
/**
 * El vigilante sale del mismo reloj y del mismo disparo: en el de las :53 de cada hora,
 * además del monitor. Su `schedule` horario en GitHub entregó 6 disparos en 15 horas el
 * 14-09, y un vigilante que no se ejecuta se parece a un día tranquilo.
 *
 * No tiene cron propio a propósito. Se probó un segundo trigger (`51 * * * *`): quedó
 * registrado en Cloudflare, con su «Next» avanzando, y no se invocó ni una vez en tres
 * horas, igual que le pasó a este reloj el 10-09. El trigger del monitor sí está
 * demostrado. Se queda además el `schedule` de GitHub como respaldo, porque si este
 * reloj se para, el vigilante que lanza se para con él.
 */
export const HEALTH_MINUTE = 53;
export type DispatchTarget = "monitor" | "health";
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
/**
 * La petición entera va tipada, y no solo la constante de arriba.
 *
 * Con la constante sola, el literal seguía siendo legal: bastaba con volver a
 * escribir `redirect: "error"` en el objeto para tener el fallo de vuelta, y el
 * `tsconfig` de la raíz —que es el que corre en `npm run typecheck`— comprueba
 * este archivo contra los tipos del DOM, donde `RequestRedirect` **sí** incluye
 * `"error"` porque la especificación de fetch lo define. Ahí estaba el hueco por
 * el que entró el fallo: el tipo correcto para el navegador es el tipo
 * equivocado para el edge.
 *
 * Estrechar `redirect` aquí lo cierra sin depender de qué `tsconfig` se ejecute
 * y sin añadir un paquete de tipos: `"error"` deja de compilar en los dos.
 */
type PeticionDeReloj = Omit<RequestInit, "redirect"> & { redirect: RedirectSoportadoPorWorkerd };
export function selectProfile(scheduledTime: number, strategy: Env["STRATEGY"]): DispatchProfile {
  const minute = new Date(scheduledTime).getUTCMinutes();
  if (![3, 13, 23, 33, 43, 53].includes(minute) || !["mixed", "fast-only"].includes(strategy)) throw new Error("invalid_config");
  return strategy === "mixed" && (minute === 3 || minute === 33) ? "full" : "fast";
}
export async function dispatch(scheduledTime: number, env: Env, dependencies: {
  fetch?: typeof fetch; log?: (record: SafeRecord) => void; timeoutMs?: number;
} = {}, target: DispatchTarget = "monitor"): Promise<SafeRecord> {
  const log = dependencies.log ?? ((record) => console.log(JSON.stringify(record)));
  let profile: DispatchProfile | undefined;
  const tag = target === "health" ? { target } as const : {};
  const fail = (state: DispatchState, http?: number): never => {
    log({ state, ...tag, ...(profile ? { profile } : {}), ...(http ? { http } : {}) });
    // Nunca propagar errores de fetch, del proveedor ni datos configurados.
    throw new Error(`dispatch_${state}`);
  };
  if (env.ENABLED === "false") { const result = { state: "disabled", ...tag } as const; log(result); return result; }
  const workflow = target === "health" ? env.GITHUB_HEALTH_WORKFLOW ?? "" : env.GITHUB_WORKFLOW;
  try {
    // El vigilante no tiene perfil: solo se valida que dispare en su minuto.
    if (target === "monitor") profile = selectProfile(scheduledTime, env.STRATEGY);
    else if (new Date(scheduledTime).getUTCMinutes() !== HEALTH_MINUTE) throw new Error();
    if (env.ENABLED !== "true" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(env.GITHUB_OWNER) ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(env.GITHUB_REPO) || [".", ".."].includes(env.GITHUB_REPO) || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow) ||
        !env.GITHUB_REF || env.GITHUB_REF.length > 200 || /[\x00-\x20\x7f]/.test(env.GITHUB_REF) ||
        !env.GITHUB_TOKEN) throw new Error();
  } catch { return fail("invalid_config"); }
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? 8_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail("invalid_config");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  // Anotada, y no inferida: es la anotación la que hace que `"error"` no compile.
  const peticion: PeticionDeReloj = {
    method: "POST", redirect: REDIRECT, signal: controller.signal,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json", "User-Agent": "news-monitor-clock" },
    // `salud.yml` no declara inputs: mandarle los del monitor sería un 422.
    body: JSON.stringify(target === "health" ? { ref: env.GITHUB_REF }
      : { ref: env.GITHUB_REF, inputs: { profile, origin: "external", mode: MODE } }),
  };
  try {
    // La carrera acota también un transporte que no atienda AbortSignal.
    response = await Promise.race([
      (dependencies.fetch ?? fetch)(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, peticion),
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
    const result: SafeRecord = { state: "accepted", ...tag, ...(profile ? { profile } : {}), http: response.status };
    log(result); return result;
  }
  return fail([401, 403, 404, 422, 429].includes(response.status) ? "rejected" : "uncertain", response.status);
}
/**
 * Siempre el monitor; a las :53, también el vigilante. Independientes: si uno falla,
 * el otro sale igual. Después se relanza el primer fallo, para que el disparo quede
 * en rojo en los Cron Events en vez de parecer correcto.
 */
export async function scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
  const tareas = [dispatch(controller.scheduledTime, env, {}, "monitor")];
  if (new Date(controller.scheduledTime).getUTCMinutes() === HEALTH_MINUTE) {
    tareas.push(dispatch(controller.scheduledTime, env, {}, "health"));
  }
  const fallo = (await Promise.allSettled(tareas)).find((resultado) => resultado.status === "rejected");
  if (fallo) throw fallo.reason;
}
