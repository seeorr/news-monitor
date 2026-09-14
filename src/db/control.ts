import { neon } from "@neondatabase/serverless";
import type { Ejecutor } from "./cliente.ts";
import { validateReservation, type ControlStore, type ReservationResult, type Resource } from "../pipeline/control.ts";
import type { NewsDecision } from "../pipeline/news-policy.ts";
export function neonControlStore(url: string, sql: Ejecutor = neon(url)): ControlStore {
  return {
    async providerRetryAt(provider, now, model) {
      // Una espera de modelo (retryScope='model') solo cuenta si se pregunta por ese modelo.
      const rows = await sql`select max(ai_record->>'retryAt') as retry_at from news_usage
        where resource='ai' and ai_record->>'provider'=${provider}
          and reserved_at >= ${now}::timestamptz - interval '8 days'
          and ai_record->>'retryAt' > ${now}
          and (coalesce(ai_record->>'retryScope','') <> 'model' or ai_record->>'model' = ${model ?? null})` as { retry_at: string | null }[];
      return rows[0]?.retry_at ?? null;
    },
    async putDecision(id, decision) {
      await sql`insert into news_decisions(event_id,decision,assigned_at,expires_at,level)
        values(${id},${JSON.stringify(decision)}::jsonb,${decision.assignedAt}::timestamptz,${decision.expiresAt}::timestamptz,${decision.level})
        on conflict(event_id) do update set decision=excluded.decision,assigned_at=excluded.assigned_at,expires_at=excluded.expires_at,level=excluded.level`;
    },
    async getDecision(id) {
      const rows = await sql`select decision from news_decisions where event_id=${id}` as {decision:NewsDecision}[];
      return rows[0]?.decision ?? null;
    },
    async reserve(request) {
      validateReservation(request);
      const rows = await sql`select reserve_news_budget(${request.id},${request.resource},${request.units},${request.now}::timestamptz,
        ${request.hourLimit ?? null}::integer,${request.dayLimit},${request.minimumIntervalMs ?? 0}::bigint) as result` as {result:ReservationResult}[];
      if (!rows[0]) throw new Error("budget_reservation_missing");
      return rows[0].result;
    },
    async recordAi(id, record) {
      const rows = await sql`update news_usage set ai_record=${JSON.stringify(record)}::jsonb where id=${id} and resource='ai' returning id` as unknown[];
      if (rows.length !== 1) throw new Error("ai_reservation_missing");
    },
    async stats(now) {
      const rows = await sql`select resource,sum(units)::integer as units,count(*)::integer as calls,
        case when count(*) filter(where resource='ai' and (ai_record->>'costUsd') is null)>0 then null
        else coalesce(sum((ai_record->>'costUsd')::numeric),0) end as cost
        from news_usage where reserved_at >= (${now}::timestamptz at time zone 'UTC')::date::timestamp at time zone 'UTC'
        and reserved_at < ((${now}::timestamptz at time zone 'UTC')::date+1)::timestamp at time zone 'UTC' group by resource` as {resource:Resource;units:number;calls:number;cost:string|null}[];
      return rows.map((r) => ({resource:r.resource,units:r.units,calls:r.calls,costUsd:r.cost===null?null:Number(r.cost)}));
    },
  };
}
