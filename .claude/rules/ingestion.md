# Ingestion paths (row creation)

## RabbitMQ (primary path)

`src/rabbitMQ/index.js` wires durable queues to topic exchanges via
`@projectShell/rabbitmq-middleware`. One queue can bind multiple exchanges/routing keys (see
`setupQueue`); each queue maps to exactly one listener module under `src/rabbitMQ/listeners/`.

Each listener is a thin `handleXEvent(payload, eventType, exchange)` function that reshapes the
event into the `createAuditLog()` argument shape and nothing else — no business logic, no
cross-service calls, no validation beyond picking sensible fallback fields
(`data.tenantId || payload.tenantId || "unknown"`).

When a new upstream event needs auditing: add its routing key to the right `setupQueue(...)`
call in `src/rabbitMQ/index.js`, then either extend an existing listener's field-mapping or add a
new listener module following the same shape. Exchange/routing-key names are load-bearing —
cross-check with the publishing service before renaming one.

### Durable keys: explicit-ack queue (P5)

The shared middleware consumer acks a failed delivery and republishes a copy from an in-memory
`setTimeout`; a crash in that delay loses the event, so it is fine only for log-and-skip keys.
Keys whose producer relies on durable delivery (`DURABLE_EVENTS_KEYS` in
`listeners/events.listener.js`: the events-service attendance correction / schedule change /
certificate review keys, published from its outbox with a broker confirm) are NOT bound to
`audit.events.events`. They have their own queue `audit.events.attendance`, consumed by
`rabbitMQ/explicitAckConsumer.js` on a dedicated channel through `buildDurableAuditHandler`:
ack only after the row is committed (or already exists - `(tenant_id, event_id)` dedupe); a
transient failure gets one broker redelivery then the DLQ; an un-storable message (no eventId,
tenant/context rejected) is dead-lettered at once - never acked away. Don't register these keys
with `consumer.registerHandler`, don't bind them to a shared queue, and don't add an
ack-then-republish retry. `tests/explicitAckConsumer.p5.test.js` and
`tests/attendanceAuditExplicitAck.rabbit.it.test.js` (real broker + Postgres, disposable only)
pin this. A new durable key: add it to `DURABLE_EVENTS_KEYS` (mapped in the listener) - it is
then bound to the explicit-ack queue, not the shared one.

## HTTP (secondary path)

`POST /internal/audit-logs` (`src/controllers/internalAudit.controller.js`) is guarded by a
static shared-secret header — `x-service-secret` must equal `SERVICE_AUDIT_SECRET` — rather than
JWT/gateway auth. Used by services like communication-service that want to log directly over
HTTP instead of publishing to an exchange.
