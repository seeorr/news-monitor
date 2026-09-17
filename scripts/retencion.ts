/**
 * Retención de la base: poda lo que ya no se lee, sin borrar ninguna noticia.
 *
 *   npm run retencion                    simulacro a 30 días, no escribe nada
 *   npm run retencion -- --dias 60       simulacro con otro corte
 *   npm run retencion -- --aplicar       poda de verdad
 *
 * **Seco por defecto y a propósito.** Es una escritura sobre producción que
 * nadie va a revisar después, así que la única forma de ejecutarla es pedirlo
 * explícitamente. Lo que hace y lo que conserva está explicado en
 * `src/db/retencion.ts`; aquí solo se decide cuándo y con qué corte.
 */
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { cliente } from "../src/db/lectura.ts";
import { podar, simularPoda } from "../src/db/retencion.ts";

function numero(nombre: string, porDefecto: number): number {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i < 0) return porDefecto;
  const valor = Number(process.argv[i + 1]);
  if (!Number.isFinite(valor) || valor < 7 || valor > 365) {
    throw new Error(`--${nombre} va de 7 a 365 días. Por debajo de 7 se podaría lo que la agrupación sigue leyendo.`);
  }
  return valor;
}

async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("Falta DATABASE_URL: la retención actúa sobre la base, no sobre archivos.");
    return 1;
  }
  const aplicar = process.argv.includes("--aplicar");
  const dias = numero("dias", 30);
  const ahora = new Date().toISOString();
  const corte = new Date(Date.parse(ahora) - dias * 86_400_000).toISOString();
  const sql = cliente(config.databaseUrl);

  const resultado = aplicar ? await podar(sql, corte, ahora) : await simularPoda(sql, corte);
  console.log(JSON.stringify({
    modo: aplicar ? "aplicado" : "simulacro",
    corte,
    dias,
    ...resultado,
    megasLiberados: Math.round(resultado.bytesLiberados / 1024 / 102.4) / 10,
    nota: aplicar
      ? "Ninguna fila borrada de capture_queue: solo se ha podado el cuerpo del snapshot."
      : "Nada escrito. Añade --aplicar para ejecutarlo.",
  }, null, 2));
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  // El error original puede traer la cadena de conexión dentro.
  console.error(`RETENCION_FALLIDA: ${error instanceof Error ? error.message : "error desconocido"}`);
  process.exitCode = 1;
});
