-- Solo preparación local: decisiones independientes de la recepción en Telegram.
-- Ampliación aditiva para instalaciones que ya tenían la primera cola.
--
-- La lista es la VIGENTE, igual que en 20260911_exclusion_al_activar.sql, y no la
-- de su dia. El migrador reejecuta todos los archivos en orden: con la lista
-- antigua, este archivo borraba el check y fallaba al recrearlo en cuanto habia
-- filas `excluded_at_activation`, y como cada sentencia va por separado el
-- borrado se quedaba hecho. Paso el 14-09 en produccion. Si se anade un motivo,
-- se anade en los dos archivos; verificar-migraciones-reejecutables.ts lo comprueba.
alter table capture_queue drop constraint if exists capture_queue_reason_check;
alter table capture_queue add constraint capture_queue_reason_check check (reason in (
  'stale_at_capture','rules_no_match','rules_low_signal','duplicate_story','legacy_processed',
  'scoring_failed','processing_expired','analysis_failed','delivery_failed','budget_exhausted','pending_expired',
  'excluded_at_activation'
));
create table if not exists news_decisions (
  event_id text primary key, decision jsonb not null,
  assigned_at timestamptz not null, expires_at timestamptz not null,
  level text not null check (level in ('important','brief','digest','dashboard','none'))
);
create table if not exists news_usage (
  id text primary key, resource text not null check(resource in ('brief','important','ai')),
  units integer not null check(units > 0), reserved_at timestamptz not null,
  ai_record jsonb
);
create index if not exists news_usage_resource_time on news_usage(resource,reserved_at);
create index if not exists news_decisions_level on news_decisions(level,expires_at);

-- La función es VOLATILE: cada consulta interna adquiere un snapshot posterior
-- al lock; un CTE de una única sentencia no proporciona esa garantía.
create or replace function reserve_news_budget(
  p_id text, p_resource text, p_units integer, p_now timestamptz,
  p_hour integer, p_day integer, p_interval_ms bigint
) returns jsonb language plpgsql volatile as $$
declare
  old news_usage%rowtype; used bigint; earliest timestamptz; latest timestamptz;
  midnight timestamptz := date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC';
begin
  if p_id is null or p_id='' or p_now is null or p_units is null or p_units < 1 or p_day is null or p_day < 0
    or p_hour < 0 or p_interval_ms is null or p_interval_ms < 0 or p_resource is null
    or p_resource not in ('ai','brief','important') then raise exception 'invalid_budget_reservation'; end if;
  perform pg_advisory_xact_lock(hashtextextended('news-budget:' || p_resource,0));
  select * into old from news_usage where id = p_id;
  if found then
    if old.resource <> p_resource or old.units <> p_units then raise exception 'budget_reservation_conflict'; end if;
    return jsonb_build_object('allowed',true,'reason','allowed','nextAt',null);
  end if;
  select coalesce(sum(units),0) into used from news_usage where resource=p_resource and reserved_at>=midnight and reserved_at<midnight+interval '1 day';
  if used+p_units>p_day then return jsonb_build_object('allowed',false,'reason','day_limit','nextAt',midnight+interval '1 day'); end if;
  select coalesce(sum(units),0),min(reserved_at) into used,earliest from news_usage where resource=p_resource and reserved_at>p_now-interval '1 hour';
  if p_hour is not null and used+p_units>p_hour then return jsonb_build_object('allowed',false,'reason','hour_limit','nextAt',coalesce(earliest,p_now)+interval '1 hour'); end if;
  select max(reserved_at) into latest from news_usage where resource=p_resource;
  if latest is not null and latest+p_interval_ms*interval '1 millisecond'>p_now then return jsonb_build_object('allowed',false,'reason','interval','nextAt',latest+p_interval_ms*interval '1 millisecond'); end if;
  insert into news_usage(id,resource,units,reserved_at) values(p_id,p_resource,p_units,p_now);
  return jsonb_build_object('allowed',true,'reason','allowed','nextAt',null);
end $$;
