/** Persistencia independiente de alerts. Ningún claim caduca automáticamente. */
import type { Ejecutor } from "./cliente.ts";
import type {
  BriefDestination, BriefDocument, BriefEvent, BriefStore, StoredBrief, SendState,
} from "../pipeline/brief.ts";

/** [desde, hasta): first_seen_at mide ingesta; observed_at fecha el dato. */
export async function recentBriefEvents(sql: Ejecutor, now: Date): Promise<BriefEvent[]> {
  const hasta = now.toISOString();
  const desde = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  return await sql`
    select e.id, e.source, e.source_url, e.kind, e.title, e.one_liner, e.observed_at,
      e.first_seen_at, e.stale,
      coalesce(e.importance_score, a.importance_score) as importance_score
    from events e left join alerts a on a.event_id = e.id
    where coalesce(e.importance_score, a.importance_score) is not null
      and e.kind <> 'calendar'
      and e.first_seen_at >= ${desde}::timestamptz
      and e.first_seen_at < ${hasta}::timestamptz
    order by coalesce(e.importance_score, a.importance_score) desc,
      e.first_seen_at desc, e.id asc
    limit 5
  ` as BriefEvent[];
}

/**
 * Una fila por fecha **y destino**. La clave primaria es `(brief_date,
 * destination)`, así que el privado y el grupo avanzan por la máquina de estados
 * cada uno por su cuenta: un `sending` bloqueado en uno no impide el otro, y un
 * `sent` en uno no da por enviado el otro.
 */
export function dailyBriefStore(sql: Ejecutor): BriefStore {
  return {
    async persist(brief: BriefDocument, destination: BriefDestination): Promise<StoredBrief> {
      await sql`
        insert into daily_briefs (brief_date, destination, body, payload)
        values (${brief.date}::date, ${destination}, ${brief.body},
          ${JSON.stringify(brief.payload)}::jsonb)
        on conflict (brief_date, destination) do nothing
      `;
      // Otra sentencia obtiene un snapshot posterior al INSERT concurrente.
      // Un CTE INSERT/SELECT en una sola sentencia puede no ver al ganador.
      const rows = await sql`
        select brief_date::text as date, body, payload, send_state as state
        from daily_briefs
        where brief_date = ${brief.date}::date and destination = ${destination}
      ` as StoredBrief[];
      if (!rows[0]) throw new Error("brief_missing");
      return rows[0];
    },
    async claim(date: string, destination: BriefDestination, token: string): Promise<StoredBrief | null> {
      const rows = await sql`
        update daily_briefs
        set send_state = 'sending', claim_token = ${token}, claimed_at = now(),
          attempts = attempts + 1, updated_at = now()
        where brief_date = ${date}::date and destination = ${destination}
          and send_state in ('generated', 'rejected')
        returning brief_date::text as date, body, payload, send_state as state
      ` as StoredBrief[];
      return rows[0] ?? null;
    },
    async finish(
      date: string, destination: BriefDestination, token: string, state: SendState,
    ): Promise<void> {
      const rows = await sql`
        update daily_briefs set send_state = ${state}, updated_at = now(),
          sent_at = case when ${state} = 'sent' then now() else sent_at end
        where brief_date = ${date}::date and destination = ${destination}
          and claim_token = ${token} and send_state = 'sending'
        returning brief_date
      ` as unknown[];
      if (rows.length !== 1) throw new Error("brief_claim_lost");
    },
  };
}
