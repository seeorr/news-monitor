-- Una fuente que corrige el contenido sin cambiar el identificador.
--
-- El `on conflict` de la captura actualizaba `last_captured_at` y
-- `capture_count`, y NO tocaba `snapshot`. Conservar el original estaba bien: es
-- el historico, y sobrescribirlo en silencio habria sido peor. Lo que no existia
-- era el otro lado. Cuando el BCE corrige un comunicado conservando su URL, la
-- correccion entraba, se comparaba con la fila existente y se tiraba: no se
-- guardaba, no se contaba, y no habia forma de saber que habia ocurrido.
--
-- Estas cuatro columnas separan cuatro cosas que vivian mezcladas en una fila:
--
--   identidad    -> `id`, lo que la fuente dice que es la misma cosa
--   observacion  -> `capture_count` y las fechas de captura: cuantas veces se vio
--   revision     -> estas columnas: que el contenido cambio en origen
--   entrega      -> `alert_deliveries`, que sigue viviendo aparte
--
-- `fingerprint` describe el contenido VIGENTE, no el original: es la huella de
-- lo que la fuente dice hoy, y por eso se actualiza en cada revision. La calcula
-- `contentFingerprint()` en TypeScript sobre el titular normalizado y las cifras
-- —nunca sobre la entradilla ni sobre la URL—, para que reescribir un resumen o
-- anadir un parametro de seguimiento NO cuente como noticia corregida. Una coma
-- entre digitos si cuenta: "2,5" no es "25".
--
-- Lo que esta migracion NO hace, a proposito: no reenvia nada. Una revision
-- material de una noticia YA ENTREGADA es una decision editorial pendiente, y
-- convertirla aqui en una alerta nueva seria tomarla sin preguntar. De momento
-- se registra y se puede consultar, que es lo que faltaba.
--
-- Aditiva e idempotente, como todas: sin `drop`, y cada `alter` con `if not exists`.
alter table capture_queue add column if not exists fingerprint text;
alter table capture_queue add column if not exists revision jsonb;
alter table capture_queue add column if not exists revised_at timestamptz;
alter table capture_queue add column if not exists revision_count integer not null default 0;

-- Las filas anteriores a esta migracion se quedan con `fingerprint` NULL, y eso
-- es deliberado: NULL significa "no se ha observado el contenido bajo este
-- criterio todavia", que es la verdad. La primera captura posterior adopta su
-- huella **sin contar una revision**, porque no se ha visto ningun cambio: solo
-- se ha empezado a mirar.
--
-- El primer intento de esta migracion rellenaba la huella replicando en SQL lo
-- que hace `contentFingerprint()` en TypeScript. Se descarto, y no por elegancia:
-- validada contra Postgres real, la huella del SQL NO coincidia con la de
-- TypeScript —`json_build_array(...)::text` separa los elementos con un espacio
-- y `JSON.stringify` no—, asi que cada fila antigua habria declarado una
-- correccion inventada en su siguiente captura. Dos implementaciones del mismo
-- hash son dos implementaciones que divergen; la unica que no diverge es la que
-- no existe.
--
-- Quien decide es el `on conflict` de `db/queue.ts`, que exige que la huella
-- previa NO sea nula antes de contar nada.

-- Una revision tiene su fecha y su contenido, o no es una revision.
alter table capture_queue drop constraint if exists capture_queue_revision_coherente;
alter table capture_queue add constraint capture_queue_revision_coherente
  check ((revision is null) = (revised_at is null)
    and (revision is not null or revision_count = 0)
    and revision_count >= 0);

-- La revision es del mismo hecho: si cambiara el id, seria otra fila.
alter table capture_queue drop constraint if exists capture_queue_revision_misma_identidad;
alter table capture_queue add constraint capture_queue_revision_misma_identidad
  check (revision is null or revision ->> 'id' = id);

-- Parcial porque las revisadas son la minoria y es justo lo que se consulta:
-- "que ha corregido la fuente y cuando".
create index if not exists capture_queue_revisadas
  on capture_queue (revised_at desc) where revision_count > 0;
