/**
 * La agenda macro de la semana, una vez al día.
 *
 * Va aparte del ciclo del monitor a propósito. El monitor es reactivo —llega
 * algo, se juzga— y corre cada quince minutos; esto es una lista de fechas que
 * cambia una vez al día y no necesita ni modelo ni cascada. Mezclarlos habría
 * significado meter una condición en el bucle del ciclo para el único caso que
 * no es un evento.
 *
 *   npm run agenda            envía la agenda del día
 *   npm run agenda -- --dry   la compone y la enseña, sin enviar
 *   npm run agenda -- --force la manda aunque ya se enviara hoy
 */
import { loadConfig, loadDotEnv } from "./config.ts";
import { neonSeenStore } from "./db/neon.ts";
import { fileSeenStore, type SeenStore } from "./pipeline/seen.ts";
import { agendaEvent, fetchAgenda, formatAgenda } from "./sources/calendario.ts";
import { sendTelegram } from "./notify/telegram.ts";

const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");

  loadDotEnv();
  const config = loadConfig();

  if (!config.fredApiKey) {
    log("✕ Sin FRED_API_KEY no hay calendario: es de donde salen las fechas.");
    return 1;
  }

  const desde = new Date().toISOString().slice(0, 10);
  const dias = config.agendaDias;

  const seen: SeenStore = config.databaseUrl
    ? neonSeenStore(config.databaseUrl)
    : fileSeenStore(config.stateDir);

  const citas = await fetchAgenda(config.fredApiKey, { desde, dias });
  const event = agendaEvent(citas, { desde, dias, retrievedAt: new Date().toISOString() });

  // Una agenda al día. El workflow puede repetirse por un reintento de GitHub y
  // recibir la misma lista dos veces por la mañana es ruido, no información.
  if (!force && (await seen.has(event.id))) {
    log(`· La agenda del ${desde} ya se envió. Nada que hacer.`);
    return 0;
  }

  const texto = formatAgenda(citas, { desde, dias });
  log("\n" + texto + "\n");

  if (dry) {
    log("--dry: no se envía ni se registra.");
    return 0;
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    log("· Sin credenciales de Telegram: agenda compuesta pero no enviada.");
    return 1;
  }

  const sent = await sendTelegram(config.telegramBotToken, config.telegramChatId, texto);
  if (!sent.ok) {
    log(`✕ Telegram rechazó el mensaje: ${sent.description ?? "sin detalle"}`);
    return 1; // Sin registrar: mañana se reintenta.
  }

  // La agenda no pasa por la cascada —no hay nada que interpretar en una lista de
  // fechas—, así que su frase la escribe este código y es descriptiva: cuántas
  // citas hay y en qué ventana. No es un resumen de modelo y no finge serlo.
  await seen.saveAlert(event, {
    importance: citas.length > 0 ? 5 : 1,
    impact: 5,
    sentiment: "neutral",
    oneLiner: `Agenda macro: ${citas.length} cita(s) en los proximos ${dias} dias.`,
    deep: false,
    body: texto,
  });
  log(`✓ Agenda enviada y registrada (${citas.length} cita(s)).`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("✕ Error no controlado:", err);
    process.exit(1);
  });
