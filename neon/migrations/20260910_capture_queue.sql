-- Solo preparar en local. Aplicar explícitamente antes de desplegar el consumidor.
-- La cola no sustituye events ni alert_deliveries. Una captura no es procesada.
-- Sin FK a events: el snapshot debe sobrevivir incluso antes de puntuar.
create table if not exists capture_queue (
  id text primary key,
  snapshot jsonb not null,
  source_key text not null,
  publisher text not null,
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'scored', 'discarded', 'retryable_failed')),
  publication_at timestamptz,
  data_period_at timestamptz,
  story_at timestamptz,
  first_captured_at timestamptz not null,
  last_captured_at timestamptz not null,
  capture_count integer not null default 1 check (capture_count > 0),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  lease_token text,
  lease_until timestamptz,
  reason text check (reason in (
    'stale_at_capture', 'rules_no_match', 'rules_low_signal', 'duplicate_story',
    'legacy_processed', 'scoring_failed', 'processing_expired', 'analysis_failed', 'delivery_failed', 'budget_exhausted', 'pending_expired'
  )),
  score jsonb,
  processed_at timestamptz,
  delivery_pending boolean not null default false,
  check (snapshot ->> 'id' = id),
  check (story_at is null or snapshot ->> 'kind' = 'news'),
  check (last_captured_at >= first_captured_at),
  check ((state = 'processing') = (lease_token is not null and lease_until is not null)),
  check (state = 'processing' or (lease_token is null and lease_until is null)),
  check ((state = 'retryable_failed') = (next_attempt_at is not null)),
  check ((state = 'scored') = (score is not null)),
  check (not delivery_pending or state = 'scored'),
  check (state not in ('discarded', 'retryable_failed') or reason is not null),
  check ((state in ('scored', 'discarded')) = (processed_at is not null))
);

-- El escaneo pendiente envejece por primera captura, no por fecha del dato.
create index if not exists capture_queue_pending_age
  on capture_queue (first_captured_at, id)
  where state in ('pending', 'processing', 'retryable_failed');

create index if not exists capture_queue_source_state
  on capture_queue (source_key, state);

create index if not exists capture_queue_delivery_pending
  on capture_queue (first_captured_at, id)
  where state = 'scored' and delivery_pending;

-- El contexto de una historia no se recorta al scanLimit de procesamiento.
-- Incluye filas en vuelo y ya cerradas para no anunciar sus copias más tarde.
create index if not exists capture_queue_story_context
  on capture_queue (story_at)
  where state in ('pending', 'processing', 'retryable_failed', 'scored')
    or (state = 'discarded' and reason in ('duplicate_story', 'legacy_processed'));

-- No caduca, modifica ni libera una sola fila de alert_deliveries.
-- Reversión operacional: desactivar consumidor; conservar esta tabla y su cola.
-- No se borra backlog al volver a una versión anterior del programa.
