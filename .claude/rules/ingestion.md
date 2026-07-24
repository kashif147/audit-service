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

## HTTP (secondary path)

`POST /internal/audit-logs` (`src/controllers/internalAudit.controller.js`) is guarded by a
static shared-secret header — `x-service-secret` must equal `SERVICE_AUDIT_SECRET` — rather than
JWT/gateway auth. Used by services like communication-service that want to log directly over
HTTP instead of publishing to an exchange.
