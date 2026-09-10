/**
 * Eurostat — la macro de la zona euro que FRED no tiene.
 *
 * API pública, sin clave, sin tarjeta y sin cuota declarada: encaja en los 0 €/mes
 * permanentes sin asteriscos. Se usa porque **el paro europeo no existe en FRED**:
 * las series armonizadas de la OCDE se discontinuaron en enero de 2023 y nadie
 * las sustituyó. El IPC de la zona euro y el tipo del BCE sí están en FRED y por
 * ahí entran (`SERIES` en `fred.ts`); aquí entra lo que allí no está.
 *
 * Devuelve **JSON-stat**: un array plano de valores más un diccionario de
 * dimensiones. Con todas las dimensiones filtradas a un valor salvo el tiempo,
 * el índice plano coincide con el índice del tiempo. Eso no se asume: se
 * comprueba en `parseSerie()`, porque si una dimensión se queda sin filtrar deja
 * de ser cierto y los valores se leerían corridos.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LA TRAMPA DEL AGREGADO, que es la parte importante de este archivo
 * ────────────────────────────────────────────────────────────────────────────
 *
 * La zona euro pasó a 21 miembros en 2026, así que hoy el agregado es `EA21`.
 * Pedir `EA20` devuelve **HTTP 200 y cero filas**: la dimensión `geo` viene con
 * tamaño 0 y el resto de la respuesta parece perfecta. No hay error, no hay
 * excepción, no hay nada en el log. Comprobado contra la API el 9 de septiembre
 * de 2026: `une_rt_m` con `geo=EA20` y con `geo=EA22` responden lo mismo, 200 y
 * `"size": [...,0,...]`.
 *
 * Es el modo de fallo del `TSMC` de la watchlist —una consulta que no vigila
 * nada y no se queja— pero peor, porque llega solo con el tiempo: el código que
 * hoy funciona empezaría a devolver vacío el día que entre el país 22, sin haber
 * desplegado nada.
 *
 * Y no se arregla fijando `EA21` en todas partes, porque cada dataset admite
 * agregados distintos. Comprobado el mismo día: `une_rt_m` solo tiene `EA21`;
 * `namq_10_gdp` tiene `EA`, `EA21`, `EA20`, `EA19` y `EA12`; `prc_hicp_manr`
 * tiene `EA`, `EA20` y `EA19` y **no** tiene `EA21`. Una constante global
 * estaría mal en una de cada tres consultas desde el primer día.
 *
 * Por eso el agregado **se resuelve por dataset y en cada vuelta**, preguntando
 * al propio dataset qué códigos `geo` tiene (`descubrirGeos()`) y quedándose con
 * el agregado de zona euro más amplio de los que ofrece (`agregadoZonaEuro()`:
 * `EA<n>` con la `n` más alta, y `EA` a secas por debajo de todos). El día que
 * exista `EA22` lo devolverá el propio dataset y la regla lo elegirá sola, sin
 * tocar una línea; el día que un dataset deje de publicar agregado, no habrá
 * ninguno que elegir y la fuente fallará en voz alta en vez de callarse.
 *
 * Y el vacío es un fallo, no un resultado: cero valores donde debería haber una
 * serie lanza `EurostatError`, la tarea se anota como `SOURCE_FAILED` con
 * `source: "eurostat"` y su código, y el ciclo sigue con las demás fuentes.
 * Igual que una fuente caída, que es exactamente lo que es.
 */
import { fetchJson } from "../lib/http.ts";
import { computeSurprises, eventId, round, type NormalizedEvent } from "../schema/event.ts";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

/**
 * Los fallos de esta fuente, con vocabulario cerrado.
 *
 * El código va en `code` como propiedad propia porque es lo que el logger sabe
 * leer sin serializar nada (`src/lib/log.ts`), y está en su lista blanca: así el
 * log distingue "Eurostat no responde" de "Eurostat responde y no trae nada",
 * que es justo la diferencia que este archivo existe para no perder.
 */
export type EurostatCode =
  | "EUROSTAT_EMPTY"
  | "EUROSTAT_DIMENSION"
  | "EUROSTAT_NO_AGGREGATE"
  | "EUROSTAT_SHAPE";

export class EurostatError extends Error {
  readonly code: EurostatCode;
  constructor(code: EurostatCode, detalle: string) {
    super(`${code}: ${detalle}`);
    this.name = "EurostatError";
    this.code = code;
  }
}

export interface DatasetSpec {
  /** Código del dataset en Eurostat. Es también el `series_id` del evento. */
  id: string;
  title: string;
  country: string;
  unit: string;
  /**
   * Filtros de todas las dimensiones **salvo** `geo` y `time`. Cada una tiene
   * que quedar en exactamente un valor: es lo que hace que el índice plano de
   * `value` coincida con el del tiempo, y `parseSerie()` lo verifica.
   */
  filtros: Record<string, string>;
  /** Cuántos periodos se piden. Hacen falta 4 para el anterior y la media de 3. */
  periodos: number;
  /**
   * A partir de cuántos días desde el inicio del periodo del último dato la
   * serie se marca `stale`.
   *
   * Se declara por dataset porque una mensual y una trimestral no envejecen
   * igual, y porque el agregado de la zona euro va por detrás de los países
   * sueltos: la producción industrial de EA21 llega un mes más tarde que la
   * alemana. Cada umbral es el hueco normal máximo de esa serie —el que se
   * alcanza justo antes de la publicación siguiente— más un mes de margen, así
   * que `stale` significa "esta serie ha dejado de actualizarse" y no "hoy toca
   * esperar al dato del mes que viene". Los huecos normales están medidos
   * contra la API el 9 de septiembre de 2026 y anotados en cada fila.
   *
   * No es un filtro: el dato se ingiere igual y la alerta dice que es el último
   * válido conocido, que es la verdad.
   */
  frescuraDias: number;
}

/**
 * Registro de datasets. Añadir una serie europea es añadir una fila: ni el
 * pipeline ni el formateador se enteran.
 *
 * Los cuatro están comprobados contra la API el 9 de septiembre de 2026. Los
 * tres últimos **ya vienen en variación porcentual** (`PCH_PRE`, `CLV_PCH_PRE`):
 * no se les aplica ninguna transformación encima, que sería calcular la
 * variación de una variación.
 */
export const DATASETS: Record<string, DatasetSpec> = {
  une_rt_m: {
    id: "une_rt_m",
    title: "Paro de la zona euro",
    country: "🇪🇺",
    unit: "%",
    filtros: { s_adj: "SA", age: "TOTAL", sex: "T", unit: "PC_ACT" },
    periodos: 8,
    // Hueco normal máximo ~92 días: el dato de un mes se publica a principios
    // del subsiguiente.
    frescuraDias: 110,
  },

  namq_10_gdp: {
    id: "namq_10_gdp",
    title: "PIB de la zona euro (variación trimestral)",
    country: "🇪🇺",
    unit: "%",
    filtros: { s_adj: "SCA", unit: "CLV_PCH_PRE", na_item: "B1GQ" },
    periodos: 8,
    // Trimestral: el hueco normal máximo ronda los 212 días.
    frescuraDias: 260,
  },

  sts_inpr_m: {
    id: "sts_inpr_m",
    title: "Producción industrial de la zona euro (variación mensual)",
    country: "🇪🇺",
    unit: "%",
    filtros: { s_adj: "SCA", unit: "PCH_PRE", nace_r2: "B-D" },
    periodos: 8,
    // El agregado va un mes por detrás de los países: hueco normal ~105 días.
    frescuraDias: 130,
  },

  /**
   * Ventas minoristas.
   *
   * `indic_bt=VOL_SLS` (volumen de ventas) y no `TOVT`: **`TOVT` no existe en
   * este dataset**. Pedirlo devuelve 200 con `indic_bt` de tamaño 0 y cero
   * valores —el mismo fallo silencioso que el agregado—, y lo cazó la propia
   * comprobación de dimensiones de `parseSerie()` al integrarlo. Los códigos que
   * el dataset sí tiene con `unit=PCH_PRE` y `nace_r2=G47` son dos, y los da la
   * propia API al no filtrar esa dimensión: `VOL_SLS` y `NETTUR`. El volumen de
   * ventas es el que se publica como "ventas minoristas de la zona euro".
   */
  sts_trtu_m: {
    id: "sts_trtu_m",
    title: "Ventas minoristas de la zona euro (variación mensual)",
    country: "🇪🇺",
    unit: "%",
    filtros: { s_adj: "SCA", unit: "PCH_PRE", nace_r2: "G47", indic_bt: "VOL_SLS" },
    periodos: 8,
    frescuraDias: 130,
  },
};

/** La forma de JSON-stat que aquí se usa. Lo demás de la respuesta se ignora. */
interface JsonStat {
  id?: string[];
  size?: number[];
  dimension?: Record<string, { category?: { index?: Record<string, number> | string[] } }>;
  value?: Record<string, number | null> | Array<number | null>;
}

export interface Observacion {
  /** Periodo tal y como lo da Eurostat: `2026-07`, `2026-Q2`. */
  periodo: string;
  /** El mismo periodo como fecha, con la convención de FRED. */
  date: string;
  value: number;
}

function url(spec: DatasetSpec, extra: Record<string, string>, geos: string[] = []): string {
  const p = new URLSearchParams({ format: "JSON", ...spec.filtros, ...extra });
  for (const geo of geos) p.append("geo", geo);
  return `${BASE}/${encodeURIComponent(spec.id)}?${p.toString()}`;
}

/**
 * Qué códigos `geo` publica de verdad este dataset.
 *
 * Se pide sin filtrar `geo` y con un solo periodo, así que la respuesta es el
 * catálogo de países y agregados y pesa unos pocos kilobytes. No se leen sus
 * valores: solo la lista de códigos.
 *
 * Es la pieza que hace que esto no envejezca. La alternativa —una lista de
 * candidatos escrita a mano, `["EA21", "EA20", ...]`— tiene el problema de que
 * el candidato bueno del futuro (`EA22`) no se puede escribir hoy: nadie sabe
 * cómo se va a llamar ni cuándo aparece. Preguntando, aparece solo.
 */
export async function descubrirGeos(spec: DatasetSpec): Promise<string[]> {
  const body = await fetchJson<JsonStat>(url(spec, { lastTimePeriod: "1" }), {
    timeoutMs: 30_000,
  });
  const codigos = indiceDe(body, "geo");
  if (codigos.length === 0) {
    throw new EurostatError("EUROSTAT_EMPTY", `${spec.id} no declara ningún código geo`);
  }
  return codigos;
}

/**
 * El agregado de zona euro más amplio de los que ofrece un dataset.
 *
 * La regla: entre los códigos con forma `EA<n>`, gana la `n` más alta; `EA` a
 * secas queda por debajo de todos, porque es el agregado "actual" sin número y
 * los datasets que lo tienen suelen tenerlo junto a los numerados.
 *
 * Por qué detecta el caso del país 22: la lista no la escribimos nosotros, la
 * publica el dataset. El día que Eurostat añada `EA22`, `descubrirGeos()` lo
 * traerá y `21 < 22` hará el resto. Y si ese día un dataset retira su agregado
 * en vez de renumerarlo, aquí no queda ninguno que elegir y se lanza
 * `EUROSTAT_NO_AGGREGATE`: la fuente falla en voz alta, que es lo contrario de
 * seguir preguntando por un código muerto y recibir cero filas en silencio.
 */
export function agregadoZonaEuro(codigos: string[]): string {
  let mejor: string | null = null;
  let mejorRango = -1;
  for (const codigo of codigos) {
    const m = /^EA(\d*)$/.exec(codigo);
    if (!m) continue;
    // `EA` a secas: rango 0. `EA21`: rango 21.
    const rango = m[1] === "" ? 0 : Number(m[1]);
    if (rango > mejorRango) {
      mejor = codigo;
      mejorRango = rango;
    }
  }
  if (mejor === null) {
    throw new EurostatError(
      "EUROSTAT_NO_AGGREGATE",
      `ningún agregado de zona euro entre ${codigos.length} códigos geo`,
    );
  }
  return mejor;
}

/**
 * La serie de un dataset para un agregado, más reciente primero.
 *
 * Verifica la forma antes de leer un solo valor: toda dimensión que no sea el
 * tiempo tiene que valer exactamente uno.
 *
 * - Tamaño **0**: la consulta no vigila nada. Es el caso del `EA20` de hoy, el
 *   del `EA22` de hoy y el del `EA21` del día que entre el país 22. También el
 *   del `indic_bt=TOVT` que no existe. Todos responden 200 y todos son
 *   `EUROSTAT_EMPTY`.
 * - Tamaño **>1**: hay una dimensión sin filtrar, y entonces el índice plano de
 *   `value` ya no es el índice del tiempo. Leerlo igual daría cifras corridas,
 *   que es peor que no dar ninguna: `EUROSTAT_DIMENSION`.
 */
export function parseSerie(body: JsonStat, spec: DatasetSpec): Observacion[] {
  const dims = body.id;
  const tamanos = body.size;
  if (!Array.isArray(dims) || !Array.isArray(tamanos) || dims.length !== tamanos.length) {
    throw new EurostatError("EUROSTAT_SHAPE", `${spec.id} no trae id/size de dimensiones`);
  }

  for (const [i, dim] of dims.entries()) {
    if (dim === "time") continue;
    const tamano = tamanos[i] ?? 0;
    if (tamano === 0) {
      throw new EurostatError(
        "EUROSTAT_EMPTY",
        `${spec.id}: la dimensión ${dim} volvió vacía (200 sin filas)`,
      );
    }
    if (tamano > 1) {
      throw new EurostatError(
        "EUROSTAT_DIMENSION",
        `${spec.id}: la dimensión ${dim} trae ${tamano} valores y debería traer uno`,
      );
    }
  }

  const periodos = indiceDe(body, "time");
  if (periodos.length === 0) {
    throw new EurostatError("EUROSTAT_EMPTY", `${spec.id}: sin periodos en la respuesta`);
  }

  // Con todo lo demás en un solo valor, la posición en `value` es la posición en
  // el tiempo. `value` puede venir como array o como objeto disperso —Eurostat
  // usa el objeto y se salta los huecos—, y las dos formas se leen igual.
  const valores = body.value ?? {};
  const obs: Observacion[] = [];
  for (const [pos, periodo] of periodos.entries()) {
    const bruto = Array.isArray(valores) ? valores[pos] : valores[String(pos)];
    if (typeof bruto !== "number" || !Number.isFinite(bruto)) continue;
    obs.push({ periodo, date: comoFecha(periodo), value: round(bruto, 2) });
  }

  if (obs.length === 0) {
    throw new EurostatError(
      "EUROSTAT_EMPTY",
      `${spec.id}: ${periodos.length} periodo(s) y ningún valor`,
    );
  }

  // Más reciente primero, igual que FRED: el resto del sistema lee `[0]`.
  return obs.reverse();
}

/** Descubre el agregado, pide la serie y la devuelve ya validada. */
export async function fetchSerie(
  spec: DatasetSpec,
): Promise<{ geo: string; obs: Observacion[] }> {
  const geo = agregadoZonaEuro(await descubrirGeos(spec));
  const body = await fetchJson<JsonStat>(
    url(spec, { lastTimePeriod: String(spec.periodos) }, [geo]),
    { timeoutMs: 30_000 },
  );
  return { geo, obs: parseSerie(body, spec) };
}

/**
 * La última observación como evento normalizado.
 *
 * Mapea al mismo `NormalizedEvent` que FRED, la prensa y la SEC: aguas abajo
 * nadie pregunta de qué fuente viene. Las sorpresas las calcula la misma función
 * que las de FRED, así que un dato europeo llega a la alerta con sus dos bases
 * declaradas exactamente igual que uno americano.
 *
 * `series_id` es el código del dataset y **no** incluye el agregado. Es
 * deliberado: el día que `EA21` pase a `EA22` la serie sigue siendo la misma
 * serie, y meter el agregado en el id partiría su historia en dos y haría que la
 * primera observación con el agregado nuevo se anunciara como si fuera un dato
 * distinto. El agregado que se usó viaja en `source_url`, que apunta a la
 * consulta exacta que se hizo.
 */
export function toEvent(
  obs: Observacion[],
  spec: DatasetSpec,
  opts: { geo: string; retrievedAt: string; ahora?: Date },
): NormalizedEvent {
  const latest = obs[0];
  if (!latest) throw new EurostatError("EUROSTAT_EMPTY", `serie vacía para ${spec.id}`);

  const previous = obs[1]?.value ?? null;
  const ventana = obs.slice(1, 4).map((o) => o.value);
  const mean3m =
    ventana.length === 3 ? round(ventana.reduce((a, b) => a + b, 0) / ventana.length, 2) : null;

  const ahora = opts.ahora ?? new Date(opts.retrievedAt);
  const dias = (ahora.getTime() - Date.parse(`${latest.date}T00:00:00.000Z`)) / 86_400_000;

  return {
    id: eventId("eurostat", spec.id, latest.date),
    source: "eurostat",
    source_url: url(spec, { lastTimePeriod: String(spec.periodos) }, [opts.geo]),
    kind: "macro_release",
    title: spec.title,
    // Un dato macro es su cifra: no hay entradilla que resumir.
    summary: null,
    country: spec.country,
    series_id: spec.id,
    observed_at: latest.date,
    retrieved_at: opts.retrievedAt,
    actual: latest.value,
    previous,
    // Eurostat tampoco publica expectativas de analistas. Sigue sin haber
    // consenso gratuito, y eso se dice en vez de rellenarlo.
    consensus: null,
    unit: spec.unit,
    surprises: computeSurprises(latest.value, { previous, mean3m }, spec.unit),
    stale: Number.isFinite(dias) ? dias > spec.frescuraDias : false,
    official: true,
  };
}

/**
 * Los códigos de una dimensión, en su orden.
 *
 * JSON-stat admite el índice como objeto `{codigo: posicion}` o como array de
 * códigos. Eurostat manda el objeto; se aceptan los dos porque el estándar lo
 * permite y equivocarse aquí sería leer la serie corrida.
 */
function indiceDe(body: JsonStat, dimension: string): string[] {
  const index = body.dimension?.[dimension]?.category?.index;
  if (Array.isArray(index)) return [...index];
  if (index && typeof index === "object") {
    return Object.entries(index)
      .sort((a, b) => a[1] - b[1])
      .map(([codigo]) => codigo);
  }
  return [];
}

/**
 * El periodo de Eurostat como fecha, con la convención que ya usa FRED: el
 * primer día del periodo al que se refiere el dato.
 *
 * `2026-07` → `2026-07-01`, igual que el IPC de agosto de FRED lleva fecha del 1
 * de agosto. `2026-Q2` → `2026-04-01`, igual que el PIB trimestral de FRED. No
 * inventa precisión: nombra el mismo periodo con el formato que el resto de la
 * base ya usa, y así `events_por_serie` ordena bien y la pantalla imprime una
 * sola forma de fecha.
 */
export function comoFecha(periodo: string): string {
  const trimestre = /^(\d{4})-Q([1-4])$/.exec(periodo);
  if (trimestre) {
    const mes = (Number(trimestre[2]) - 1) * 3 + 1;
    return `${trimestre[1]}-${String(mes).padStart(2, "0")}-01`;
  }
  if (/^\d{4}-\d{2}$/.test(periodo)) return `${periodo}-01`;
  if (/^\d{4}$/.test(periodo)) return `${periodo}-01-01`;
  return periodo;
}
