/**
 * Horas de silencio para los breves.
 *
 * El 15-09 el cupo diario de breves se reinició a las 00:00 UTC —las 02:00 en
 * Madrid— y la cola de la noche lo gastó entero entre las 02:04 y las 10:04: 24
 * breves mientras el destinatario dormía y ni uno el resto del día. Durante estas
 * horas los breves no reservan cupo ni se envían: se quedan en la cola con su
 * motivo y salen al terminar el silencio, al ritmo de siempre. Los importantes no
 * se callan nunca.
 *
 * Las horas son locales de `zona`, con cambio de horario incluido. El fin es
 * exclusivo: `0-8` calla de 00:00 a 07:59. Un rango que cruza la medianoche
 * (`22-7`) también vale.
 */
export type HorasDeSilencio = { desde: number; hasta: number; zona: string };

export const SILENCIO_POR_DEFECTO = "0-8";
export const ZONA_POR_DEFECTO = "Europe/Madrid";

/** `none` lo apaga. Vacío usa el valor por defecto. Cualquier otra cosa mal escrita falla al arrancar. */
export function leerHorasDeSilencio(valor: string | null, zona: string | null): HorasDeSilencio | null {
  const texto = valor ?? SILENCIO_POR_DEFECTO;
  if (texto === "none") return null;
  const partes = /^(\d{1,2})-(\d{1,2})$/.exec(texto);
  const desde = Number(partes?.[1]), hasta = Number(partes?.[2]);
  if (!partes || desde > 23 || hasta > 23 || desde === hasta) throw new Error("invalid_brief_quiet_hours");
  const nombre = zona ?? ZONA_POR_DEFECTO;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: nombre }); }
  catch { throw new Error("invalid_news_timezone"); }
  return { desde, hasta, zona: nombre };
}

function horaLocal(instante: number, zona: string): number {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instante));
  return Number(partes.find((p) => p.type === "hour")!.value);
}

function enSilencio(instante: number, s: HorasDeSilencio): boolean {
  const hora = horaLocal(instante, s.zona);
  return s.desde < s.hasta ? hora >= s.desde && hora < s.hasta : hora >= s.desde || hora < s.hasta;
}

/**
 * Si `now` cae en silencio, el instante en que termina; si no, `null`.
 *
 * Avanza por horas UTC enteras. Vale para cualquier zona con desfase de horas
 * enteras, como Madrid; en una de media hora el fin saldría con 30 minutos de
 * error, y solo es orientativo: quien vuelve a intentar es el ciclo siguiente.
 */
export function silencioHasta(now: string, s: HorasDeSilencio | null): string | null {
  const inicio = Date.parse(now);
  if (!s || !enSilencio(inicio, s)) return null;
  let t = (Math.floor(inicio / 3_600_000) + 1) * 3_600_000;
  for (let i = 0; i < 48 && enSilencio(t, s); i++) t += 3_600_000;
  return new Date(t).toISOString();
}
