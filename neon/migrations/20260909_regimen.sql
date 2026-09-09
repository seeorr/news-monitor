-- Una fotografía diaria, con las entradas y la versión de la regla.
-- Estos datos son privados: nunca se exportan al repositorio público.
create table if not exists market_regimes (
  day date primary key,
  as_of timestamptz not null,
  version text not null,
  state text not null check (state in ('risk_on', 'risk_off', 'mixed', 'insufficient_data')),
  payload jsonb not null
);
