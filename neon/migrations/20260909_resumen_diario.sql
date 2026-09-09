-- Un resumen inmutable por fecha UTC. No participa en events ni alerts.
create table if not exists daily_briefs (
  brief_date date primary key,
  body text not null check (char_length(body) between 1 and 4096),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  send_state text not null default 'generated'
    check (send_state in ('generated', 'sending', 'sent', 'rejected', 'uncertain')),
  claim_token text,
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (send_state = 'generated' or (claim_token is not null and claimed_at is not null)),
  check ((send_state = 'sent') = (sent_at is not null))
);

-- sending también bloquea un proceso muerto o una respuesta SQL perdida.
-- uncertain nunca se recupera por tiempo: Telegram no ofrece idempotencia.
-- Solo generated y un rechazo explícito admiten un nuevo claim.
