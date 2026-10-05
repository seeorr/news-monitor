/**
 * Cierra las entregas inciertas con el veredicto de una persona.
 *
 *   npm run reconciliar                      lista lo que espera veredicto, no escribe
 *   npm run reconciliar -- --llego <id>      esa entrega SÍ apareció en el chat
 *   npm run reconciliar -- --no-llego <id>   esa entrega NO apareció
 *   npm run reconciliar -- --no-llego --todas  el mismo veredicto para todas
 *
 * Las banderas se pueden repetir para dar varios veredictos en una orden.
 *
 * **Solo lista por defecto.** Escribir sobre el ledger de entregas es afirmar
 * algo que nadie va a volver a comprobar, así que hay que pedirlo nombrando el
 * veredicto. Por qué esta reconciliación no puede ser automática está explicado
 * en `src/db/reconciliacion.ts`; aquí solo se recoge la respuesta.
 */
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { cliente } from "../src/db/lectura.ts";
import { listarSinConfirmar, reconciliar, type Veredicto } from "../src/db/reconciliacion.ts";
import { ZONA_POR_DEFECTO } from "../src/pipeline/horas-de-silencio.ts";

/** Todos los valores de una bandera repetible. */
function valores(nombre: string): string[] {
  const salida: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg !== `--${nombre}`) return;
    const siguiente = process.argv[i + 1];
    if (siguiente && !siguiente.startsWith("--")) salida.push(siguiente);
  });
  return salida;
}

function enZona(instante: string | null, zona: string): string {
  if (!instante) return "sin fecha";
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: zona, dateStyle: "medium", timeStyle: "short",
  }).format(new Date(instante));
}

function dias(instante: string | null): string {
  if (!instante) return "?";
  return String(Math.floor((Date.now() - Date.parse(instante)) / 86_400_000));
}

async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("Falta DATABASE_URL: las entregas viven en la base, no en archivos.");
    return 1;
  }
  const zona = process.env["NEWS_TIMEZONE"] ?? ZONA_POR_DEFECTO;
  const sql = cliente(config.databaseUrl);
  const pendientes = await listarSinConfirmar(sql);

  if (pendientes.length === 0) {
    console.log("Ninguna entrega espera veredicto. Nada que reconciliar.");
    return 0;
  }

  const todas = process.argv.includes("--todas");
  const ordenes: Array<{ eventId: string; veredicto: Veredicto }> = [];
  for (const veredicto of ["llego", "no-llego"] as Veredicto[]) {
    const ids = valores(veredicto);
    if (todas && process.argv.includes(`--${veredicto}`) && ids.length === 0) {
      for (const p of pendientes) ordenes.push({ eventId: p.eventId, veredicto });
    }
    for (const eventId of ids) ordenes.push({ eventId, veredicto });
  }

  // Sin veredicto, esto es una lista y nada más.
  if (ordenes.length === 0) {
    console.log(`${pendientes.length} entrega(s) esperan veredicto.\n`);
    console.log("Mira en tu Telegram la hora que indica cada una y di si el mensaje está:\n");
    for (const p of pendientes) {
      console.log(`  ${p.eventId}`);
      console.log(`    titular:  ${p.title ?? "(el evento ya no está en events)"}`);
      console.log(`    intentado: ${enZona(p.claimedAt, zona)}  (hace ${dias(p.claimedAt)} días)`);
      console.log(`    estado:    ${p.state}   intentos: ${p.attempts}`);
      if (p.state === "sending") {
        console.log("    OJO: en 'sending' puede ser un envío en vuelo. Esta herramienta no lo toca.");
      }
      console.log("");
    }
    console.log("Si aparece en el chat:   npm run reconciliar -- --llego <id>");
    console.log("Si no aparece:           npm run reconciliar -- --no-llego <id>");
    console.log("El mismo para todas:     npm run reconciliar -- --no-llego --todas");
    return 0;
  }

  let escritas = 0, ignoradas = 0;
  for (const orden of ordenes) {
    const hecho = await reconciliar(sql, orden.eventId, orden.veredicto);
    if (hecho) escritas++;
    else ignoradas++;
    console.log(hecho
      ? `✓ ${orden.eventId} → ${orden.veredicto === "llego" ? "sent" : "undeliverable"}`
      : `· ${orden.eventId}: sin cambios (no estaba en 'uncertain')`);
  }
  console.log(`\n${escritas} reconciliada(s), ${ignoradas} sin cambios.`);
  if (escritas > 0) {
    console.log("Comprueba que la salud ya no dice 'delivery_uncertain': npm run audit:health");
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  // El error original puede traer la cadena de conexión dentro.
  console.error(`RECONCILIACION_FALLIDA: ${error instanceof Error ? error.message : "error desconocido"}`);
  process.exitCode = 1;
});
