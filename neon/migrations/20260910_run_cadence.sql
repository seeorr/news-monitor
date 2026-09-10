-- Aditiva. Preparada localmente; NO aplicada a producción.
create table if not exists monitor_runs (
  id uuid primary key,
  started_at timestamptz not null,
  record jsonb not null,
  check (record->>'id' = id::text),
  check (record->>'profile' in ('fast','full','process')),
  check (record->>'trigger' in ('external','schedule','manual')),
  check (record->>'status' in ('running','success','partial','failed'))
);
create index if not exists monitor_runs_started on monitor_runs(started_at desc);
-- Solo clasificación de pendientes antiguos inequívocos; no reabre descartes,
-- no puntúa ni toca reclamos. Las nuevas capturas usan el detector TypeScript.
update capture_queue set snapshot = snapshot || '{"critical_macro":true}'::jsonb
where state in ('pending','retryable_failed') and not (snapshot ? 'critical_macro')
  and snapshot->>'official'='true'
  and lower(trim(snapshot->>'title')) in ('monetary policy decisions','monetary policy decision','fomc statement');
create index if not exists capture_queue_critical_pending on capture_queue
  ((coalesce((snapshot->>'critical_macro')::boolean,false)) desc, first_captured_at)
  where state in ('pending','processing','retryable_failed') or (state='scored' and delivery_pending);

-- Las cuatro fechas ya tienen propietarios durables. Vista privada: no imprimir
-- event_id en Actions. settled_at confirma acuse, no lectura del usuario.
create or replace view monitor_event_timing as
select q.id as event_id, q.source_key, q.publication_at, q.data_period_at,
  q.first_captured_at, q.processed_at,
  case when d.state='sent' then d.settled_at else null end as delivered_at,
  d.state as delivery_state,
  coalesce((q.snapshot->>'critical_macro')::boolean,false) as critical,
  extract(epoch from (q.first_captured_at-q.publication_at))/60 as capture_minutes,
  case when d.state='sent' then extract(epoch from (d.settled_at-q.publication_at))/60 end as alert_minutes
from capture_queue q left join alert_deliveries d on d.event_id=q.id;
-- Reversión operacional: RUN_TELEMETRY=false; dejar datos para auditoría.
-- DDL inverso opcional SOLO con consumidores parados y exportación comprobada:
-- drop view monitor_event_timing;
-- drop index capture_queue_critical_pending;
-- drop table monitor_runs;
-- El metadato critical_macro es compatible con lectores antiguos; conservarlo.
-- Nunca borrar ni liberar capture_queue, news_usage o alert_deliveries.
