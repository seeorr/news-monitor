/**
 * Idempotencia y registro de lo enviado.
 *
 * Es el fallo que convierte este sistema en el agregador que no quiere ser. El
 * cron corre cada quince minutos y ve la misma última observación de CPI durante
 * un mes entero; sin esto, manda la misma alerta cada vez.
 *
 * Dos implementaciones tras la misma interfaz: Neon en producción
 * (`src/db/neon.ts`) y un archivo JSON local para desarrollo sin base de datos.
 * La interfaz es asíncrona porque la de verdad habla con una base de datos; el
 * archivo paga ese coste sin usarlo, y sale barato comparado con tener dos.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NormalizedEvent } from "../schema/event.ts";

/** Lo que se guarda de una alerta enviada. Sin tipos de la cascada: esto no sabe de LLMs. */
export interface AlertRecord {
  importance: number;
  impact: number;
  sentiment: string;
  /** Si corrió el paso 4 de la cascada o se quedó en el resumen barato. */
  deep: boolean;
  body: string;
}

export interface SeenStore {
  /** ¿Se procesó ya esta observación? */
  has(id: string): Promise<boolean>;
  /** Queda registrada como procesada, haya alertado o no. */
  mark(event: NormalizedEvent): Promise<void>;
  /** Se envió esta alerta. */
  saveAlert(event: NormalizedEvent, alert: AlertRecord): Promise<void>;
  size(): Promise<number>;
}

/**
 * Estado en un archivo JSON. Para desarrollo local: **no sobrevive a un job de
 * GitHub Actions**, que arranca con el disco limpio. En producción va Neon.
 *
 * Solo guarda ids: el historial de alertas necesita una base de datos y este
 * `saveAlert` se limita a dar por procesado el evento.
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

  return {
    has: async (id) => ids.has(id),
    mark: async (event) => {
      ids.add(event.id);
      persist();
    },
    saveAlert: async (event) => {
      ids.add(event.id);
      persist();
    },
    size: async () => ids.size,
  };
}

/** Para tests: nada toca el disco ni la red. */
export function memorySeenStore(initial: string[] = []): SeenStore & { alerts: AlertRecord[] } {
  const ids = new Set(initial);
  const alerts: AlertRecord[] = [];
  return {
    alerts,
    has: async (id) => ids.has(id),
    mark: async (event) => void ids.add(event.id),
    saveAlert: async (event, alert) => {
      ids.add(event.id);
      alerts.push(alert);
    },
    size: async () => ids.size,
  };
}
