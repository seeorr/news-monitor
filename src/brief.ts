/** CLI: npm run brief [--send] [--dry] [--preview]. main añade el script npm. */
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { loadDotEnv } from "./config.ts";
import { dailyBriefStore, recentBriefEvents } from "./db/brief.ts";
import { fetchAgenda } from "./sources/calendario.ts";
import { deliverBrief, generateBrief, type BriefDependencies, type BriefDestination,
  type BriefRunState, type SendState } from "./pipeline/brief.ts";

export interface BriefFlags { dry: boolean; send: boolean; preview: boolean }
type BriefEnv = Record<string, string | undefined>;
export function parseBriefArgs(args: string[], env: BriefEnv): BriefFlags {
  if (args.some((arg) => !["--dry", "--send", "--preview"].includes(arg))) throw new Error("invalid_flags");
  const flags = { dry: args.includes("--dry"), send: args.includes("--send"), preview: args.includes("--preview") };
  if (flags.preview && (!flags.dry || env.GITHUB_ACTIONS !== undefined)) throw new Error("preview_not_allowed");
  return flags;
}

/** Sin retry HTTP. La implementación genérica oculta si el rechazo fue explícito. */
export async function sendBriefTelegram(
  token: string, chatId: string, body: string, request: typeof fetch = fetch,
): Promise<SendState> {
  try {
    const response = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") return "uncertain";
    const result = data as { ok?: unknown; error_code?: unknown; result?: { message_id?: unknown } };
    if (response.ok && result.ok === true && Number.isInteger(result.result?.message_id)) return "sent";
    // Solo una respuesta de rechazo coherente, nunca un proxy 5xx, un JSON roto
    // o un timeout, demuestra que el mensaje no fue aceptado.
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && result.ok === false &&
      result.error_code === response.status) return "rejected";
    return "uncertain";
  } catch { return "uncertain"; }
}

export function briefDependencies(env: BriefEnv): BriefDependencies {
  const databaseUrl = env.DATABASE_URL?.trim();
  const apiKey = env.FRED_API_KEY?.trim();
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  // Opcional. Sin él no hay segundo destino y el resumen se comporta como antes.
  const grupo = env.TELEGRAM_GROUP_CHAT_ID?.trim();
  const destino = (d: BriefDestination) => (d === "group" ? grupo : chat);
  const sql = databaseUrl ? neon(databaseUrl) : null;
  // El módulo de régimen lo implementa la sesión principal. Carga diferida:
  // una fuente ausente se declara como carencia y no rompe todo el resumen.
  let module: typeof import("./sources/regimen.ts") | undefined;
  return {
    events: (now) => {
      if (!sql) throw new Error("events_unavailable");
      return recentBriefEvents(sql, now);
    },
    agenda: (opts) => {
      if (!apiKey) throw new Error("agenda_unavailable");
      return fetchAgenda(apiKey, opts);
    },
    regimen: async (now) => {
      if (!apiKey) throw new Error("regimen_unavailable");
      module = await import("./sources/regimen.ts");
      return module.fetchRegimen(apiKey, { now });
    },
    formatRegimen: (regimen) => {
      if (!module) throw new Error("regimen_unavailable");
      return module.formatRegimen(regimen);
    },
    store: sql ? dailyBriefStore(sql) : undefined,
    canSend: (destination) => Boolean(token && destino(destination)),
    send: (body, destination) => sendBriefTelegram(token!, destino(destination)!, body),
  };
}

interface CliDependencies {
  deps: BriefDependencies;
  now: Date;
  env: BriefEnv;
  log: (message: string) => void;
  preview: (body: string, destination: BriefDestination) => Promise<void>;
}

/** Un estado que no exige mirar el job: entregado, ya entregado, o solo generado. */
function correcto(state: BriefRunState): boolean {
  return ["dry", "generated", "blocked", "sent"].includes(state);
}

/**
 * Inyectable: las pruebas no leen secretos, no tocan red ni escriben preview.
 *
 * El documento se genera **una vez** y se entrega a los destinos configurados.
 * Generarlo por destino costaría otra ronda de FRED y de Neon y podría producir
 * dos resúmenes distintos del mismo día.
 *
 * **Los dos destinos reciben el mismo cuerpo.** El grupo ve exactamente lo que
 * ve el chat privado, por decisión explícita de Alberto: el sistema revela qué
 * empresas sigue, no cuánto tiene en cada una. Aun así son dos filas y dos
 * estados, porque entregar en uno no dice nada de si se entregó en el otro.
 */
export async function runBriefCli(args: string[], io: CliDependencies): Promise<number> {
  try {
    const flags = parseBriefArgs(args, io.env);
    const documento = await generateBrief(io.deps, { now: io.now });
    if (flags.preview) await io.preview(documento.body, "private");

    const hayGrupo = io.deps.canSend?.("group") === true;
    let privado: BriefRunState = "dry";
    let grupo: BriefRunState | null = hayGrupo ? "dry" : null;
    if (!flags.dry) {
      privado = (await deliverBrief(io.deps, documento, { send: flags.send, destination: "private" })).state;
      // Un fallo del privado no cancela el grupo: son dos filas y dos estados.
      if (hayGrupo) {
        grupo = (await deliverBrief(io.deps, documento, { send: flags.send, destination: "group" })).state;
      }
    }

    const p = documento.payload;
    io.log(`Resumen: estado=${privado}; grupo=${grupo ?? "no configurado"}; ` +
      `eventos=${p.events.status === "ok" ? p.events.data.length : 0}; ` +
      `citas=${p.agenda.status === "ok" ? p.agenda.data.length : 0}; carencias=${p.gaps.length}.`);
    // Que el grupo no esté configurado nunca falla. Que esté y no se entregue, sí:
    // un bot expulsado del grupo tiene que verse en rojo, no callarse.
    return correcto(privado) && (grupo === null || correcto(grupo)) ? 0 : 1;
  } catch {
    // Nunca volcar objetos Error: pueden contener SQL, URL con claves o titulares.
    io.log("Resumen: error de configuración o ejecución; no se publica contenido.");
    return 1;
  }
}

async function main(): Promise<number> {
  loadDotEnv();
  parseBriefArgs(process.argv.slice(2), process.env); // Antes de construir clientes.
  return runBriefCli(process.argv.slice(2), {
    deps: briefDependencies(process.env), now: new Date(), env: process.env,
    log: (message) => console.log(message),
    // Un solo archivo: los dos destinos reciben el mismo cuerpo. Sirve para leer
    // lo que se va a publicar antes de que exista el grupo.
    preview: async (body, destination) => {
      const directory = fileURLToPath(new URL("../.cache/", import.meta.url));
      await mkdir(directory, { recursive: true });
      const nombre = destination === "group" ? "morning-brief-grupo.txt" : "morning-brief.txt";
      await writeFile(new URL(`../.cache/${nombre}`, import.meta.url), body, { encoding: "utf8", mode: 0o600 });
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Resumen: error de configuración o ejecución; no se publica contenido.");
    process.exitCode = 1;
  });
}
