/**
 * Idempotencia y registro de lo enviado.
 *
 * Es el fallo que convierte este sistema en el agregador que no quiere ser. El
 * ciclo corre cada media hora y ve la misma última observación de CPI durante
 * un mes entero; sin esto, manda la misma alerta cada vez.
 *
 * Dos implementaciones tras la misma interfaz: Neon en producción
 * (`src/db/neon.ts`) y un archivo JSON local para desarrollo sin base de datos.
 * La interfaz es asíncrona porque la de verdad habla con una base de datos; el
 * archivo paga ese coste sin usarlo, y sale barato comparado con tener dos.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NormalizedEvent } from "../schema/event.ts";

/**
 * La nota del paso 3 de la cascada, sin tipos de la cascada: esto no sabe de
 * LLMs. Se guarda aunque el evento no llegue al umbral, porque puntuar cuesta
 * dinero y tirar el resultado deja cualquier "lo más importante" ordenando solo
 * el subconjunto de lo que se anunció.
 */
export interface Puntuacion {
  importance: number;
  impact: number;
  sentiment: string;
  /** La frase del paso 3: el único resumen propio de un evento no anunciado. */
  oneLiner: string;
}

/**
 * La salida del paso 4, sin tipos de la cascada, igual que `Puntuacion`: esto no
 * sabe de LLMs.
 *
 * Las claves son las del esquema Zod de `Analysis`, en inglés, que es como las
 * escribe el modelo. Traducirlas aquí obligaría a una capa de mapeo entre lo que
 * se genera, lo que se guarda y lo que se lee, y esa capa es justo donde las tres
 * formas se separan sin que nadie lo note. Una sola forma de punta a punta:
 * `analyzeEvent()` la produce, `saveAlert()` la escribe tal cual en el `jsonb` y
 * `lectura.ts` la relee con este mismo tipo.
 */
export interface AnalisisProfundo {
  why_it_matters: string;
  catalysts: string[];
  risks: string[];
  /** `direction` es `up` · `down` · `unclear`; `confidence`, de 0 a 3. */
  affected_assets: Array<{ symbol: string; direction: string; confidence: number }>;
  what_to_watch: string[];
}

/**
 * ¿Lo que ha vuelto de la base tiene de verdad esta forma?
 *
 * El tipo de arriba no garantiza nada al leer: el `jsonb` llega deserializado y
 * el `as FilaEvento[]` de la capa de lectura es un cast, no una comprobación.
 * Escribirlo lo escribe una salida validada con Zod, pero eso no cubre un
 * `update` a mano ni un backfill futuro, y aguas abajo la ficha de detalle hace
 * `analisis.why_it_matters.trim()` sin red: **una sola fila con otra forma
 * lanzaría dentro de un Server Component y tumbaría `/news`, `/alerts` y el Home
 * enteros**, porque las tres pintan el mismo componente.
 *
 * Es la misma doctrina que ya aplica el estado local unas líneas más abajo, donde
 * un JSON corrupto no puede tumbar la ingesta. Aquí un JSON corrupto no puede
 * tumbar el dashboard: se trata como si no hubiera análisis, que es exactamente
 * lo que hay.
 */
export function esAnalisisProfundo(x: unknown): x is AnalisisProfundo {
  if (typeof x !== "object" || x === null) return false;
  const a = x as Record<string, unknown>;
  const listaDeTextos = (v: unknown) => Array.isArray(v) && v.every((i) => typeof i === "string");
  return (
    typeof a["why_it_matters"] === "string" &&
    listaDeTextos(a["catalysts"]) &&
    listaDeTextos(a["risks"]) &&
    listaDeTextos(a["what_to_watch"]) &&
    Array.isArray(a["affected_assets"]) &&
    a["affected_assets"].every((i) => {
      if (typeof i !== "object" || i === null) return false;
      const act = i as Record<string, unknown>;
      return (
        typeof act["symbol"] === "string" &&
        typeof act["direction"] === "string" &&
        typeof act["confidence"] === "number"
      );
    })
  );
}

/** Lo que se guarda de una alerta enviada. Es una puntuación con lo que se mandó. */
export interface AlertRecord extends Puntuacion {
  /** Si corrió el paso 4 de la cascada o se quedó en el resumen barato. */
  deep: boolean;
  body: string;
  /**
   * El análisis estructurado, o null si no lo hubo.
   *
   * **Obligatorio y anulable, no opcional**, y la diferencia es la lección del
   * hueco G2: el objeto se generaba, se formateaba y nadie lo escribía en ningún
   * sitio. Un campo que se puede omitir se omite, y el compilador no dice nada.
   * Así, cada sitio que guarda una alerta tiene que declarar si hubo análisis; la
   * agenda, que no pasa por la cascada, declara que no.
   */
  analysis: AnalisisProfundo | null;
}

/**
 * El desenlace de un envío: las tres únicas cosas que se pueden afirmar después
 * de hablar con Telegram.
 *
 * `rejected` es un rechazo coherente —la API dice que no y dice con qué código—,
 * así que el mensaje no salió. `uncertain` es todo lo demás: un timeout, un 502
 * de un proxy, un JSON ilegible. Pudo llegar y pudo no llegar, y la diferencia
 * importa porque ninguna de las dos se puede reintentar a ciegas.
 */
export type EstadoEntrega = "sent" | "rejected" | "uncertain";

/**
 * Lo que se puede afirmar de un envío, con el rechazo abierto en dos.
 *
 * `rejected` a secas era demasiado grueso y costaba noticias: un 429 y un 400
 * llegan por el mismo camino y significan cosas opuestas. En los dos Telegram
 * dice que **no aceptó nada** —por eso reintentar no puede duplicar—, pero el
 * 429 dice "ahora no" y hasta cuándo, y el 400 dice "este mensaje no, nunca".
 * Cerrarlos igual convertía una limitación de ritmo en una noticia perdida para
 * siempre, porque `claimAlert` no vuelve a reclamar una fila cerrada sin `force`.
 *
 * `code` es un código propio y seguro (`telegram_429`), nunca la `description`
 * que devuelve la API: ese texto puede llevar dentro el token del bot.
 */
export type ResultadoEnvio = {
  state: EstadoEntrega;
  /** Solo con `state === "rejected"`. 429 es el único recuperable. */
  rejection?: "recoverable" | "permanent";
  /** Solo con `rejection === "recoverable"`: de `parameters.retry_after`. */
  retryAfterMs?: number;
  code?: string;
};

/**
 * El estado en vuelo, los tres desenlaces del transporte y los dos cierres que
 * no pasan por él.
 *
 * `sending` y `uncertain` **no se liberan nunca por tiempo**, y es la pieza que
 * arregla el defecto original: liberar por caducidad es justo lo que produce el
 * doble envío, porque Telegram no ofrece idempotencia y un mensaje ya entregado
 * no se retira del teléfono de nadie. El único camino de vuelta es `--force`,
 * que es una persona decidiendo.
 *
 * `deferred` es la excepción, y solo porque es la única que puede demostrarlo:
 * se escribe **exclusivamente** tras un rechazo recuperable, donde Telegram ha
 * dicho por escrito que no aceptó el mensaje. Es el único estado que `claimAlert`
 * vuelve a reclamar sin una persona, y aun así no antes de su `nextAttemptAt`.
 *
 * `undeliverable` cierra lo que no se puede redactar —una cifra que la fuente no
 * respalda, un cuerpo que no cabe—. No se envió nada y no se enviará: repetir un
 * fallo determinista solo gasta la ventana de la cola. Es un cierre explícito y
 * distinto de `sent` a propósito: `alerts` sigue significando "salió de verdad".
 */
export type EstadoCierre = EstadoEntrega | "deferred" | "undeliverable";
export type EstadoReclamo = "sending" | EstadoCierre;

/** Quién reclama la entrega, y si lo pide una persona a mano. */
export interface Reclamo {
  /** Identifica a este proceso: solo su dueño puede cerrar la entrega. */
  token: string;
  /** `--force`: reclama aunque la entrega esté en vuelo o ya cerrada. */
  force?: boolean;
  /** Reloj del ciclo, para vencer un `deferred`. El de pared si no se da. */
  now?: string;
}

/** Estado de la entrega y, si está aplazada, desde cuándo se puede reintentar. */
export interface EntregaReclamada {
  estado: EstadoReclamo;
  nextAttemptAt: string | null;
}

export interface SeenStore {
  /** ¿Se procesó ya esta observación? */
  has(id: string): Promise<boolean>;
  /**
   * Queda registrada como procesada, haya alertado o no.
   *
   * La puntuación es opcional porque no todo lo que se marca se ha puntuado: un
   * duplicado de un grupo se registra para que no vuelva en la vuelta siguiente,
   * y nadie le ha pasado un modelo por encima. Sin nota se queda a null, que es
   * la verdad, y no un 5 de relleno.
   */
  mark(event: NormalizedEvent, puntuacion?: Puntuacion | null): Promise<void>;
  /**
   * Reclama la entrega de una alerta **antes** de tocar la red.
   *
   * Es la diferencia entre "la fila no se duplica" y "el mensaje no se duplica".
   * El índice único de `alerts` impedía lo primero y no lo segundo: la alerta se
   * mandaba y solo después se registraba, así que morir en esos quince segundos de
   * red dejaba el registro vacío y la vuelta siguiente volvía a escribir al
   * teléfono de alguien.
   *
   * Devuelve `false` cuando el reclamo es de otro o la entrega ya está cerrada, y
   * entonces **no se envía**: ni en vuelo, ni entregada, ni en duda. Solo
   * `force` reclama una entrega que ya tiene dueño, con una excepción escrita en
   * `EstadoCierre`: un `deferred` vencido, que es el único caso donde consta que
   * Telegram no aceptó nada.
   */
  claimAlert(eventId: string, reclamo: Reclamo): Promise<boolean>;
  /** Lectura sin reclamar ni liberar; permite cerrar la cola sin repetir análisis. */
  alertState?(eventId: string): Promise<EstadoReclamo | null>;
  /** Lo mismo, con el plazo: quien decide la ventana necesita saber hasta cuándo. */
  alertDelivery?(eventId: string): Promise<EntregaReclamada | null>;
  /**
   * Cierra la entrega que este proceso reclamó.
   *
   * Lanza si el reclamo ya no es suyo o si la entrega no sigue en vuelo: perder
   * el acuse tiene que verse, porque lo que queda es una fila en `sending` que
   * nadie va a liberar.
   *
   * `nextAttemptAt` solo tiene sentido con `deferred`; con cualquier otro cierre
   * se ignora, porque ninguno se reintenta solo.
   */
  finishAlert(eventId: string, token: string, estado: EstadoCierre, nextAttemptAt?: string | null): Promise<void>;
  /**
   * Cierra una entrega que nunca llegó a reclamarse porque no hay nada que
   * enviar: el texto no se puede redactar sin inventar.
   *
   * No reclama y no pisa: si ya hay fila —en vuelo o cerrada— devuelve `false` y
   * se respeta lo que decidiera su dueño. Se escribe sin token a propósito,
   * igual que el relleno histórico: aquí no hubo reclamo que fingir.
   */
  markUndeliverable?(eventId: string): Promise<boolean>;
  /**
   * Remata un cierre que `markUndeliverable` no pudo escribir porque ya habia
   * fila **aplazada**.
   *
   * `markUndeliverable` no pisa nada, y esta bien que no lo haga; el problema es
   * lo que quedaba cuando no escribia: un 429 deja la entrega en `deferred` con
   * su plazo, y si la noticia se cierra despues por vieja, la cola se suelta
   * (`delivery_pending = false`) mientras la entrega sigue diciendo "pendiente de
   * reintento" con un plazo ya vencido. Nadie la reintenta nunca y la base miente.
   *
   * Solo promueve desde `deferred`, y es deliberado: `sent`, `rejected` y
   * `uncertain` son terminales y `sending` esta en vuelo. Tocar cualquiera de
   * ellos es el doble envio que costo escribir esta tabla —el motivo esta en
   * `neon/migrations/20260911_entrega_aplazable.sql`— y aqui no se hace.
   * Devuelve `false` si la fila no estaba `deferred`: entonces no habia nada que
   * rematar.
   */
  closeDeferred?(eventId: string): Promise<boolean>;
  /** Se envió esta alerta. */
  saveAlert(event: NormalizedEvent, alert: AlertRecord): Promise<void>;
  size(): Promise<number>;
}

/**
 * La máquina de estados de la entrega, en memoria.
 *
 * Se reclama solo lo que no tiene dueño y se cierra solo lo propio. El archivo
 * local aplica la misma regla dentro de un bloqueo y Neon la expresa en SQL.
 */
/** Una fila de la máquina de estados. Sin token en los cierres sin reclamo. */
interface Entrega { estado: EstadoReclamo; token: string | null; nextAttemptAt: string | null }

/**
 * La ÚNICA puerta por la que una entrega vuelve a estar disponible sin que lo
 * pida una persona.
 *
 * Si estás aquí buscando dónde liberar un `sending` colgado o un `uncertain`
 * viejo: no está, y no se añade. Los dos significan "pudo haber salido", y
 * Telegram no retira un mensaje entregado. `deferred` es distinto porque solo se
 * escribe cuando la propia API ha respondido que no aceptó nada.
 */
function aplazamientoVencido(entrega: Entrega, now?: string): boolean {
  if (entrega.estado !== "deferred") return false;
  if (entrega.nextAttemptAt === null) return true;
  return Date.parse(now ?? new Date().toISOString()) >= Date.parse(entrega.nextAttemptAt);
}

/** El plazo solo lo lleva `deferred`: ningún otro cierre se reintenta solo. */
function plazo(estado: EstadoCierre, nextAttemptAt?: string | null): string | null {
  if (estado !== "deferred" || nextAttemptAt == null) return null;
  if (!Number.isFinite(Date.parse(nextAttemptAt))) throw new Error("invalid_alert_retry_instant");
  return nextAttemptAt;
}

function reclamosEnMemoria() {
  const entregas = new Map<string, Entrega>();
  return {
    entregas,
    alertState: async (eventId: string): Promise<EstadoReclamo | null> => entregas.get(eventId)?.estado ?? null,
    alertDelivery: async (eventId: string): Promise<EntregaReclamada | null> => {
      const entrega = entregas.get(eventId);
      return entrega ? { estado: entrega.estado, nextAttemptAt: entrega.nextAttemptAt } : null;
    },
    claimAlert: async (eventId: string, reclamo: Reclamo): Promise<boolean> => {
      const entrega = entregas.get(eventId);
      if (entrega && !reclamo.force && !aplazamientoVencido(entrega, reclamo.now)) return false;
      entregas.set(eventId, { estado: "sending", token: reclamo.token, nextAttemptAt: null });
      return true;
    },
    finishAlert: async (eventId: string, token: string, estado: EstadoCierre, nextAttemptAt?: string | null): Promise<void> => {
      const entrega = entregas.get(eventId);
      if (!entrega || entrega.estado !== "sending" || entrega.token !== token) {
        throw new Error("alert_claim_lost");
      }
      entregas.set(eventId, { estado, token, nextAttemptAt: plazo(estado, nextAttemptAt) });
    },
    markUndeliverable: async (eventId: string): Promise<boolean> => {
      if (entregas.has(eventId)) return false;
      entregas.set(eventId, { estado: "undeliverable", token: null, nextAttemptAt: null });
      return true;
    },
    closeDeferred: async (eventId: string): Promise<boolean> => {
      const entrega = entregas.get(eventId);
      if (!entrega || entrega.estado !== "deferred") return false;
      // El plazo se borra con el estado: dejarlo seria invitar a alguien a
      // usarlo para liberar algo que ya no se reintenta. El token se conserva,
      // que es el rastro de quien la mando la ultima vez.
      entregas.set(eventId, { estado: "undeliverable", token: entrega.token, nextAttemptAt: null });
      return true;
    },
  };
}

interface FileDelivery extends Entrega { eventId: string }
const CIERRES: readonly EstadoCierre[] = ["sent", "rejected", "uncertain", "deferred", "undeliverable"];
const DELIVERY_STATES: readonly EstadoReclamo[] = ["sending", ...CIERRES];

/**
 * Reclamos duraderos: el archivo de la cola puede sobrevivir a un envío, por
 * lo que proteger solo seen.json o la memoria ya no impide repetir Telegram.
 * Nunca caducan. Un archivo ilegible falla cerrado, incluso con --force.
 */
function reclamosEnArchivo(stateDir: string) {
  const path = join(stateDir, "alert-deliveries.json");
  const lockPath = `${path}.lock`;
  const read = (): Map<string, FileDelivery> => {
    if (!existsSync(path)) return new Map();
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; deliveries?: unknown };
    if (!raw || raw.version !== 1 || !Array.isArray(raw.deliveries)) throw new Error("invalid_alert_delivery_state");
    const deliveries = new Map<string, FileDelivery>();
    for (const row of raw.deliveries as Array<Partial<FileDelivery> | null>) {
      // El token falta solo en un cierre que nadie reclamó; el plazo, solo en
      // un archivo anterior al campo. Cualquier otra forma falla cerrado.
      const cierreSinReclamo = row?.estado === "undeliverable" && (row.token ?? null) === null;
      const plazoValido = row?.nextAttemptAt == null ||
        (typeof row.nextAttemptAt === "string" && Number.isFinite(Date.parse(row.nextAttemptAt)));
      if (!row || typeof row.eventId !== "string" || !row.eventId ||
          (!cierreSinReclamo && (typeof row.token !== "string" || !row.token)) || !plazoValido ||
          !row.estado || !DELIVERY_STATES.includes(row.estado) || deliveries.has(row.eventId)) {
        throw new Error("invalid_alert_delivery_state");
      }
      deliveries.set(row.eventId, { eventId: row.eventId, estado: row.estado,
        token: row.token ?? null, nextAttemptAt: row.nextAttemptAt ?? null });
    }
    return deliveries;
  };
  const acquire = async (): Promise<number> => {
    mkdirSync(dirname(path), { recursive: true });
    for (let attempt = 0; attempt < 80; attempt++) {
      let fd: number;
      try { fd = openSync(lockPath, "wx"); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Windows puede devolver EPERM/EACCES durante delete-pending, aunque
        // el dueño ya cerró el archivo. Reintentar conserva el bloqueo y sigue
        // fallando cerrado tras el plazo; nunca equivale a haberlo adquirido.
        if (code !== "EEXIST" && !(process.platform === "win32" && (code === "EPERM" || code === "EACCES"))) throw err;
        // Nunca se roba un bloqueo: comprobar PID y borrar después introduce
        // una carrera si otro proceso lo ha recuperado entre ambas operaciones.
        // Si murió el dueño, detener los consumidores y revisar el archivo de
        // reclamos antes de retirar manualmente solo el .lock.
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid }), "utf8");
        fsyncSync(fd);
        return fd;
      } catch (err) {
        closeSync(fd);
        unlinkSync(lockPath);
        throw err;
      }
    }
    throw new Error("alert_delivery_file_busy");
  };
  const change = async <T>(update: (rows: Map<string, FileDelivery>) => T): Promise<T> => {
    const fd = await acquire();
    let temporary: string | null = null;
    try {
      const rows = read();
      const result = update(rows);
      temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const out = openSync(temporary, "wx");
      try {
        writeFileSync(out, JSON.stringify({ version: 1, deliveries: [...rows.values()] }), "utf8");
        fsyncSync(out);
      } finally { closeSync(out); }
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, path); break; }
        catch (error) {
          if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      temporary = null;
      return result;
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
    }
  };
  return {
    alertState: async (eventId: string): Promise<EstadoReclamo | null> => read().get(eventId)?.estado ?? null,
    alertDelivery: async (eventId: string): Promise<EntregaReclamada | null> => {
      const entrega = read().get(eventId);
      return entrega ? { estado: entrega.estado, nextAttemptAt: entrega.nextAttemptAt } : null;
    },
    claimAlert: async (eventId: string, { token, force = false, now }: Reclamo): Promise<boolean> => {
      if (!eventId || !token) throw new Error("invalid_alert_claim");
      return change((rows) => {
        const previous = rows.get(eventId);
        if (previous && !force && !aplazamientoVencido(previous, now)) return false;
        rows.set(eventId, { eventId, estado: "sending", token, nextAttemptAt: null });
        return true;
      });
    },
    finishAlert: async (eventId: string, token: string, estado: EstadoCierre, nextAttemptAt?: string | null): Promise<void> => {
      if (!CIERRES.includes(estado)) throw new Error("invalid_alert_delivery_state");
      const hasta = plazo(estado, nextAttemptAt);
      await change((rows) => {
        const previous = rows.get(eventId);
        if (!previous || previous.estado !== "sending" || previous.token !== token) throw new Error("alert_claim_lost");
        rows.set(eventId, { eventId, estado, token, nextAttemptAt: hasta });
      });
    },
    markUndeliverable: async (eventId: string): Promise<boolean> => {
      if (!eventId) throw new Error("invalid_alert_claim");
      return change((rows) => {
        if (rows.has(eventId)) return false;
        rows.set(eventId, { eventId, estado: "undeliverable", token: null, nextAttemptAt: null });
        return true;
      });
    },
    closeDeferred: async (eventId: string): Promise<boolean> => {
      if (!eventId) throw new Error("invalid_alert_claim");
      return change((rows) => {
        const previous = rows.get(eventId);
        if (!previous || previous.estado !== "deferred") return false;
        rows.set(eventId, { ...previous, estado: "undeliverable", nextAttemptAt: null });
        return true;
      });
    },
  };
}

/**
 * Estado en un archivo JSON. Para desarrollo local: **no sobrevive a un job de
 * GitHub Actions**, que arranca con el disco limpio. En producción va Neon.
 *
 * Solo guarda ids: el historial de alertas, las notas del paso 3 y el análisis
 * del paso 4 necesitan una base de datos, así que aquí `saveAlert` se limita a
 * dar por procesado el evento y la puntuación que reciba `mark` se descarta. Es
 * una degradación consciente del modo local, no un olvido.
 *
 * La entrega vive en alert-deliveries.json, separado de los ids procesados y
 * de queue.json. Así una entrega pendiente que sobrevive a un proceso muerto
 * sigue bloqueada aunque todavía no se hubiese marcado el id en seen.json.
 */
export function fileSeenStore(stateDir: string): SeenStore {
  const path = join(stateDir, "seen.json");
  let ids = new Set<string>();

  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed)) ids = new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      // Un estado corrupto no puede tumbar la ingesta. Se empieza de cero y se
      // reenvia como mucho una alerta: preferible a no ingerir nada.
      ids = new Set();
    }
  }

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...ids].slice(-5000), null, 0), "utf8");
  };

  const { claimAlert, finishAlert, alertState, alertDelivery, markUndeliverable, closeDeferred } = reclamosEnArchivo(stateDir);

  return {
    has: async (id) => ids.has(id),
    mark: async (event) => {
      ids.add(event.id);
      persist();
    },
    claimAlert,
    alertState,
    alertDelivery,
    finishAlert,
    markUndeliverable,
    closeDeferred,
    saveAlert: async (event) => {
      ids.add(event.id);
      persist();
    },
    size: async () => ids.size,
  };
}

/** Para tests: nada toca el disco ni la red. */
export function memorySeenStore(
  initial: string[] = [],
): SeenStore & {
  alerts: AlertRecord[];
  puntuaciones: Map<string, Puntuacion>;
  entregas: Map<string, Entrega>;
} {
  const ids = new Set(initial);
  const alerts: AlertRecord[] = [];
  const puntuaciones = new Map<string, Puntuacion>();
  const { entregas, claimAlert, finishAlert, alertState, alertDelivery, markUndeliverable, closeDeferred } = reclamosEnMemoria();
  return {
    alerts,
    puntuaciones,
    entregas,
    claimAlert,
    alertState,
    alertDelivery,
    finishAlert,
    markUndeliverable,
    closeDeferred,
    has: async (id) => ids.has(id),
    mark: async (event, puntuacion) => {
      ids.add(event.id);
      if (puntuacion) puntuaciones.set(event.id, puntuacion);
    },
    saveAlert: async (event, alert) => {
      ids.add(event.id);
      puntuaciones.set(event.id, alert);
      alerts.push(alert);
    },
    size: async () => ids.size,
  };
}
