/**
 * La agenda macro de la semana, una vez al día.
 *
 * Va aparte del ciclo del monitor a propósito. El monitor es reactivo —llega
 * algo, se juzga— y corre cada media hora; esto es una lista de fechas que
 * cambia una vez al día y no necesita ni modelo ni cascada. Mezclarlos habría
 * significado meter una condición en el bucle del ciclo para el único caso que
 * no es un evento.
 *
 *   npm run agenda            envía la agenda del día
 *   npm run agenda -- --dry   la compone y la enseña, sin enviar
 *   npm run agenda -- --force la manda aunque ya se enviara hoy
 *
 * **Reclama antes de enviar**, igual que la alerta y el resumen. Antes mandaba y
 * registraba después, así que morir en los quince segundos de red de Telegram
 * dejaba el registro vacío y el reintento de GitHub volvía a mandar la misma
 * lista. Una agenda repetida molesta menos que una alerta repetida, pero el
 * defecto era el mismo y el arreglo ya estaba escrito al lado.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig, loadDotEnv, type Config } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { fileSeenStore, type EstadoEntrega, type SeenStore } from "./pipeline/seen.ts";
import { agendaEvent, fetchAgenda, formatAgenda, type Cita } from "./sources/calendario.ts";
import { sendTelegram } from "./notify/telegram.ts";

export interface AgendaFlags { dry: boolean; force: boolean }

export function parseAgendaArgs(args: string[]): AgendaFlags {
  if (args.some((arg) => !["--dry", "--force"].includes(arg))) throw new Error("invalid_flags");
  return { dry: args.includes("--dry"), force: args.includes("--force") };
}

/** Inyectable: las pruebas no leen secretos, no tocan red y no escriben nada. */
export interface AgendaDependencies {
  dias: number;
  /** Ausente = sin `FRED_API_KEY`, que es de donde salen las fechas. */
  citas?: (opts: { desde: string; dias: number }) => Promise<Cita[]>;
  seen: SeenStore;
  /** Ausente = sin credenciales de Telegram: se compone y no se manda. */
  send?: (body: string) => Promise<EstadoEntrega>;
  now: Date;
  token: () => string;
  log: (line: string) => void;
}

export async function runAgendaCli(args: string[], deps: AgendaDependencies): Promise<number> {
  const flags = parseAgendaArgs(args);

  if (!deps.citas) {
    deps.log("✕ Sin FRED_API_KEY no hay calendario: es de donde salen las fechas.");
    return 1;
  }

  const desde = deps.now.toISOString().slice(0, 10);
  const dias = deps.dias;
  const citas = await deps.citas({ desde, dias });
  const event = agendaEvent(citas, { desde, dias, retrievedAt: deps.now.toISOString() });
  const texto = formatAgenda(citas, { desde, dias });
  deps.log("\n" + texto + "\n");

  if (flags.dry) {
    // Ni reclama, ni marca, ni envía. Un `--dry` que reclamara dejaría la entrega
    // del día en vuelo y la ejecución de verdad se encontraría la puerta cerrada.
    deps.log("--dry: no se reclama, no se envía y no se registra.");
    return 0;
  }
  if (!deps.send) {
    deps.log("· Sin credenciales de Telegram: agenda compuesta pero no enviada.");
    return 1;
  }

  // Una agenda al día. El workflow puede repetirse por un reintento de GitHub y
  // recibir la misma lista dos veces por la mañana es ruido, no información.
  if (!flags.force && (await deps.seen.has(event.id))) {
    deps.log(`· La agenda del ${desde} ya se envió. Nada que hacer.`);
    return 0;
  }

  const token = deps.token();
  const reclamada = await deps.seen.claimAlert(event.id, { token, force: flags.force });
  if (!reclamada) {
    // La entrega de hoy tiene dueño, o se cerró sin entregarse. Ninguna de las
    // dos se reintenta sola: un `uncertain` quiere decir que pudo llegar.
    deps.log(`✕ La entrega de la agenda del ${desde} ya tiene dueño o quedó sin cerrar. ` +
      "No se reenvía sola: eso lo decide --force, que es una persona.");
    return 1;
  }

  let estado: EstadoEntrega;
  try {
    estado = await deps.send(texto);
  } catch {
    // Timeout, DNS, socket cortado. Pudo llegar: no se sabe y no se finge saber.
    estado = "uncertain";
  }

  try {
    // La agenda no pasa por la cascada —no hay nada que interpretar en una lista
    // de fechas—, así que su frase la escribe este código y es descriptiva:
    // cuántas citas hay y en qué ventana. No es un resumen de modelo y no finge
    // serlo. Se escribe solo si Telegram la aceptó, porque `alerts` significa lo
    // que de verdad salió.
    if (estado === "sent") {
      await deps.seen.saveAlert(event, {
        importance: citas.length > 0 ? 5 : 1,
        impact: 5,
        sentiment: "neutral",
        oneLiner: `Agenda macro: ${citas.length} cita(s) en los proximos ${dias} dias.`,
        deep: false,
        // Por lo mismo: no hay paso 4 que analice una lista de fechas. Se declara
        // el hueco en vez de dejar el campo fuera y que parezca un olvido.
        analysis: null,
        body: texto,
      });
    }
    await deps.seen.finishAlert(event.id, token, estado);
  } catch {
    // Se perdió el acuse de Neon. La entrega se queda en `sending` y nadie la
    // libera: preferible una agenda sin cerrar a una agenda repetida.
    deps.log("✕ La agenda no se pudo registrar. La entrega queda sin cerrar, a propósito.");
    return 1;
  }

  if (estado !== "sent") {
    // Sin la descripción que devuelve Telegram: los registros de Actions de un
    // repositorio público los lee cualquiera, y el estado ya dice lo que hay.
    deps.log(`✕ La agenda no se entregó (${estado}). No se reintenta sola.`);
    return 1;
  }
  deps.log(`✓ Agenda enviada y registrada (${citas.length} cita(s)).`);
  return 0;
}

export function agendaDependencies(config: Config, now: Date): AgendaDependencies {
  const seen: SeenStore = config.databaseUrl
    ? neonSeenStore(config.databaseUrl)
    : fileSeenStore(config.stateDir);
  const token = config.telegramBotToken;
  const chat = config.telegramChatId;
  return {
    dias: config.agendaDias,
    citas: config.fredApiKey ? (opts) => fetchAgenda(config.fredApiKey!, opts) : undefined,
    seen,
    send: token && chat ? async (body) => (await sendTelegram(token, chat, body)).state : undefined,
    now,
    token: () => randomUUID(),
    log: (line) => console.log(line),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  parseAgendaArgs(args); // Antes de leer configuración o construir clientes.
  loadDotEnv();
  const config = loadConfig();
  return runAgendaCli(args, agendaDependencies(config, new Date()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      // Nunca volcar el objeto Error: puede traer SQL, una URL con clave dentro
      // o el cuerpo de una respuesta.
      console.error("✕ Agenda: error de configuración o ejecución; no se publica contenido.");
      process.exitCode = 1;
    });
}
