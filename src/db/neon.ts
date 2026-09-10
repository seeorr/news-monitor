/**
 * Persistencia en Neon Postgres.
 *
 * Por qué una base de datos y no el archivo local: el job de GitHub Actions
 * arranca con el disco vacío en cada ejecución. Sin estado remoto, el cron no
 * recuerda nada y reenvía la misma alerta cada media hora.
 *
 * Neon y no Supabase: ya está en uso en Finance Hub, el free tier no caduca y
 * el proyecto no se pausa mientras el cron lo toque. Mismo driver HTTP que allí.
 */
import { neon } from "@neondatabase/serverless";
import type { Ejecutor } from "./cliente.ts";
import type { AlertRecord, Puntuacion, SeenStore } from "../pipeline/seen.ts";
import type { NormalizedEvent } from "../schema/event.ts";

/**
 * El cliente SQL entra por parámetro —con el de verdad por defecto— para poder
 * mirar en un test la consulta que sale de casa. No es un lujo: los dos fallos
 * que ha tenido este esquema vivían enteros en el texto de la consulta y en sus
 * parámetros, y ninguno se veía leyendo el código con atención.
 */
export function neonSeenStore(databaseUrl: string, sql: Ejecutor = neon(databaseUrl)): SeenStore {
  const mark = async (event: NormalizedEvent, puntuacion?: Puntuacion | null): Promise<void> => {
    const p = puntuacion ?? null;
    await sql`
      insert into events (
        id, source, source_url, kind, title, summary, country, series_id,
        observed_at, retrieved_at,
        actual, previous, consensus, unit, surprises,
        stale, official,
        importance_score, market_impact_score, sentiment, one_liner
      ) values (
        ${event.id}, ${event.source}, ${event.source_url}, ${event.kind},
        ${event.title}, ${event.summary}, ${event.country}, ${event.series_id},
        ${event.observed_at}, ${event.retrieved_at},
        ${event.actual}, ${event.previous}, ${event.consensus}, ${event.unit},
        ${JSON.stringify(event.surprises)}::jsonb,
        ${event.stale}, ${event.official},
        ${p === null ? null : Math.round(p.importance)},
        ${p === null ? null : Math.round(p.impact)},
        ${p?.sentiment ?? null}, ${p?.oneLiner ?? null}
      )
      on conflict (id) do update set
        importance_score    = coalesce(excluded.importance_score, events.importance_score),
        market_impact_score = coalesce(excluded.market_impact_score, events.market_impact_score),
        sentiment           = coalesce(excluded.sentiment, events.sentiment),
        one_liner           = coalesce(excluded.one_liner, events.one_liner)
    `;
  };

  return {
    async has(id) {
      const filas = (await sql`select 1 from events where id = ${id} limit 1`) as unknown[];
      return filas.length > 0;
    },

    /**
     * Las sorpresas van enteras a `surprises`, un `jsonb`, y las dos columnas
     * `surprise_value` / `surprise_basis` ya no se escriben: solo cabía una
     * cifra en ellas y ahora un evento lleva varias. Las filas anteriores a la
     * migración conservan las suyas, ya copiadas al array; el motivo de elegir
     * un array y no seis columnas está escrito en `20260909_sorpresas.sql`.
     *
     * Va como texto con un `::jsonb` explícito por lo mismo que `analysis`: el
     * driver escapa cada hueco de la plantilla como parámetro, y mandar el array
     * a pelo dejaría en manos de su serialización algo que aquí se decide en una
     * línea.
     *
     * El evento en sí no se reescribe nunca: el `do update` toca **solo** las
     * cuatro columnas del paso 3, y con `coalesce` para que un marcado sin
     * puntuación no borre la que ya hubiera. Titular, cifras y fechas siguen
     * siendo lo que se vio la primera vez, que es lo que hace idempotente la
     * alerta cuando dos ejecuciones del cron se pisan.
     *
     * Por qué la nota se guarda aquí y no solo en `alerts`: con el umbral en 7,
     * la mayoría de lo que se puntúa no se anuncia. Si vive solo en la alerta,
     * se paga el modelo y se tira el resultado, y cualquier pantalla que ordene
     * "lo más importante" ordena en realidad el subconjunto de lo anunciado.
     */
    mark,

    /**
     * El evento se guarda primero: `alerts.event_id` tiene clave foránea y una
     * alerta sin su evento no debe existir. El índice único de `alerts` es la
     * segunda red contra el reenvío, por si el registro de vistos falla.
     *
     * La puntuación viaja a las dos tablas a propósito: `alerts` guarda con qué
     * nota se anunció y `events` deja ordenar todo lo puntuado por la misma
     * columna, haya alerta o no.
     *
     * El análisis del paso 4 se guarda **entero y estructurado**, no solo
     * formateado dentro de `body`. Hasta hoy se pagaba el modelo caro, se montaba
     * la prosa y el objeto moría con la función: era el hueco G2. `body` se sigue
     * escribiendo igual y no es una copia redundante de esto —es el registro
     * literal de lo que salió a Telegram, y eso no se reconstruye desde el
     * análisis— pero deja de ser el único sitio donde vive lo que dijo el modelo.
     *
     * Va como texto con un `::jsonb` explícito porque el driver escapa cada hueco
     * de la plantilla como parámetro: mandar el objeto a pelo dejaría en manos de
     * la serialización del driver algo que aquí se decide en una línea.
     */
    async saveAlert(event: NormalizedEvent, alert: AlertRecord) {
      await mark(event, alert);
      const analisis = alert.analysis === null ? null : JSON.stringify(alert.analysis);
      await sql`
        insert into alerts (
          event_id, importance_score, market_impact_score, sentiment, deep_analysis, body,
          analysis
        ) values (
          ${event.id}, ${Math.round(alert.importance)}, ${Math.round(alert.impact)},
          ${alert.sentiment}, ${alert.deep}, ${alert.body},
          ${analisis}::jsonb
        )
        on conflict (event_id) do nothing
      `;
    },

    async size() {
      const filas = (await sql`select count(*)::int as n from events`) as Array<{ n: number }>;
      return filas[0]?.n ?? 0;
    },
  };
}
