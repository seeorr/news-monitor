/**
 * Gestión de la watchlist desde la terminal.
 *
 *   npm run watchlist                          lista lo que se vigila
 *   npm run watchlist -- add NVDA              añade un valor
 *   npm run watchlist -- add EUNL --simbolo EUNL.DE --umbral 2 --nombre "iShares Core MSCI World"
 *   npm run watchlist -- set NVDA --umbral 5   cambia lo de un valor que ya está
 *   npm run watchlist -- set SP500 --sin-documentos
 *   npm run watchlist -- rm NVDA               deja de vigilarlo
 *
 * `set` existe porque el dashboard podía cambiar el umbral y los interruptores y
 * la terminal no, y esa asimetría no tenía motivo. Y porque **editar no es
 * reañadir**: un `add` repetido obliga a mandar la fila entera para tocar un
 * solo campo, que es justo el camino por el que el umbral se perdía.
 *
 * Al añadir se resuelve el CIK contra la SEC si hay `SEC_USER_AGENT`. Guardarlo
 * ahorra descargar el mapa de tickers en cada ciclo, y deja claro de qué empresa
 * se habla: un ticker no identifica a nadie, el CIK sí.
 */
import { loadConfig, loadDotEnv } from "./config.ts";
import { actualizar, anadir, leerWatchlist, quitar } from "./db/watchlist.ts";
import { resolveTickers } from "./sources/sec-edgar.ts";

const log = (...a: unknown[]) => console.log(...a);

/**
 * Los tres lectores de argumentos reciben el `argv` en vez de mirar el global.
 *
 * Se exportan y se prueban porque son lo único del comando `set` que puede
 * fallar **en silencio**: un `interruptor` que devolviera `false` donde debe
 * devolver `null` apagaría la vigilancia de un valor al cambiarle el umbral, y
 * nadie lo notaría hasta echar de menos un aviso semanas después.
 */
export function opcion(nombre: string, argv: string[] = process.argv): string | null {
  const i = argv.indexOf(`--${nombre}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

export function bandera(nombre: string, argv: string[] = process.argv): boolean {
  return argv.includes(`--${nombre}`);
}

/**
 * Un interruptor con tres estados: encender, apagar o no tocarlo.
 *
 * `null` es "no se ha pedido nada", y es distinto de `false`. Sin esa
 * distinción, `set --umbral 5` apagaría de paso los dos interruptores.
 */
export function interruptor(nombre: string, argv: string[] = process.argv): boolean | null {
  const encender = bandera(`con-${nombre}`, argv);
  const apagar = bandera(`sin-${nombre}`, argv);
  if (encender && apagar) throw new Error(`--con-${nombre} y --sin-${nombre} a la vez no significa nada.`);
  if (encender) return true;
  if (apagar) return false;
  return null;
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

  if (comando === "set") {
    if (!valor) {
      log("✕ Falta el ticker: npm run watchlist -- set NVDA --umbral 5");
      return 1;
    }

    const umbralTexto = opcion("umbral");
    const umbral = umbralTexto === null ? null : Number(umbralTexto.replace(",", "."));
    if (umbral !== null && (!Number.isFinite(umbral) || umbral < 0.5 || umbral > 20)) {
      // El mismo rango que ofrece el dashboard: por debajo de 0,5 casi cualquier
      // sesión genera evento; por encima de 20, solo un desastre.
      log("✕ El umbral va de 0,5 % a 20 %.");
      return 1;
    }

    const vigilarFilings = interruptor("documentos");
    const vigilarPrecio = interruptor("precio");
    if (umbral === null && vigilarFilings === null && vigilarPrecio === null) {
      log("✕ No has pedido ningún cambio. Son: --umbral N, --con/--sin-documentos, --con/--sin-precio.");
      return 1;
    }

    const existe = await actualizar(config.databaseUrl, valor, {
      umbral,
      vigilarFilings,
      vigilarPrecio,
    });
    if (!existe) {
      log(`✕ ${valor.toUpperCase()} no está en la watchlist. Se añade con \`add\`.`);
      return 1;
    }

    const cambios = [
      umbral !== null ? `umbral ${umbral} %` : null,
      vigilarFilings !== null ? `documentos ${vigilarFilings ? "sí" : "no"}` : null,
      vigilarPrecio !== null ? `precio ${vigilarPrecio ? "sí" : "no"}` : null,
    ].filter(Boolean);
    log(`✓ ${valor.toUpperCase()}: ${cambios.join(" · ")}.`);
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

  log(`✕ No conozco el comando "${comando}". Son: list, add, set, rm.`);
  return 1;
}

// Solo se ejecuta cuando este archivo ES el programa. Sin esta guarda, importarlo
// desde un test lanzaria la CLI de verdad —contra la base de verdad— al cargarlo.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("✕ Error no controlado:", err);
      process.exit(1);
    });
}
