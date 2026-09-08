/**
 * Calendario económico — qué se publica y cuándo, antes de que se publique.
 *
 * El resto del sistema es reactivo: llega el dato, se analiza. Esto es lo
 * contrario, y es lo que convierte el lunes en algo que se puede planificar: el
 * jueves hay IPC, el viernes empleo.
 *
 * Sale de FRED (`releases/dates`), que es gratis y oficial. Dos avisos que
 * condicionan el código, los dos comprobados contra la API el 8 de septiembre:
 *
 * 1. **Las fechas futuras solo aparecen con `include_release_dates_with_no_data`.**
 *    Sin ese parámetro, FRED devuelve únicamente lo ya publicado, que para un
 *    calendario no sirve de nada.
 * 2. **Con ese parámetro, algunas publicaciones aparecen todos los días.** El
 *    comunicado del FOMC y los tipos del BCE salen en las once fechas de una
 *    ventana de once días. No son citas: son series continuas marcadas como
 *    publicación. Anunciar "hoy hay FOMC" a diario es peor que no tener agenda,
 *    así que se descartan por su propia forma (ver `CASI_DIARIO`). Las
 *    decisiones de esos dos bancos ya entran por sus feeds de prensa.
 */
import { fetchJson } from "../lib/http.ts";
import { eventId, type NormalizedEvent } from "../schema/event.ts";

const BASE = "https://api.stlouisfed.org/fred";

export interface ReleaseSpec {
  id: number;
  title: string;
  country: string;
}

/**
 * Las publicaciones que mueven el mercado. FRED tiene más de novecientas: la
 * inmensa mayoría son series de nicho que no le importan a nadie que no las esté
 * buscando. Añadir una es añadir una fila.
 */
export const RELEASES: Record<number, ReleaseSpec> = {
  10: { id: 10, title: "IPC de Estados Unidos", country: "🇺🇸" },
  50: { id: 50, title: "Informe de empleo", country: "🇺🇸" },
  53: { id: 53, title: "PIB", country: "🇺🇸" },
  54: { id: 54, title: "Ingresos y gastos personales (PCE)", country: "🇺🇸" },
  46: { id: 46, title: "Precios de producción (PPI)", country: "🇺🇸" },
  9: { id: 9, title: "Ventas minoristas", country: "🇺🇸" },
  180: { id: 180, title: "Peticiones semanales de desempleo", country: "🇺🇸" },
  192: { id: 192, title: "Ofertas de empleo (JOLTS)", country: "🇺🇸" },
};

/**
 * Si una publicación aparece en más de esta proporción de los días de la
 * ventana, no es una cita del calendario: es una serie que se actualiza sola.
 */
const CASI_DIARIO = 0.7;

export interface Cita {
  /** AAAA-MM-DD. FRED da el día; la hora no la publica, y no se inventa. */
  date: string;
  releaseId: number;
  title: string;
  country: string;
}

interface ReleaseDate {
  release_id: number;
  release_name: string;
  date: string;
}
interface AgendaResponse {
  release_dates?: ReleaseDate[];
}

/** Citas de los próximos días. `desde` en AAAA-MM-DD. */
export async function fetchAgenda(
  apiKey: string,
  opts: { desde: string; dias: number },
): Promise<Cita[]> {
  const hasta = sumarDias(opts.desde, opts.dias);
  const url =
    `${BASE}/releases/dates?api_key=${encodeURIComponent(apiKey)}&file_type=json` +
    `&realtime_start=${opts.desde}&realtime_end=${hasta}` +
    "&include_release_dates_with_no_data=true&sort_order=asc&limit=1000";

  // La respuesta de una ventana de dos semanas ronda los 50 KB y el servidor se
  // toma su tiempo: el timeout por defecto de 15 s se queda corto.
  return parseAgenda(await fetchJson<AgendaResponse>(url, { timeoutMs: 45_000 }), opts);
}

/** Función pura, para poder probar la forma real de la respuesta sin red. */
export function parseAgenda(body: AgendaResponse, opts: { desde: string; dias: number }): Cita[] {
  const fechas = body.release_dates ?? [];
  const hasta = sumarDias(opts.desde, opts.dias);

  const dias = new Map<number, Set<string>>();
  for (const f of fechas) {
    if (f.date < opts.desde || f.date > hasta) continue;
    const set = dias.get(f.release_id) ?? new Set<string>();
    set.add(f.date);
    dias.set(f.release_id, set);
  }

  const ventana = Math.max(1, opts.dias + 1);
  const citas: Cita[] = [];

  for (const [releaseId, cuando] of dias) {
    const spec = RELEASES[releaseId];
    if (!spec) continue;
    if (cuando.size / ventana > CASI_DIARIO) continue; // Serie continua, no cita.
    for (const date of cuando) {
      citas.push({ date, releaseId, title: spec.title, country: spec.country });
    }
  }

  return citas.sort((a, b) => a.date.localeCompare(b.date) || a.releaseId - b.releaseId);
}

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * El mensaje de la agenda.
 *
 * Se agrupa por día y **solo aparecen los días que tienen algo**: una lista con
 * cinco "nada previsto" se deja de leer a la tercera vez.
 */
export function formatAgenda(citas: Cita[], opts: { desde: string; dias: number }): string {
  const hasta = sumarDias(opts.desde, opts.dias);
  const lines = [`📅 AGENDA MACRO · ${corta(opts.desde)} a ${corta(hasta)}`];

  if (citas.length === 0) {
    lines.push("Sin publicaciones relevantes en la ventana.");
    return lines.join("\n");
  }

  const porDia = new Map<string, Cita[]>();
  for (const c of citas) porDia.set(c.date, [...(porDia.get(c.date) ?? []), c]);

  for (const [date, delDia] of [...porDia].sort((a, b) => a[0].localeCompare(b[0]))) {
    const etiquetas = delDia.map((c) => `${c.country} ${c.title}`).join(" · ");
    lines.push(`${diaSemana(date)} ${corta(date)} — ${etiquetas}`);
  }

  // Decirlo evita la pregunta obvia y evita la tentación de rellenarlo: FRED
  // publica el día, no la hora.
  lines.push("FRED publica la fecha, no la hora.");
  return lines.join("\n");
}

/**
 * La agenda como evento, solo para poder guardarla y no repetirla.
 *
 * No pasa por la cascada: no hay nada que interpretar en una lista de fechas, y
 * pagar un modelo para que la resuma sería gastar por gastar.
 */
export function agendaEvent(
  citas: Cita[],
  opts: { desde: string; dias: number; retrievedAt: string },
): NormalizedEvent {
  return {
    id: eventId("fred", "agenda", opts.desde),
    source: "fred",
    source_url: "https://fred.stlouisfed.org/releases",
    kind: "calendar",
    title: `Agenda macro del ${corta(opts.desde)}`,
    summary: citas.map((c) => `${c.date}: ${c.title}`).join(" · ") || null,
    country: "🌐",
    series_id: "agenda",
    observed_at: opts.desde,
    retrieved_at: opts.retrievedAt,
    actual: null,
    previous: null,
    consensus: null,
    unit: null,
    surprise: null,
    stale: false,
    official: true,
  };
}

/** Aritmética de días en UTC: sin husos, sin sorpresas al cambiar la hora. */
export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function corta(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

function diaSemana(fecha: string): string {
  return DIAS[new Date(`${fecha}T00:00:00.000Z`).getUTCDay()] ?? "";
}
