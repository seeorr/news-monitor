-- Intentos fallidos de entrar al dashboard, para poder frenar una fuerza bruta.
--
-- Hasta ahora lo unico que separaba el dashboard de una fuerza bruta era el
-- tamano del secreto (16 caracteres minimo): la pantalla de acceso esta en una
-- URL publica y en Vercel cada peticion puede caer en una instancia distinta,
-- asi que un contador en memoria no cuenta nada y uno en cookie lo borra quien
-- ataca. Neon ya esta, es gratis y lo ven todas las instancias.
--
-- Politica (decision de Alberto, 14-09): 5 fallos en 15 minutos desde una IP la
-- bloquean 15 minutos. Solo esa IP: un tope global dejaria que cualquiera
-- cerrara el acceso a su dueno a proposito.
--
-- `client_key` es un HMAC de la IP con una clave derivada de DASHBOARD_PASSWORD,
-- nunca la IP: una tabla de IPs en claro es un dato personal que no hace falta
-- guardar, y un hash sin clave se invierte probando las 4.300 millones de IPv4.
-- Cambiar la clave del dashboard deja las filas huerfanas, que caducan solas.
--
-- Aditiva e idempotente: una tabla nueva y un indice. Nadie mas la lee.
create table if not exists dashboard_login_attempts (
  client_key        text primary key,
  failures          integer not null check (failures >= 1),
  window_started_at timestamptz not null,
  blocked_until     timestamptz,
  updated_at        timestamptz not null default now()
);

-- La limpieza borra por antiguedad: sin indice seria un recorrido entero por cada fallo.
create index if not exists dashboard_login_attempts_updated on dashboard_login_attempts (updated_at);
