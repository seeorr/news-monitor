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
 * El estado en vuelo, más los tres desenlaces.
 *
 * `sending` **no se libera nunca por tiempo**, y es la pieza que arregla el
 * defecto: liberar por caducidad es justo lo que produce el doble envío, porque
 * Telegram no ofrece idempotencia y un mensaje ya entregado no se retira del
 * teléfono de nadie. El único camino de vuelta es `--force`, que es una persona
 * decidiendo.
 */
export type EstadoReclamo = "sending" | EstadoEntrega;

/** Quién reclama la entrega, y si lo pide una persona a mano. */
export interface Reclamo {
  /** Identifica a este proceso: solo su dueño puede cerrar la entrega. */
  token: string;
  /** `--force`: reclama aunque la entrega esté en vuelo o ya cerrada. */
  force?: boolean;
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
   * `force` reclama una entrega que ya tiene dueño.
   */
  claimAlert(eventId: string, reclamo: Reclamo): Promise<boolean>;
  /** Lectura sin reclamar ni liberar; permite cerrar la cola sin repetir análisis. */
  alertState?(eventId: string): Promise<EstadoReclamo | null>;
  /**
   * Cierra la entrega que este proceso reclamó.
   *
   * Lanza si el reclamo ya no es suyo o si la entrega no sigue en vuelo: perder
   * el acuse tiene que verse, porque lo que queda es una fila en `sending` que
   * nadie va a liberar.
   */
  finishAlert(eventId: string, token: string, estado: EstadoEntrega): Promise<void>;
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
function reclamosEnMemoria() {
  const entregas = new Map<string, { estado: EstadoReclamo; token: string }>();
  return {
    entregas,
    alertState: async (eventId: string): Promise<EstadoReclamo | null> => entregas.get(eventId)?.estado ?? null,
    claimAlert: async (eventId: string, { token, force = false }: Reclamo): Promise<boolean> => {
      if (entregas.has(eventId) && !force) return false;
      entregas.set(eventId, { estado: "sending", token });
      return true;
    },
    finishAlert: async (eventId: string, token: string, estado: EstadoEntrega): Promise<void> => {
      const entrega = entregas.get(eventId);
      if (!entrega || entrega.estado !== "sending" || entrega.token !== token) {
        throw new Error("alert_claim_lost");
      }
      entregas.set(eventId, { estado, token });
    },
  };
}

interface FileDelivery { eventId: string; estado: EstadoReclamo; token: string }
const DELIVERY_STATES: readonly EstadoReclamo[] = ["sending", "sent", "rejected", "uncertain"];

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
      if (!row || typeof row.eventId !== "string" || !row.eventId || typeof row.token !== "string" || !row.token ||
          !row.estado || !DELIVERY_STATES.includes(row.estado) || deliveries.has(row.eventId)) {
        throw new Error("invalid_alert_delivery_state");
      }
      deliveries.set(row.eventId, { eventId: row.eventId, estado: row.estado, token: row.token });
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
    claimAlert: async (eventId: string, { token, force = false }: Reclamo): Promise<boolean> => {
      if (!eventId || !token) throw new Error("invalid_alert_claim");
      return change((rows) => {
        if (rows.has(eventId) && !force) return false;
        rows.set(eventId, { eventId, estado: "sending", token });
        return true;
      });
    },
    finishAlert: async (eventId: string, token: string, estado: EstadoEntrega): Promise<void> => {
      if (!["sent", "rejected", "uncertain"].includes(estado)) throw new Error("invalid_alert_delivery_state");
      await change((rows) => {
        const previous = rows.get(eventId);
        if (!previous || previous.estado !== "sending" || previous.token !== token) throw new Error("alert_claim_lost");
        rows.set(eventId, { eventId, estado, token });
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

  const { claimAlert, finishAlert, alertState } = reclamosEnArchivo(stateDir);

  return {
    has: async (id) => ids.has(id),
    mark: async (event) => {
      ids.add(event.id);
      persist();
    },
    claimAlert,
    alertState,
    finishAlert,
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
  entregas: Map<string, { estado: EstadoReclamo; token: string }>;
} {
  const ids = new Set(initial);
  const alerts: AlertRecord[] = [];
  const puntuaciones = new Map<string, Puntuacion>();
  const { entregas, claimAlert, finishAlert, alertState } = reclamosEnMemoria();
  return {
    alerts,
    puntuaciones,
    entregas,
    claimAlert,
    alertState,
    finishAlert,
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
