"use server";

/**
 * Las escrituras de la app. Son las únicas que hay.
 *
 * Todas reutilizan `src/db/watchlist.ts`: `anadir()`, `quitar()` y `actualizar()`
 * ya tienen escrita y probada la lógica del `on conflict` y de la
 * normalización. Duplicar ese SQL aquí sería garantizar que las dos versiones se
 * separen, y ya hubo un fallo silencioso viviendo justo ahí.
 *
 * **Ninguna consulta a la watchlist sale del servidor.** Estas funciones son
 * acciones de servidor: el navegador manda el formulario, no la consulta.
 */
import { revalidatePath } from "next/cache";
import { actualizar, anadir, quitar } from "../../src/db/watchlist.ts";
import { resolveTickers } from "../../src/sources/sec-edgar.ts";
import { fetchCotizacion } from "../../src/sources/mercado.ts";
import { urlBaseDeDatos } from "../_lib/servidor.ts";
import type { Estado } from "./estado.ts";

// `Estado` y `ESTADO_INICIAL` viven en `estado.ts`: este modulo lleva
// `"use server"` y ahi **solo se pueden exportar funciones asincronas**. Un
// objeto constante exportado desde aqui llega al cliente como `undefined`.

export async function anadirTicker(_previo: Estado, datos: FormData): Promise<Estado> {
  const url = urlBaseDeDatos();
  if (!url) return fallo("Falta DATABASE_URL: sin base de datos no hay watchlist que gestionar.");

  const ticker = String(datos.get("ticker") ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    return fallo("Un ticker son letras, cifras, puntos o guiones. Nada más.", ticker);
  }

  const simbolo = String(datos.get("simbolo") ?? "").trim().toUpperCase() || null;
  const umbralTexto = String(datos.get("umbral") ?? "").trim().replace(",", ".");
  const umbral = umbralTexto === "" ? undefined : Number(umbralTexto);
  if (umbral !== undefined && (!Number.isFinite(umbral) || umbral < 0.5 || umbral > 20)) {
    return fallo("El umbral va de 0,5 % a 20 %. Por debajo casi toda sesión es evento; por encima, solo un desastre.", ticker);
  }

  const avisos: string[] = [];

  // 1. ¿Está en EDGAR? Si no, no se bloquea el alta: un ETF europeo no está en
  //    EDGAR y se vigila igual por precio, solo que nunca tendrá documentos.
  const contacto = process.env["SEC_USER_AGENT"] ?? null;
  let cik: string | null = null;
  let nombre = String(datos.get("nombre") ?? "").trim() || null;

  if (contacto) {
    try {
      const { companies } = await resolveTickers([ticker], contacto);
      const encontrada = companies[0];
      if (encontrada) {
        cik = encontrada.cik;
        nombre = nombre ?? encontrada.name;
      } else {
        avisos.push(
          "No está en EDGAR: se vigilará su precio, no sus documentos. Es lo normal en un valor no estadounidense.",
        );
      }
    } catch {
      avisos.push("La SEC no ha respondido: se añade sin CIK y se puede completar reañadiéndolo.");
    }
  } else {
    avisos.push("Sin SEC_USER_AGENT no se puede resolver el CIK: se añade sin él y no tendrá documentos.");
  }

  // 2. ¿Cotiza en Yahoo? Es la comprobación que de verdad caza un ticker mal
  //    escrito. No bloquea tampoco: Yahoo no es oficial y se cae sin avisar, y
  //    un fallo suyo no puede impedir gestionar la propia lista.
  const paraCotizar = simbolo ?? ticker;
  try {
    const cotizacion = await fetchCotizacion(paraCotizar);
    avisos.push(
      `Cotiza en Yahoo como ${cotizacion.symbol}${cotizacion.currency ? ` en ${cotizacion.currency}` : ""}.`,
    );
  } catch {
    if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(paraCotizar)) {
      avisos.push(
        "Eso parece un ISIN, y un ISIN no es un símbolo: busca el de Yahoo, del estilo GLOBX.DE, y ponlo en «símbolo de Yahoo».",
      );
    } else {
      avisos.push(
        `Yahoo no ha devuelto nada para ${paraCotizar}: o el símbolo no es ese, o Yahoo está caído. Se añade igual, pero así no generará eventos de precio.`,
      );
    }
  }

  // 3. Un aviso que no es de validación pero evita ruido: el ticker entra también
  //    en el filtro por reglas, que busca la palabra completa en los titulares.
  if (ticker.length <= 3) {
    avisos.push(
      "Es un ticker de tres letras o menos: si además es una palabra corriente en inglés, hará pasar el filtro a media prensa del día.",
    );
  }

  try {
    await anadir(url, { ticker, nombre, cik, quoteSymbol: simbolo, ...(umbral !== undefined ? { umbral } : {}) });
  } catch (error: unknown) {
    // El mensaje real, no un "algo ha fallado". Sin volcar la lista: un error que
    // enumera los tickers acaba en un log, y los logs se comparten.
    return fallo(error instanceof Error ? error.message : String(error), ticker);
  }

  revalidatePath("/watchlist");
  revalidatePath("/");
  return {
    tipo: "ok",
    // Lo único que hace falta saber para no quedarse mirando la pantalla.
    mensaje: `${ticker} entra en el próximo ciclo, que corre como mucho dentro de 15 minutos.`,
    avisos,
  };
}

export async function quitarTicker(_previo: Estado, datos: FormData): Promise<Estado> {
  const url = urlBaseDeDatos();
  if (!url) return fallo("Falta DATABASE_URL.");

  const ticker = String(datos.get("ticker") ?? "").trim().toUpperCase();
  try {
    const borrado = await quitar(url, ticker);
    revalidatePath("/watchlist");
    revalidatePath("/");
    if (!borrado) return fallo(`${ticker} no estaba en la lista.`);
    return {
      tipo: "ok",
      mensaje: `${ticker} fuera. Deja de vigilarse su precio y sus documentos.`,
      avisos: [
        "Los eventos y las alertas ya registrados se quedan: quitar de la watchlist no borra historial.",
        "Si la tabla se queda vacía, el ciclo cae al respaldo de las variables WATCHLIST y SEC_WATCHLIST. Vaciarla no es lo mismo que no vigilar nada.",
      ],
    };
  } catch (error: unknown) {
    return fallo(error instanceof Error ? error.message : String(error));
  }
}

export async function cambiarUmbral(_previo: Estado, datos: FormData): Promise<Estado> {
  const url = urlBaseDeDatos();
  if (!url) return fallo("Falta DATABASE_URL.");

  const ticker = String(datos.get("ticker") ?? "").trim().toUpperCase();
  const umbral = Number(String(datos.get("umbral") ?? "").replace(",", "."));
  if (!Number.isFinite(umbral) || umbral < 0.5 || umbral > 20) {
    return fallo("El umbral va de 0,5 % a 20 %.");
  }

  try {
    const existe = await actualizar(url, ticker, { umbral });
    revalidatePath("/watchlist");
    revalidatePath("/");
    return existe
      ? { tipo: "ok", mensaje: `${ticker}: umbral en ${String(umbral).replace(".", ",")} %.`, avisos: [] }
      : fallo(`${ticker} no está en la lista.`);
  } catch (error: unknown) {
    return fallo(error instanceof Error ? error.message : String(error));
  }
}

export async function cambiarVigilancia(_previo: Estado, datos: FormData): Promise<Estado> {
  const url = urlBaseDeDatos();
  if (!url) return fallo("Falta DATABASE_URL.");

  const ticker = String(datos.get("ticker") ?? "").trim().toUpperCase();
  const campo = String(datos.get("campo") ?? "");
  const valor = String(datos.get("valor") ?? "") === "1";
  if (campo !== "filings" && campo !== "precio") return fallo("Campo desconocido.");

  try {
    await actualizar(
      url,
      ticker,
      campo === "filings" ? { vigilarFilings: valor } : { vigilarPrecio: valor },
    );
    revalidatePath("/watchlist");
    revalidatePath("/");
    const que = campo === "filings" ? "sus documentos" : "su precio";
    return {
      tipo: "ok",
      mensaje: `${ticker}: ${valor ? "se vigilan" : "se dejan de vigilar"} ${que}.`,
      avisos: [],
    };
  } catch (error: unknown) {
    return fallo(error instanceof Error ? error.message : String(error));
  }
}

function fallo(mensaje: string, ticker?: string): Estado {
  return { tipo: "error", mensaje, avisos: [], ...(ticker !== undefined ? { ticker } : {}) };
}
