/**
 * Los intentos de acceso al dashboard, contados donde los ven todas las
 * instancias.
 *
 * El intento se cuenta **antes** de mirar la clave, y en una sola sentencia.
 * Hasta el 30-09 se hacía al revés —consultar si la IP estaba bloqueada, probar
 * la clave y anotar el fallo después—, y eso tenía un hueco: quinientas
 * peticiones en paralelo consultaban todas antes de que se anotara ninguna, y
 * las quinientas se evaluaban. El límite de 5 solo frenaba a quien probaba de
 * una en una. Ahora un único `insert … on conflict … where` suma el intento,
 * reinicia la ventana si venció, decide el bloqueo y **no toca nada** si la
 * clave ya está bloqueada; PostgreSQL serializa la ráfaga sobre la fila y solo
 * las cinco primeras salen con permiso.
 *
 * Aquí no hay IPs: llega ya la clave de cliente (un HMAC), y eso es lo único que
 * se guarda y lo único que viaja en los parámetros de la consulta.
 */
import type { Ejecutor } from "./cliente.ts";

export interface PoliticaIntentos {
  /** Intentos fallidos dentro de la ventana que activan el bloqueo. */
  maxFallos: number;
  ventanaMs: number;
  bloqueoMs: number;
}

export interface Intento {
  /** Si se puede comprobar la clave de este intento. */
  permitido: boolean;
  /** Intentos contados en la ventana, este incluido; `null` si estaba bloqueada y no se contó. */
  fallos: number | null;
  bloqueadoHasta: Date | null;
}

export interface AlmacenIntentos {
  /** Fecha hasta la que esa clave está bloqueada, o `null` si no lo está ahora. */
  bloqueadoHasta(clave: string, ahora: Date): Promise<Date | null>;
  /**
   * Cuenta el intento como fallido **por adelantado** y dice si se puede
   * evaluar. Con la clave bloqueada no cuenta ni alarga nada. El intento que
   * llega al máximo todavía se evalúa —el quinto fallo es el que bloquea— y, si
   * acierta, `limpiar` borra la cuenta.
   */
  registrarIntento(clave: string, ahora: Date): Promise<Intento>;
  /** Tras un acceso correcto: la cuenta empieza de cero. */
  limpiar(clave: string): Promise<void>;
}

/** Filas sin actividad en un día y sin bloqueo vigente: no aportan nada. */
const RETENCION_MS = 24 * 60 * 60 * 1000;

export function almacenNeon(sql: Ejecutor, politica: PoliticaIntentos): AlmacenIntentos {
  const bloqueadoHasta: AlmacenIntentos["bloqueadoHasta"] = async (clave, ahora) => {
    const filas = (await sql`
      select blocked_until from dashboard_login_attempts
      where client_key = ${clave} and blocked_until > ${ahora.toISOString()}::timestamptz
    `) as { blocked_until: string | Date }[];
    return filas[0] ? new Date(filas[0].blocked_until) : null;
  };
  return {
    bloqueadoHasta,

    async registrarIntento(clave, ahora) {
      const t = ahora.getTime(), en = ahora.toISOString();
      const desde = new Date(t - politica.ventanaMs).toISOString();
      const hasta = new Date(t + politica.bloqueoMs).toISOString();
      await sql`
        delete from dashboard_login_attempts
        where updated_at < ${new Date(t - RETENCION_MS).toISOString()}::timestamptz
          and (blocked_until is null or blocked_until < ${en}::timestamptz)
      `;
      // El `where` del `do update` se evalúa sobre la versión bloqueada de la
      // fila: con un bloqueo vigente no se actualiza nada y no vuelve ninguna
      // fila, que es la respuesta «no se evalúa». Un bloqueo ya puesto no se
      // levanta ni se alarga: vence solo.
      const filas = (await sql`
        insert into dashboard_login_attempts as a (client_key, failures, window_started_at, blocked_until, updated_at)
        values (${clave}, 1, ${en}::timestamptz,
          case when 1 >= ${politica.maxFallos}::int then ${hasta}::timestamptz else null::timestamptz end,
          ${en}::timestamptz)
        on conflict (client_key) do update set
          failures = case when a.window_started_at <= ${desde}::timestamptz then 1 else a.failures + 1 end,
          window_started_at = case when a.window_started_at <= ${desde}::timestamptz then ${en}::timestamptz else a.window_started_at end,
          blocked_until = case
            when (case when a.window_started_at <= ${desde}::timestamptz then 1 else a.failures + 1 end) >= ${politica.maxFallos}::int
              then ${hasta}::timestamptz
            else a.blocked_until end,
          updated_at = ${en}::timestamptz
        where a.blocked_until is null or a.blocked_until <= ${en}::timestamptz
        returning failures, blocked_until
      `) as { failures: number | string; blocked_until: string | Date | null }[];
      const fila = filas[0];
      if (!fila) return { permitido: false, fallos: null, bloqueadoHasta: await bloqueadoHasta(clave, ahora) };
      const fallos = Number(fila.failures);
      return { permitido: fallos <= politica.maxFallos, fallos,
        bloqueadoHasta: fila.blocked_until ? new Date(fila.blocked_until) : null };
    },

    async limpiar(clave) {
      await sql`delete from dashboard_login_attempts where client_key = ${clave}`;
    },
  };
}

/** La misma semántica, sin base: para probar la puerta sin una Neon delante. */
export function almacenEnMemoria(politica: PoliticaIntentos): AlmacenIntentos {
  const filas = new Map<string, { fallos: number; inicio: number; bloqueo: number | null }>();
  return {
    async bloqueadoHasta(clave, ahora) {
      const fila = filas.get(clave);
      return fila?.bloqueo && fila.bloqueo > ahora.getTime() ? new Date(fila.bloqueo) : null;
    },
    async registrarIntento(clave, ahora) {
      const t = ahora.getTime(), previa = filas.get(clave);
      if (previa?.bloqueo && previa.bloqueo > t) return { permitido: false, fallos: null, bloqueadoHasta: new Date(previa.bloqueo) };
      const reinicia = !previa || previa.inicio <= t - politica.ventanaMs;
      const fallos = reinicia ? 1 : previa.fallos + 1;
      const bloqueo = fallos >= politica.maxFallos ? t + politica.bloqueoMs : previa?.bloqueo ?? null;
      filas.set(clave, { fallos, inicio: reinicia ? t : previa.inicio, bloqueo });
      return { permitido: fallos <= politica.maxFallos, fallos, bloqueadoHasta: bloqueo ? new Date(bloqueo) : null };
    },
    async limpiar(clave) { filas.delete(clave); },
  };
}
