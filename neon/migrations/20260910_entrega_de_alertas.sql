-- La entrega de una alerta: una maquina de estados con reclamo previo al envio.
--
-- Hasta hoy la alerta se mandaba a Telegram y solo despues se escribia en
-- `alerts`. Si el proceso moria en esos quince segundos de red, la vuelta
-- siguiente volvia a mandar el mismo mensaje: el indice unico de `alerts` impide
-- duplicar la fila, no retirar un mensaje ya entregado en el telefono de nadie.
-- Es el mismo problema que el resumen matinal ya resolvio en `daily_briefs`, y
-- esta es la misma solucion: generated -> sending -> sent | rejected | uncertain,
-- con `claim_token`, salvo que aqui no existe `generated` porque la alerta se
-- compone y se manda en el mismo aliento; no hay ventana en la que exista
-- compuesta y sin reclamar.
--
-- Va en su propia tabla, y no en columnas nuevas de `alerts`, por dos motivos:
--
-- 1. `alerts` significa "lo que de verdad salio a Telegram" y el dashboard lo lee
--    con ese significado, en cuatro consultas distintas. Meter aqui filas
--    reclamadas pero no entregadas obligaria a que cada lectura se acordara de
--    filtrarlas, y la que se olvidara mentiria.
-- 2. El reclamo tiene que poder escribirse ANTES que la fila de `events`, y
--    `alerts.event_id` tiene clave foranea. Esta tabla no la tiene, a proposito:
--    si el proceso muere justo despues de reclamar, el evento sigue sin marcar,
--    la vuelta siguiente lo vuelve a mirar, se encuentra el reclamo puesto y NO
--    reenvia. Esa es la propiedad que se esta comprando.
--
-- El nombre lleva fecha 2026-09-10 y por tanto se ordena detras de
-- `20260908_inicial.sql`, que es quien crea `alerts`: el migrador aplica los
-- archivos en orden alfabetico y el relleno del final lee esa tabla.
--
-- Idempotente como todas: se aplica en cada arranque, sin `drop` y sin `alter`.
create table if not exists alert_deliveries (
  event_id    text primary key,

  -- `sending` NO caduca. Nunca. Liberar por tiempo es exactamente lo que produce
  -- el doble envio: Telegram no ofrece idempotencia y un mensaje entregado no se
  -- retira. `uncertain` tampoco se recupera solo, por lo mismo: quiere decir que
  -- pudo llegar. El unico camino de vuelta es `--force`, que es una persona.
  state       text not null default 'sending'
    check (state in ('sending', 'sent', 'rejected', 'uncertain')),

  -- Quien tiene el reclamo. Solo su dueno puede cerrar la entrega. Nulo en las
  -- filas de relleno, que se escriben ya cerradas y a las que nadie reclamo.
  claim_token text,
  claimed_at  timestamptz not null default now(),
  settled_at  timestamptz,

  -- Cuantas veces se ha intentado. No se reinicia con `--force`: es el rastro.
  attempts    integer not null default 1 check (attempts >= 1),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Un estado cerrado tiene fecha de cierre y `sending` no la tiene nunca.
  check ((state = 'sending') = (settled_at is null)),
  -- Una entrega en vuelo tiene dueno; una cerrada ya no lo necesita.
  check (state <> 'sending' or claim_token is not null)
);

-- Las que hay que mirar son las que no llegaron a entregarse. Indice parcial
-- porque las entregadas son la inmensa mayoria y no se consultan por aqui.
create index if not exists alert_deliveries_sin_entregar
  on alert_deliveries (claimed_at desc) where state <> 'sent';

-- Las alertas anteriores a esta migracion se escribieron DESPUES de que Telegram
-- las aceptara, asi que 'sent' es cierto para todas. Se rellenan ya cerradas,
-- con la fecha de envio como fecha de cierre y sin token: nadie las reclamo, y
-- ponerles uno inventado seria fingir un reclamo que no existio.
insert into alert_deliveries (event_id, state, claim_token, claimed_at, settled_at, attempts)
select a.event_id, 'sent', null, a.sent_at, a.sent_at, 1
from alerts a
on conflict (event_id) do nothing;
