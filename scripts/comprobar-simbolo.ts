/**
 * Comprueba un simbolo contra la SEC y contra Yahoo, sin escribir nada.
 *
 * Los simbolos llegan por argumento, nunca escritos en el archivo: este script
 * vive en un repositorio publico y la lista de lo que alguien vigila no puede
 * quedarse aqui.
 *
 *   npx tsx scripts/comprobar-simbolo.ts AAPL '^GSPC'
 */
import { loadDotEnv } from "../src/config.ts";
import { resolveTickers } from "../src/sources/sec-edgar.ts";
import { fetchCotizacion } from "../src/sources/mercado.ts";

loadDotEnv();
const contacto = process.env["SEC_USER_AGENT"] ?? "";
const simbolos = process.argv.slice(2);
if (simbolos.length === 0) {
  console.error("Uso: npx tsx scripts/comprobar-simbolo.ts TICKER [TICKER...]");
  process.exit(1);
}

for (const s of simbolos) {
  console.log(`\n── ${s} ──`);

  if (contacto) {
    try {
      const { companies, unknown } = await resolveTickers([s], contacto);
      const c = companies[0];
      if (c) console.log(`  SEC:   ${c.name ?? "(sin nombre)"} · CIK ${c.cik}`);
      else console.log(`  SEC:   no esta en EDGAR (${unknown.join(", ")})`);
    } catch (e: unknown) {
      console.log(`  SEC:   error — ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log("  SEC:   sin SEC_USER_AGENT, no se puede consultar");
  }

  try {
    const q = await fetchCotizacion(s);
    console.log(
      `  Yahoo: ${q.symbol} · ${q.price} ${q.currency ?? ""} · cierre anterior ${q.previousClose} · sesion ${q.sessionDate}`,
    );
  } catch (e: unknown) {
    console.log(`  Yahoo: NO — ${e instanceof Error ? e.message : String(e)}`);
  }
}
