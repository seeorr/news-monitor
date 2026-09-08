/**
 * Persistencia en Neon Postgres.
 *
 * Por qué una base de datos y no el archivo local: el job de GitHub Actions
 * arranca con el disco vacío en cada ejecución. Sin estado remoto, el cron no
 * recuerda nada y reenvía la misma alerta cada quince minutos.
 *
 * Neon y no Supabase: ya está en uso en Finance Hub, el free tier no caduca y
 * el proyecto no se pausa mientras el cron lo toque. Mismo driver HTTP que allí.
 */
import { neon } from "@neondatabase/serverless";
import type { AlertRecord, SeenStore } from "../pipeline/seen.ts";
import type { NormalizedEvent } from "../schema/event.ts";

export function neonSeenStore(databaseUrl: string): SeenStore {
  const sql = neon(databaseUrl);

  const mark = async (event: NormalizedEvent): Promise<void> => {
    await sql`
      insert into events (
        id, source, source_url, kind, title, summary, country, series_id,
        observed_at, retrieved_at,
        actual, previous, consensus, unit, surprise_value, surprise_basis,
        stale, official
      ) values (
        ${event.id}, ${event.source}, ${event.source_url}, ${event.kind},
        ${event.title}, ${event.summary}, ${event.country}, ${event.series_id},
        ${event.observed_at}, ${event.retrieved_at},
        ${event.actual}, ${event.previous}, ${event.consensus}, ${event.unit},
        ${event.surprise?.value ?? null}, ${event.surprise?.basis ?? null},
        ${event.stale}, ${event.official}
      )
      on conflict (id) do nothing
    `;
  };

  return {
    async has(id) {
      const rows = await sql`select 1 from events where id = ${id} limit 1`;
      return rows.length > 0;
    },

    /**
     * `on conflict do nothing` es la idempotencia entera: dos ejecuciones
     * simultáneas del cron no se pisan y la segunda no reescribe el dato.
     */
    mark,

    /**
     * El evento se guarda primero: `alerts.event_id` tiene clave foránea y una
     * alerta sin su evento no debe existir. El índice único de `alerts` es la
     * segunda red contra el reenvío, por si el registro de vistos falla.
     */
    async saveAlert(event: NormalizedEvent, alert: AlertRecord) {
      await mark(event);
      await sql`
        insert into alerts (
          event_id, importance_score, market_impact_score, sentiment, deep_analysis, body
        ) values (
          ${event.id}, ${Math.round(alert.importance)}, ${Math.round(alert.impact)},
          ${alert.sentiment}, ${alert.deep}, ${alert.body}
        )
        on conflict (event_id) do nothing
      `;
    },

    async size() {
      const rows = (await sql`select count(*)::int as n from events`) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    },
  };
}
