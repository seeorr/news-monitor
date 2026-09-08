-- La watchlist deja de vivir en una variable de entorno.
--
-- Motivo: el repositorio es publico y la watchlist dice en que invierte Alberto,
-- asi que no puede estar en el codigo. Un secreto de GitHub servia para
-- esconderla, pero no para trabajar con ella: cambiar un ticker obligaba a
-- entrar en el panel, y nada podia anotarse por ticker. En Neon es un dato mas.
--
-- Idempotente, como todas: se aplica entera en cada arranque.
create table if not exists watchlist (
  ticker            text primary key,
  nombre            text,
  -- Identificador de la SEC. Un ticker no identifica una empresa en EDGAR.
  cik               text,
  -- Simbolo en Yahoo cuando no coincide con el ticker: EUNL.DE, VWCE.DE.
  quote_symbol      text,
  vigilar_filings   boolean          not null default true,
  vigilar_precio    boolean          not null default true,
  -- Movimiento diario, en porcentaje, a partir del cual la sesion es noticia.
  -- Por accion, porque no se mueve igual una utility que una biotecnologica.
  umbral_movimiento double precision not null default 3,
  anadido_en        timestamptz      not null default now()
);

-- Las dos consultas que hace el ciclo: a quien le miro los documentos y a quien
-- el precio. Son pocas filas, pero el indice cuesta nada y documenta el uso.
create index if not exists watchlist_filings on watchlist (vigilar_filings);
create index if not exists watchlist_precio on watchlist (vigilar_precio);
