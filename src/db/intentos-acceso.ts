/**
 * Los intentos fallidos de acceso al dashboard, contados donde los ven todas las
 * instancias.
 *
 * La cuenta es **atómica en la base**: un único `insert … on conflict` suma el
 * fallo, reinicia la ventana si ya venció y decide el bloqueo. Leer, sumar en
 * JavaScript y escribir dejaría que una ráfaga en paralelo contara uno solo.
 *
 * Aquí no hay IPs: llega ya la clave de cliente (un HMAC), y eso es lo único que
 * se guarda y lo único que viaja en los parámetros de la consulta.
 */
import type { Ejecutor } from "./cliente.ts";

export interface PoliticaIntentos {
  /** Fallos dentro de la ventana que activan el bloqueo. */
  maxFallos: number;
  ventanaMs: number;
  bloqueoMs: number;
}

export interface AlmacenIntentos {
  /** Fecha hasta la que esa clave está bloqueada, o `null` si no lo está ahora. */
  bloqueadoHasta(clave: string, ahora: Date): Promise<Date | null>;
  registrarFallo(clave: string, ahora: Date): Promise<{ fallos: number; bloqueadoHasta: Date | null }>;
  /** Tras un acceso correcto: la cuenta empieza de cero. */
  limpiar(clave: string): Promise<void>;
}

/** Filas sin actividad en un día y sin bloqueo vigente: no aportan nada. */
const RETENCION_MS = 24 * 60 * 60 * 1000;

export function almacenNeon(sql: Ejecutor, politica: PoliticaIntentos): AlmacenIntentos {
  return {
    async bloqueadoHasta(clave, ahora) {
      const filas = (await sql`
        select blocked_until from dashboard_login_attempts
        where client_key = ${clave} and blocked_until > ${ahora.toISOString()}::timestamptz
      `) as { blocked_until: string | Date }[];
      return filas[0] ? new Date(filas[0].blocked_until) : null;
    },

    async registrarFallo(clave, ahora) {
      const t = ahora.getTime(), en = ahora.toISOString();
      const desde = new Date(t - politica.ventanaMs).toISOString();
      const hasta = new Date(t + politica.bloqueoMs).toISOString();
      await sql`
        delete from dashboard_login_attempts
        where updated_at < ${new Date(t - RETENCION_MS).toISOString()}::timestamptz
          and (blocked_until is null or blocked_until < ${en}::timestamptz)
      `;
      // Un bloqueo ya puesto no se levanta al reiniciar la ventana: se conserva y
      // vence solo. Mientras dura, `entrar()` ni siquiera llega a registrar fallos.
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
        returning failures, blocked_until
      `) as { failures: number | string; blocked_until: string | Date | null }[];
      const fila = filas[0];
      if (!fila) throw new Error("login_attempt_missing");
      return { fallos: Number(fila.failures), bloqueadoHasta: fila.blocked_until ? new Date(fila.blocked_until) : null };
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
    async registrarFallo(clave, ahora) {
      const t = ahora.getTime(), previa = filas.get(clave);
      const reinicia = !previa || previa.inicio <= t - politica.ventanaMs;
      const fallos = reinicia ? 1 : previa.fallos + 1;
      const bloqueo = fallos >= politica.maxFallos ? t + politica.bloqueoMs : previa?.bloqueo ?? null;
      filas.set(clave, { fallos, inicio: reinicia ? t : previa.inicio, bloqueo });
      return { fallos, bloqueadoHasta: bloqueo ? new Date(bloqueo) : null };
    },
    async limpiar(clave) { filas.delete(clave); },
  };
}
