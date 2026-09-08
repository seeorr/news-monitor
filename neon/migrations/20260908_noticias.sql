-- Segunda y tercera fuente: feeds RSS/Atom y SEC EDGAR.
--
-- Idempotente como la primera: se aplica entera en cada arranque y no borra
-- nada. `add column if not exists` es lo que permite que una base ya creada y
-- una vacia acaben iguales sin llevar registro de lo aplicado.

-- Lo que la fuente cuenta del evento: la entradilla de una noticia o el asunto
-- de un documento de la SEC. Un dato macro no lo tiene y se queda a null.
--
-- No es decoracion. Para un evento sin cifras es lo unico que el modelo lee, y
-- ademas define el universo de numeros que puede citar sin saltarse el control
-- anti-fabricacion.
alter table events add column if not exists summary text;

-- Las consultas por fuente ("que ha llegado hoy de EDGAR", "cuanto ruido mete
-- este feed") no tenian por donde entrar: el unico indice era por serie.
create index if not exists events_por_fuente on events (source, first_seen_at desc);
