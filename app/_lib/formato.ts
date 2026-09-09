/**
 * Cómo se escriben las cosas en pantalla.
 *
 * Los números van en español, con coma decimal, **igual que en la alerta**
 * (`es()` en `src/notify/telegram.ts`, que es de donde se importa y no una copia).
 * Que la misma cifra se lea distinta en el móvil y en el navegador sería un
 * fallo de coherencia gratuito.
 */
import { es, sorpresa } from "../../src/notify/telegram.ts";
import type { SurpriseBasis } from "../../src/schema/event.ts";
import type { FilaEvento } from "../../src/db/lectura.ts";

export { es };

/** Con signo delante, que es como se lee una variación. */
export function conSigno(n: number, decimales = 1): string {
  return (n > 0 ? "+" : "") + es(n, decimales);
}

/** Los cinco `kind` que existen. No hay un sexto, y no se inventa uno. */
export const KIND_LABEL: Record<string, string> = {
  macro_release: "Macro",
  news: "Noticia",
  filing: "Documento",
  market_move: "Movimiento",
  calendar: "Agenda",
};

/** Las fuentes del enum. `coingecko` está declarada y no implementada; se dice. */
export const SOURCE_LABEL: Record<string, string> = {
  fred: "FRED",
  rss: "Prensa",
  "sec-edgar": "SEC EDGAR",
  yahoo: "Yahoo",
  coingecko: "CoinGecko",
};

/**
 * El feed concreto, que es lo que `series_id` guarda cuando `kind` es `news`.
 * Los ids salen de `FEEDS` en `src/sources/rss.ts`.
 */
export const FEED_LABEL: Record<string, string> = {
  "fed-press": "Reserva Federal",
  "ecb-press": "BCE",
  "sec-press": "SEC",
  "cnbc-markets": "CNBC",
  "yahoo-finance": "Yahoo Finance",
};

export const SENTIMENT_LABEL: Record<string, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

/** Los cuatro tramos de la sección 3. El nombre importa: es lo que se lee. */
export type Tramo = "critico" | "importante" | "interesante" | "ruido";

export function tramo(nota: number): Tramo {
  if (nota >= 9) return "critico";
  if (nota >= 7) return "importante";
  if (nota >= 4) return "interesante";
  return "ruido";
}

export const TRAMO_LABEL: Record<Tramo, string> = {
  critico: "crítico",
  importante: "importante",
  interesante: "interesante",
  ruido: "ruido",
};

/**
 * "hace 3 h". Se calcula en el servidor y por eso se pasa el `ahora`: dos relojes
 * distintos —el del servidor al renderizar y el del navegador al hidratar—
 * pintarían textos distintos y React se quejaría con razón.
 */
export function haceCuanto(cuando: Date, ahora: Date): string {
  const minutos = Math.round((ahora.getTime() - cuando.getTime()) / 60_000);
  if (minutos < 1) return "ahora mismo";
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.round(horas / 24);
  if (dias < 30) return `hace ${dias} d`;
  return fechaCorta(cuando);
}

/** Fecha en UTC, que es la zona en la que trabaja todo el sistema. */
export function fechaCorta(cuando: Date): string {
  return cuando.toISOString().slice(0, 10);
}

export function fechaYHora(cuando: Date): string {
  return cuando.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * `observed_at` es texto de precisión mixta: `2026-08-01` para un dato macro y
 * un instante ISO para una noticia. Se enseña tal cual cuando es una fecha, y
 * con la hora en UTC cuando la trae. Convertirlo a un tipo fecha aquí sería
 * inventar una precisión que el dato no tiene.
 */
export function observado(observedAt: string): string {
  if (!observedAt.includes("T")) return observedAt;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return observedAt;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export interface Cifra {
  etiqueta: string;
  valor: string;
}

/**
 * La línea de cifras, con la misma regla que `formatAlert()`: **solo aparece lo
 * que existe**. Un bloque de "Actual: n/d · Anterior: n/d" delante de una
 * noticia no informa de nada, es un formulario vacío que invita a rellenarlo.
 *
 * Y la sorpresa declara siempre su base —"vs anterior", "vs media 3m"—, porque
 * un porcentaje de sorpresa sin base miente por omisión. Esa etiqueta no es
 * opcional en la UI.
 */
export function cifras(e: FilaEvento): Cifra[] {
  const unidad = e.unit ?? "";
  const salida: Cifra[] = [];
  if (e.actual !== null) salida.push({ etiqueta: "Actual", valor: `${es(e.actual)}${unidad}` });
  if (e.consensus !== null) {
    salida.push({ etiqueta: "Consenso", valor: `${es(e.consensus)}${unidad}` });
  } else if (e.previous !== null) {
    salida.push({ etiqueta: "Anterior", valor: `${es(e.previous)}${unidad}` });
  }
  if (e.surprise_value !== null && e.surprise_basis !== null) {
    // La escribe `sorpresa()`, la misma que la alerta de Telegram: la cifra no
    // puede leerse distinta en el movil y en la pantalla.
    salida.push({
      etiqueta: "Sorpresa",
      valor: sorpresa({
        value: e.surprise_value,
        basis: e.surprise_basis as SurpriseBasis,
        unit: e.unit ?? "",
      }),
    });
  }
  return salida;
}

/**
 * Los puntos de una lista del análisis profundo, listos para pintar.
 *
 * El modelo escribe cada punto como una frase y alguna vez suelta uno que es
 * solo un punto o solo espacios: pasó en la primera alerta real, y por eso
 * `formatAlert()` ya los filtra antes de unirlos. Aquí hace falta igual, porque
 * una viñeta vacía en una lista parece un dato que se ha perdido por el camino.
 *
 * El punto final **no** se quita, al revés que en la alerta: allí estorba porque
 * los puntos se unen con separadores dentro de una línea; en una lista con
 * viñetas cada uno es una frase suelta y se lee mejor con él.
 */
export function puntos(lista: string[]): string[] {
  return lista.map((p) => p.trim()).filter((p) => /[\p{L}\p{N}]/u.test(p));
}

/**
 * Si el `series_id` de este evento es de verdad un activo.
 *
 * Para `filing` y `market_move` lo es. Para `macro_release` es una serie de FRED
 * y para `news` es el id del feed: en esos dos casos **no es un activo** y no se
 * pinta como tal.
 */
export function esActivo(e: FilaEvento): boolean {
  return e.series_id !== null && (e.kind === "filing" || e.kind === "market_move");
}

/**
 * El consenso, dicho en voz alta.
 *
 * `events.consensus` es siempre null hoy: ninguna fuente gratuita publica
 * expectativas de analistas. Se enseña el motivo y no un guion mudo, que es la
 * diferencia entre un hueco declarado y un dato que parece faltar por descuido.
 */
export const SIN_CONSENSO = "ninguna fuente gratuita lo publica";
