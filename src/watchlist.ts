/**
 * Gestión de la watchlist desde la terminal.
 *
 *   npm run watchlist                          lista lo que se vigila
 *   npm run watchlist -- add NVDA              añade un valor
 *   npm run watchlist -- add EUNL --simbolo EUNL.DE --umbral 2 --nombre "iShares Core MSCI World"
 *   npm run watchlist -- rm NVDA               deja de vigilarlo
 *
 * Al añadir se resuelve el CIK contra la SEC si hay `SEC_USER_AGENT`. Guardarlo
 * ahorra descargar el mapa de tickers en cada ciclo, y deja claro de qué empresa
 * se habla: un ticker no identifica a nadie, el CIK sí.
 */
import { loadConfig, loadDotEnv } from "./config.ts";
import { anadir, leerWatchlist, quitar } from "./db/watchlist.ts";
import { resolveTickers } from "./sources/sec-edgar.ts";

const log = (...a: unknown[]) => console.log(...a);

function opcion(nombre: string): string | null {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<number> {
  loadDotEnv();
  const config = loadConfig();

  if (!config.databaseUrl) {
    log("✕ Sin DATABASE_URL no hay watchlist que gestionar: vive en Neon.");
    log("  Panel de Neon → Connection string (pooled), y luego npm run db:migrate");
    return 1;
  }

  const [, , comando, valor] = process.argv;

  if (!comando || comando === "list") {
    const filas = await leerWatchlist(config.databaseUrl);
    if (filas.length === 0) {
      log("La watchlist está vacía. `npm run watchlist -- add NVDA` para empezar.");
      return 0;
    }
    log(`${filas.length} valor(es) vigilado(s):\n`);
    for (const v of filas) {
      const marcas = [v.vigilarFilings ? "documentos" : null, v.vigilarPrecio ? "precio" : null]
        .filter(Boolean)
        .join(" + ");
      log(
        `  ${v.ticker.padEnd(8)} ${(v.nombre ?? "").padEnd(32)} ${marcas}` +
          ` · umbral ${v.umbralMovimiento} %` +
          (v.quoteSymbol ? ` · Yahoo: ${v.quoteSymbol}` : "") +
          (v.cik ? ` · CIK ${v.cik}` : " · CIK sin resolver"),
      );
    }
    return 0;
  }

  if (comando === "add") {
    if (!valor) {
      log("✕ Falta el ticker: npm run watchlist -- add NVDA");
      return 1;
    }
    const ticker = valor.toUpperCase();
    let cik: string | null = null;
    let nombre = opcion("nombre");

    if (config.secUserAgent) {
      const { companies } = await resolveTickers([ticker], config.secUserAgent);
      const found = companies[0];
      if (found) {
        cik = found.cik;
        nombre = nombre ?? found.name;
      } else {
        // Un ETF europeo no está en EDGAR, y eso no es un error: se vigila su
        // precio igual, solo que no tendrá documentos que mirar.
        log(`· ${ticker} no aparece en el registro de la SEC. Se añade sin CIK.`);
      }
    } else {
      log("· Sin SEC_USER_AGENT no se puede resolver el CIK ahora. Se añade sin él.");
    }

    // Sin `--umbral` no se manda umbral, y no el 3 por defecto: un alta repetida
    // para rellenar el CIK no puede llevarse por delante el umbral que el valor
    // ya tuviera. El 3 lo pone la propia tabla cuando la fila es nueva.
    const umbralTexto = opcion("umbral");
    await anadir(config.databaseUrl, {
      ticker,
      nombre,
      cik,
      quoteSymbol: opcion("simbolo"),
      umbral: umbralTexto ? Number(umbralTexto) : undefined,
    });
    log(`✓ ${ticker} añadido${nombre ? ` (${nombre})` : ""}${cik ? `, CIK ${cik}` : ""}.`);
    return 0;
  }

  if (comando === "rm" || comando === "remove") {
    if (!valor) {
      log("✕ Falta el ticker: npm run watchlist -- rm NVDA");
      return 1;
    }
    const quitado = await quitar(config.databaseUrl, valor);
    log(quitado ? `✓ ${valor.toUpperCase()} fuera de la watchlist.` : `· ${valor.toUpperCase()} no estaba.`);
    return 0;
  }

  log(`✕ No conozco el comando "${comando}". Son: list, add, rm.`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("✕ Error no controlado:", err);
    process.exit(1);
  });
