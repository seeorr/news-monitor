import { loadConfig, loadDotEnv } from "./config.ts";
import { cliente } from "./db/lectura.ts";
import { guardarRegimen } from "./db/regimen.ts";
import { fetchRegimen, formatRegimen, SERIES_REGIMEN } from "./sources/regimen.ts";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const dry = process.argv.includes("--dry");
  const preview = process.argv.includes("--preview");
  const invalid = process.argv.slice(2).some(arg => !["--dry", "--preview"].includes(arg));
  const problema = invalid ? "Opciones permitidas: --dry y --preview."
    : preview && (!dry || process.env["GITHUB_ACTIONS"] !== undefined) ? "--preview requiere --dry y sólo está disponible en local."
    : !config.fredApiKey ? "Falta FRED_API_KEY para consultar las señales."
    : !dry && !config.databaseUrl ? "Falta DATABASE_URL para guardar el régimen; usa --dry para comprobar sin escribir."
    : null;
  if (problema) { console.error(problema); process.exitCode = 1; return; }
  const regimen = await fetchRegimen(config.fredApiKey!);
  console.log(`Régimen calculado: ${regimen.state}. Señales disponibles: ${regimen.signals.filter(s => s.value !== null).length}/${SERIES_REGIMEN.length}.`);
  if (preview) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/regimen.txt", formatRegimen(regimen), "utf8");
    console.log("Vista local: .cache/regimen.txt");
  }
  if (!dry) await guardarRegimen(cliente(config.databaseUrl!), regimen);
  if (regimen.state === "insufficient_data") process.exitCode = 1;
}
main().catch(() => {
  // El error original de HTTP/SQL puede contener secretos. Las variables
  // requeridas y el modo seco están documentados en README.
  console.error("No se pudo completar el régimen. Comprueba FRED_API_KEY, DATABASE_URL, migraciones y conectividad.");
  process.exitCode = 1;
});
