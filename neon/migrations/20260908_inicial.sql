-- Esquema inicial de News Monitor.
--
-- Todas las migraciones se aplican en cada arranque y deben ser IDEMPOTENTES:
-- `create ... if not exists` y nada de `drop`. El migrador no lleva registro de
-- lo aplicado, igual que en Finance Hub.

-- Un evento normalizado, tal y como lo define `src/schema/event.ts`.
-- La clave primaria es el id determinista de la observacion: es lo que hace
-- idempotente la alerta. Si el cron vuelve a ver el mismo CPI dentro de diez
-- minutos, el insert no hace nada y no se reenvia nada.
create table if not exists events (
  id             text primary key,
  source         text        not null,
  source_url     text,
  kind           text        not null,
  title          text        not null,
  country        text,
  series_id      text,

  -- Fecha del dato tal cual la publica la fuente. Se guarda como texto a
  -- proposito: FRED da 'YYYY-MM-DD' y una fuente de noticias dara un instante
  -- completo. Convertir aqui seria inventar precision que el dato no tiene.
  observed_at    text        not null,
  retrieved_at   timestamptz not null,

  actual         double precision,
  previous       double precision,
  consensus      double precision,
  unit           text,
  surprise_value double precision,
  surprise_basis text,

  stale          boolean     not null default false,
  official       boolean     not null default false,
  first_seen_at  timestamptz not null default now()
);

create index if not exists events_por_serie on events (series_id, observed_at desc);

-- Lo que de verdad se envio. Separado de `events` porque un evento puede
-- registrarse sin llegar a alertar: no todo lo que se ingiere merece un aviso.
create table if not exists alerts (
  id                  bigserial primary key,
  event_id            text        not null references events (id) on delete cascade,
  sent_at             timestamptz not null default now(),
  importance_score    integer     not null,
  market_impact_score integer     not null,
  sentiment           text        not null,
  -- Si corrio el paso 4 de la cascada (el modelo caro) o se quedo en el resumen.
  deep_analysis       boolean     not null default false,
  body                text        not null
);

-- Una alerta por evento. Es la segunda red de seguridad contra el reenvio:
-- aunque el registro de vistos se pierda, la base no deja mandarla dos veces.
create unique index if not exists alerts_un_evento on alerts (event_id);
create index if not exists alerts_recientes on alerts (sent_at desc);
