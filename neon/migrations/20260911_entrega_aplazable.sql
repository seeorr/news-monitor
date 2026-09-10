-- Dos estados mas en la entrega, y ni uno solo de caducidad.
--
-- El defecto: `sendTelegram` marcaba `rejected` cualquier 4xx coherente que no
-- fuera 408, y ahi dentro iba el 429. En `sendItems`, un `rejected` cierra la
-- entrega y da la noticia por finiquitada; como `claimAlert` no vuelve a
-- reclamar una fila cerrada sin `force`, una limitacion de ritmo -que es un
-- "ahora no", con su plazo escrito en `parameters.retry_after`- se convertia en
-- una noticia perdida para siempre. Telegram, en un 429, no ha aceptado nada:
-- reintentar no puede duplicar, y por eso este caso -y solo este- puede volver.
--
-- `deferred`
--   El unico estado que `claimAlert` vuelve a reclamar SIN una persona detras, y
--   aun asi no antes de `next_attempt_at`. Se escribe exclusivamente tras un
--   rechazo recuperable, o sea cuando la propia API ha respondido por escrito
--   que no proceso el mensaje. Es la excepcion, y esta acotada aqui a proposito.
--
-- `undeliverable`
--   Cierre de lo que no se puede redactar: una cifra que la fuente no respalda,
--   un cuerpo que no cabe. No salio nada y no va a salir -el fallo es
--   determinista: la misma noticia con la misma puntuacion falla igual en cada
--   ciclo-, asi que repetirlo solo gasta la ventana de la cola de entrega y tapa
--   a las noticias sanas que van detras. Se cierra explicitamente y NO como
--   `sent`: `alerts` sigue significando "esto salio de verdad".
--
-- Lo que NO se toca, y no es un olvido:
--
--   `sending`, `sent`, `rejected` y `uncertain` siguen sin caducar. Los dos
--   primeros porque el mensaje pudo llegar y Telegram no lo retira del telefono
--   de nadie; `rejected` porque un 400 no mejora con el tiempo. Si algun dia
--   alguien viene aqui a "liberar los sending viejos": eso es exactamente el
--   doble envio que costo escribir esta tabla. El camino de vuelta es `--force`.
--
-- Aditiva e idempotente: amplia el CHECK y anade una columna anulable. No
-- reescribe ni borra ninguna fila existente; las que ya hay siguen valiendo
-- porque los cuatro estados anteriores siguen permitidos tal cual.
alter table alert_deliveries add column if not exists next_attempt_at timestamptz;

-- El CHECK en linea de la migracion anterior se llama `alert_deliveries_state_check`
-- (nombre que genera Postgres). Se retira y se pone uno propio, con nombre
-- estable, para que esta migracion se pueda aplicar dos veces sin ruido.
alter table alert_deliveries drop constraint if exists alert_deliveries_state_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_estado') then
    alter table alert_deliveries add constraint alert_deliveries_estado
      check (state in ('sending', 'sent', 'rejected', 'uncertain', 'deferred', 'undeliverable'));
  end if;

  -- Un plazo de reintento solo tiene sentido en lo aplazado. Sin esto, una fila
  -- `uncertain` con fecha invitaria a que alguien la usara para liberarla.
  if not exists (select 1 from pg_constraint where conname = 'alert_deliveries_plazo_solo_aplazada') then
    alter table alert_deliveries add constraint alert_deliveries_plazo_solo_aplazada
      check (next_attempt_at is null or state = 'deferred');
  end if;
end $$;

-- Las aplazadas se buscan por su plazo, y son pocas: indice parcial.
create index if not exists alert_deliveries_aplazadas
  on alert_deliveries (next_attempt_at) where state = 'deferred';
