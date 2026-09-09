-- Un resumen por fecha Y destino. El privado lleva el documento entero; el
-- grupo, la versión filtrada. Cada destino necesita su propio estado de envío:
-- con una sola fila, entregar al privado daría por entregado el del grupo.
--
-- Se llama `..._por_destino` y no `..._destino` a propósito: el migrador aplica
-- los archivos en orden alfabético y `destino` iría ANTES que `diario`, que es
-- quien crea la tabla.
--
-- Idempotente como todas: se puede aplicar en cada arranque. La clave primaria
-- solo se mueve si todavía es la antigua, y eso se comprueba en `pg_constraint`.

alter table daily_briefs
  add column if not exists destination text not null default 'private';

do $$
declare
  clave text;
begin
  if to_regclass('public.daily_briefs') is null then
    return;
  end if;

  -- ¿Sigue siendo la clave primaria solo (brief_date)?
  select c.conname into clave
  from pg_constraint c
  where c.conrelid = 'public.daily_briefs'::regclass
    and c.contype = 'p'
    and c.conkey = array[(select a.attnum from pg_attribute a
                          where a.attrelid = c.conrelid and a.attname = 'brief_date')]::int2[];

  if clave is not null then
    execute format('alter table daily_briefs drop constraint %I', clave);
    alter table daily_briefs add primary key (brief_date, destination);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.daily_briefs'::regclass
      and conname = 'daily_briefs_destino_conocido'
  ) then
    alter table daily_briefs add constraint daily_briefs_destino_conocido
      check (destination in ('private', 'group'));
  end if;
end $$;
