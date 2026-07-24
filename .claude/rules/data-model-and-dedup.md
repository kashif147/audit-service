# Data model and dedup

One table, one model file: `src/models/auditLog.model.js` owns all SQL — there is no ORM.
`audit_logs` (see `src/db/migrate.js` for the authoritative schema) stores `before_state` /
`after_state` / `metadata` as JSONB, with GIN indexes for querying inside them (e.g.
`after_state->>'memberId'`).

Dedup on insert happens three ways, tried in order:
1. `(tenant_id, event_id)` unique constraint (`ON CONFLICT ... DO UPDATE`).
2. `metadata.dedupeKey`.
3. Special case for journals: `(tenant_id, resource_type='finance',
   event_type='journal.created.v1', after_state->>'docNo')`.

When adding a new event handler that might redeliver, set `eventId` from the RabbitMQ envelope
and rely on rule 1 — don't invent new dedup logic unless the event has no natural `eventId`.

If you add a new `ACTION_LABELS` entry in `src/helpers/auditDiff.js`, keep it in sync with
whatever `ACTION_MAP`/action string the corresponding listener emits — there's no shared enum
tying the two together, just string matching.
