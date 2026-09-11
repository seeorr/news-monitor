-- Un motivo de descarte para lo que se excluye al activar los envios.
--
-- El 11-09-2026, al pasar de `capture-only` a envios reales, Alberto decidio
-- empezar a entregar desde la activacion y no soltar de golpe el acumulado de la
-- fase de observacion. Esas filas hay que cerrarlas, y cerrarlas exige decir por
-- que.
--
-- Ninguno de los motivos que ya existian era cierto aqui. `pending_expired`
-- habria dicho que caducaron, y no caducaron: seguian dentro de su ventana.
-- `legacy_processed` habria dicho que se procesaron antes, y nadie las proceso.
-- `rules_no_match` habria dicho que las reglas las rechazaron, y las reglas no
-- llegaron a mirarlas. Reutilizar cualquiera de los tres habria dejado el
-- historico contando algo que no paso, y en una cola cuyo valor entero es que se
-- puede auditar, eso es peor que anadir una columna.
--
-- Lo que NO hace: no borra filas, no toca `snapshot` ni las fechas, no marca
-- ninguna entrega, no libera ningun reclamo de `alert_deliveries` y no finge que
-- nada se haya enviado. La fila se conserva entera y auditable; lo unico que se
-- afirma es que no se entrego, y por que.
--
-- Aditiva e idempotente: reconstruye el check con un valor mas, sin `drop table`.
alter table capture_queue drop constraint if exists capture_queue_reason_check;
alter table capture_queue add constraint capture_queue_reason_check
  check (reason in (
    'stale_at_capture', 'rules_no_match', 'rules_low_signal', 'duplicate_story',
    'legacy_processed', 'scoring_failed', 'processing_expired', 'analysis_failed',
    'delivery_failed', 'budget_exhausted', 'pending_expired',
    'excluded_at_activation'
  ));
