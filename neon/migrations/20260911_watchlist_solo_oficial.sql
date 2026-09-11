-- Estar en la lista y querer leer lo que escriben de ella dejan de ser lo mismo.
--
-- Hasta ahora, anadir un ticker admitia TODO titular que mencionara su nombre o
-- su simbolo. Eso convierte la watchlist en una decision de todo o nada, y la
-- consecuencia se midio el 11-09 con un caso real: los resultados de Adobe y de
-- Oracle no llegaron a Telegram. Ninguna de las dos estaba vigilada —porque
-- vigilarlas costaba tragarse cada «should you buy the dip into today's
-- earnings»— asi que sus noticias se descartaron con `rules_no_match`, incluida
-- la unica que traia la cifra de verdad.
--
-- Con esta columna, una empresa puede estar en la lista SOLO para lo oficial:
-- sus documentos de la SEC —el 8-K Item 2.02 es la publicacion de resultados,
-- con la nota de prensa adjunta— y su fecha de convocatoria. Cero prensa.
--
-- Lo que NO cambia, y es lo importante de que el defecto sea `true`: las cuatro
-- filas que ya existian, y las que entren sin decir nada, se comportan
-- exactamente igual que antes. Esto abre una puerta nueva; no cierra ninguna.
--
-- El movimiento de precio del propio simbolo tampoco depende de esta columna, y
-- se decidio asi a proposito: eso no es prensa, es una observacion del sistema
-- sobre un precio que se vigila queriendo. Quien apaga las noticias de una
-- empresa no esta diciendo «no me avises si se desploma».
--
-- Aditiva e idempotente: una columna anulable con defecto, y un indice parcial.
alter table watchlist add column if not exists vigilar_noticias boolean not null default true;

-- Se consulta justo al reves que las otras dos: lo interesante es saber a quien
-- se le han apagado, que son pocas. Indice parcial por eso.
create index if not exists watchlist_sin_noticias on watchlist (ticker) where not vigilar_noticias;
