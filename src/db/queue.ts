/** Cola durable por HTTP de Neon; cada transición es una única sentencia CAS. */
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import type { Ejecutor } from "./cliente.ts";
import { rateFact } from "../pipeline/critical-macro.ts";
import {
  captureCounts, emptySourceStats, parseQueueEntry, prepareQueueCaptures, prepareQueueFinishes,
  QUEUE_REASONS, queueInstant, queueLease, queueLimit, queueStoryWindow,
  type QueueEntry, type QueueReason, type QueueSourceStats, type QueueStore,
} from "../pipeline/queue.ts";

function entries(result: unknown): QueueEntry[] {
  if (!Array.isArray(result)) throw new Error("invalid_queue_response");
  return result.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid_queue_response");
    const row = { ...raw } as Record<string, unknown>;
    row["event"] = row["snapshot"];
    for (const key of ["publication_at", "data_period_at", "story_at", "first_captured_at", "last_captured_at",
      "next_attempt_at", "lease_until", "processed_at"]) {
      const value = row[key];
      if (value != null) row[key] = queueInstant(value instanceof Date ? value.toISOString() : String(value));
    }
    return parseQueueEntry(row);
  });
}

export function neonQueueStore(databaseUrl: string, sql: Ejecutor = neon(databaseUrl)): QueueStore {
  const finishBatch: QueueStore["finishBatch"] = async (items, token, now) => {
    const at = queueInstant(now);
    const updates = prepareQueueFinishes(items);
    if (updates.length === 0) return;
    // Bloquea el grupo completo y solo actualiza si todas las leases son propias.
    // Un representante puntuado sin descartar sus duplicados permitiría otra
    // alerta tras morir entre dos UPDATE separados.
    const result = await sql`
      with incoming as (
        select * from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) as item(
          id text, state text, score jsonb, reason text, delivery_pending boolean, event jsonb
        )
      ), owned as (
        select q.id from capture_queue q join incoming i on q.id = i.id
        where q.state = 'processing' and q.lease_token = ${token}
          and q.lease_until > ${at}::timestamptz
        order by q.id
        for update of q
      )
      update capture_queue q
      set state = i.state, score = i.score, reason = i.reason,
        snapshot = case when i.event is not null then jsonb_set(q.snapshot,'{summary}',coalesce(i.event->'summary','null'::jsonb)) else q.snapshot end,
        delivery_pending = i.delivery_pending,
        next_attempt_at = case when i.state = 'retryable_failed'
          then ${at}::timestamptz + least(21600, 60 * power(2, least(20, greatest(0, q.attempts - 1)))) * interval '1 second'
          else null end,
        processed_at = case when i.state = 'retryable_failed' then null else ${at}::timestamptz end,
        lease_token = null, lease_until = null
      from incoming i
      where q.id = i.id and q.id in (select id from owned)
        and (select count(*) from owned) = ${updates.length}
      returning q.id
    `;
    if (!Array.isArray(result) || result.length !== updates.length) throw new Error("processing_claim_lost");
  };
  return {
    async capture(inputs, now) {
      const batch = prepareQueueCaptures(inputs, now);
      if (batch.length === 0) return captureCounts([], []);
      // JSONB recordset mantiene una llamada por lote: no una por titular. Se
      // deduplica primero para que ON CONFLICT nunca toque dos veces el mismo id.
      const result = await sql`
        insert into capture_queue (
          id, snapshot, source_key, publisher, state, publication_at, data_period_at, story_at,
          first_captured_at, last_captured_at, capture_count, reason, processed_at
        )
        select id, event, source_key, publisher, state, publication_at, data_period_at, story_at,
          first_captured_at, last_captured_at, capture_count, reason, processed_at
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as incoming(
          id text, event jsonb, source_key text, publisher text, state text,
          publication_at timestamptz, data_period_at timestamptz, story_at timestamptz,
          first_captured_at timestamptz, last_captured_at timestamptz,
          capture_count integer, reason text, processed_at timestamptz
        )
        on conflict (id) do update set
          last_captured_at = greatest(capture_queue.last_captured_at, excluded.last_captured_at),
          capture_count = capture_queue.capture_count + excluded.capture_count
        returning id, source_key, capture_count
      `;
      const rows = z.array(z.object({ id: z.string(), source_key: z.string(), capture_count: z.number().int().positive() })).parse(result);
      return captureCounts(batch, rows);
    },
    async listPending(now, limit) {
      const at = queueInstant(now), cap = queueLimit(limit);
      return entries(await sql`
        select * from (
          select q.*, row_number() over (partition by publisher order by first_captured_at, id) as publisher_rank
          from capture_queue q
          where state = 'pending'
            or (state = 'retryable_failed' and next_attempt_at <= ${at}::timestamptz)
            or (state = 'processing' and lease_until <= ${at}::timestamptz)
        ) candidates
        order by coalesce((snapshot->>'critical_macro')::boolean, false) desc, publisher_rank, first_captured_at, id
        limit ${cap}
      `);
    },
    async storyContext(event) {
      const window = queueStoryWindow(event);
      if (!window) return [];
      if (rateFact(event)) {
        window.from = new Date(Date.parse(window.from) - 14 * 86_400_000).toISOString();
        window.until = new Date(Date.parse(window.until) + 14 * 86_400_000).toISOString();
        return entries(await sql`
          select * from capture_queue
          where coalesce(story_at, data_period_at) between ${window.from}::timestamptz and ${window.until}::timestamptz
            and (state in ('pending','processing','retryable_failed','scored')
              or (state='discarded' and reason in ('duplicate_story','legacy_processed')))
          order by first_captured_at, id
        `);
      }
      return entries(await sql`
        select * from capture_queue
        where story_at between ${window.from}::timestamptz and ${window.until}::timestamptz
          and (state in ('pending', 'processing', 'retryable_failed', 'scored')
            or (state = 'discarded' and reason in ('duplicate_story', 'legacy_processed')))
        order by first_captured_at, id
      `);
    },
    async claim(ids, options) {
      const lease = queueLease(options);
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const result = entries(await sql`
        with available as (
          select id from capture_queue
          where id in (select jsonb_array_elements_text(${JSON.stringify(unique)}::jsonb))
            and (state = 'pending'
              or (state = 'retryable_failed' and next_attempt_at <= ${lease.now}::timestamptz)
              or (state = 'processing' and lease_until <= ${lease.now}::timestamptz))
          order by id
          for update skip locked
        )
        update capture_queue as q
        set state = 'processing', lease_token = ${lease.token}, lease_until = ${lease.until}::timestamptz,
          attempts = q.attempts + 1, next_attempt_at = null,
          reason = case when q.state = 'processing' then 'processing_expired' else q.reason end
        from available
        where q.id = available.id
          and (${!options.allOrNothing}::boolean or (select count(*) from available) = ${unique.length})
        returning q.*
      `);
      const rank = new Map(unique.map((id, index) => [id, index]));
      return result.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    },
    finish: (id, token, outcome, now) => finishBatch([{ id, outcome }], token, now),
    finishBatch,
    async listDeliveryPending(limit) {
      const cap = queueLimit(limit);
      return entries(await sql`
        select * from capture_queue
        where state = 'scored' and delivery_pending
        order by coalesce((snapshot->>'critical_macro')::boolean, false) desc, first_captured_at, id
        limit ${cap}
      `);
    },
    async completeDelivery(id) {
      const result = await sql`
        update capture_queue set delivery_pending = false
        where id = ${id} and state = 'scored'
        returning id
      `;
      if (!Array.isArray(result) || result.length !== 1) throw new Error("scored_queue_entry_missing");
    },
    async stats(now) {
      const at = queueInstant(now);
      const result = await sql`
        with reasons as (
          select source_key, reason, count(*)::int as n
          from capture_queue where state = 'discarded'
          group by source_key, reason
        )
        select q.source_key, min(q.publisher) as publisher,
          sum(q.capture_count)::bigint as captured, count(*)::int as unique,
          count(*) filter (where q.state in ('pending', 'processing', 'retryable_failed'))::int as pending,
          count(*) filter (where q.state = 'processing')::int as processing,
          count(*) filter (where q.state = 'retryable_failed')::int as retryable_failed,
          count(*) filter (where q.state = 'scored')::int as scored,
          count(*) filter (where q.state = 'discarded')::int as discarded,
          count(*) filter (where q.state in ('scored', 'discarded'))::int as processed,
          count(*) filter (where q.delivery_pending)::int as delivery_pending,
          min(q.first_captured_at) filter (where q.state in ('pending', 'processing', 'retryable_failed')) as oldest_pending_at,
          coalesce((select jsonb_object_agg(r.reason, r.n) from reasons r where r.source_key = q.source_key), '{}'::jsonb) as discarded_by_reason
        from capture_queue q
        group by q.source_key
        order by q.source_key
      `;
      if (!Array.isArray(result)) throw new Error("invalid_queue_stats");
      return result.map((raw): QueueSourceStats => {
        const row = raw as Record<string, unknown>;
        const count = emptySourceStats(String(row["source_key"]), String(row["publisher"]));
        for (const key of ["captured", "unique", "pending", "processing", "retryable_failed", "scored", "discarded", "processed", "delivery_pending"] as const) {
          const value = Number(row[key]);
          if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_queue_stats");
          count[key] = value;
        }
        count.oldest_pending_at = row["oldest_pending_at"] == null ? null
          : queueInstant(row["oldest_pending_at"] instanceof Date ? row["oldest_pending_at"].toISOString() : String(row["oldest_pending_at"]));
        count.oldest_pending_age_hours = count.oldest_pending_at
          ? Math.max(0, (Date.parse(at) - Date.parse(count.oldest_pending_at)) / 3_600_000) : 0;
        // partialRecord admite solo claves del vocabulario de motivos.
        count.discarded_by_reason = z.partialRecord(z.enum(QUEUE_REASONS), z.number().int().nonnegative())
          .parse(row["discarded_by_reason"]) as Partial<Record<QueueReason, number>>;
        return count;
      });
    },
  };
}
