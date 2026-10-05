/**
 * Reconciliación de entregas inciertas: cerrar lo que solo una persona sabe.
 *
 * Una entrega queda en `uncertain` cuando la llamada a Telegram no devolvió un
 * sí ni un no —un tiempo de espera agotado, la red cortada a media petición—. El
 * mensaje **pudo llegar**. Por eso el sistema no la reintenta: reintentar a
 * ciegas es la receta del doble envío, y así está decidido y escrito en
 * `neon/migrations/20260911_entrega_aplazable.sql` y en `markUndeliverable`.
 *
 * Y por eso tampoco se libera por tiempo. `docs/activacion-cadencia.md` lo dice
 * con esas palabras: *«no se libera por tiempo, hay que reconciliarla»*. El dato
 * que falta no está en la base ni se puede deducir de ella; está en el Telegram
 * de Alberto. Solo él puede mirar y decir si el mensaje salió.
 *
 * **Lo que faltaba era la herramienta para decirlo.** El 05-10 había tres filas
 * en `uncertain` del 22-09: catorce días clavando `delivery_uncertain` en cada
 * auditoría de salud. Una alarma que lleva dos semanas sonando ya no avisa de
 * nada, y además tapa la siguiente: una entrega incierta de hoy se perdería
 * entre las viejas. El procedimiento existía y era correcto; lo que no existía
 * era forma de ejecutarlo.
 *
 * Este módulo no decide nada. Recoge el veredicto de una persona y lo escribe.
 */
import type { Ejecutor } from "./cliente.ts";

/** Lo que una persona puede responder. No hay tercera opción a propósito. */
export type Veredicto = "llego" | "no-llego";

/**
 * Estado final según el veredicto.
 *
 * `sent` y `undeliverable` son los dos estados que ya usa el ledger y ninguno
 * necesita migración. No se inventa un estado nuevo tipo `nunca_confirmada`
 * porque el ledger responde a una sola pregunta —¿salió o no salió?— y, una vez
 * que alguien ha mirado, esa pregunta tiene respuesta.
 */
const DESTINO: Record<Veredicto, string> = { "llego": "sent", "no-llego": "undeliverable" };

export interface EntregaSinConfirmar {
  eventId: string;
  state: string;
  attempts: number;
  claimedAt: string | null;
  createdAt: string | null;
  /** Titular, para que quien reconcilia sepa qué está buscando en su chat. */
  title: string | null;
  kind: string | null;
  publishedAt: string | null;
}

/**
 * Las entregas que esperan un veredicto humano.
 *
 * Se excluyen los avisos operativos (`operational-%`) por el mismo motivo que
 * los excluye la auditoría de salud: no son noticias y nadie los busca en el
 * chat. Y se trae el titular con un `left join` porque una entrega cuyo evento
 * ya no esté en `events` debe seguir apareciendo en la lista: ocultarla sería
 * dejarla colgada para siempre.
 */
export async function listarSinConfirmar(sql: Ejecutor): Promise<EntregaSinConfirmar[]> {
  const filas = (await sql`
    select d.event_id, d.state, d.attempts, d.claimed_at, d.created_at,
           e.title, e.kind, e.observed_at
    from alert_deliveries d
    left join events e on e.id = d.event_id
    where d.state in ('uncertain', 'sending')
      and d.event_id not like 'operational-%'
    order by d.created_at
  `) as Array<Record<string, unknown>>;
  const texto = (v: unknown) => (v == null ? null : String(v));
  const instante = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());
  return filas.map((f) => ({
    eventId: String(f["event_id"]),
    state: String(f["state"]),
    attempts: Number(f["attempts"] ?? 0),
    claimedAt: instante(f["claimed_at"]),
    createdAt: instante(f["created_at"]),
    title: texto(f["title"]),
    kind: texto(f["kind"]),
    publishedAt: instante(f["observed_at"]),
  }));
}

/**
 * Escribe el veredicto. Devuelve `false` si no había nada que cerrar.
 *
 * El `where` acota a `uncertain` y **no** incluye `sending`, aunque la lista sí
 * lo muestre. Una fila en `sending` puede ser un envío en vuelo ahora mismo:
 * cerrarla por detrás dejaría al ciclo escribiendo sobre una fila que alguien ha
 * movido, y el CHECK `(state = 'sending') = (settled_at is null)` convertiría ese
 * cruce en un error de la base. Un `sending` atascado es otra avería y se arregla
 * por otro sitio; aquí se ve, pero no se toca.
 *
 * `settled_at` ya tiene valor —el mismo CHECK lo exige para todo lo que no sea
 * `sending`— así que no se reescribe: la hora en que la entrega dejó de estar en
 * vuelo es la que fue, no la de hoy. Lo que sí avanza es `updated_at`, que es
 * donde queda el rastro de cuándo se reconcilió.
 *
 * No se escribe ninguna fila en `alerts`. `alerts` significa «esto lo aceptó
 * Telegram», y en una entrega incierta Telegram nunca lo aceptó. Que una persona
 * confirme que el mensaje apareció en su chat cierra la entrega, pero no
 * convierte en confirmada una respuesta que nunca llegó: inventar ahí una fila
 * sería escribir en el registro de lo que salió algo que el sistema no vio salir.
 */
export async function reconciliar(sql: Ejecutor, eventId: string, veredicto: Veredicto): Promise<boolean> {
  const destino = DESTINO[veredicto];
  const filas = (await sql`
    update alert_deliveries
    set state = ${destino}, updated_at = now()
    where event_id = ${eventId} and state = 'uncertain'
    returning event_id
  `) as unknown[];
  return filas.length === 1;
}
