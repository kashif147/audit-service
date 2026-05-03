# @projectShell/logging-lib

Structured JSON logs (daily rotate), correlation IDs, RabbitMQ hooks, and an n8n ingest endpoint for Express microservices.

## Install

From each service `package.json`:

```json
"@projectShell/logging-lib": "file:../logging-lib"
```

Then `npm install`. Set `SERVICE_NAME` in the environment (for example in Docker) so log files land under `logs/<serviceName>/`.

## Log files

- `logs/<serviceName>/app-YYYY-MM-DD.log` — business events (`logger.business`, RabbitMQ publish/consume success paths via hooks).
- `logs/<serviceName>/error-YYYY-MM-DD.log` — errors (`logger.error`, RabbitMQ failures/DLQ via hooks).

Entries are single-line JSON with `timestamp`, `level`, `service`, `message`, `correlationId`, optional `userId`, `tenantId`, `profileId`, `applicationId`, `membershipId`, `eventType`, plus any extra metadata.

Console output mirrors the same JSON lines (Docker/host logs stay available).

## Express wiring

```javascript
const bizLogger = require("./config/bizLogger.js"); // or createLogger(...) inline
const {
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
  createRabbitStructuredLogHandlers,
} = require("@projectShell/logging-lib");

app.use(correlationIdMiddleware); // early
app.use(express.json());
app.use("/api", createSystemLogsRouter(bizLogger)); // POST /api/system-logs
// ... routes ...
app.use(logErrorMiddleware(bizLogger)); // before your existing error handler
app.use(yourErrorHandler);
```

## RabbitMQ (`@projectShell/rabbitmq-middleware`)

Pass structured hooks when calling `init`:

```javascript
await init({
  url: process.env.RABBIT_URL,
  logger: console, // or your pino logger — unchanged
  structuredLog: createRabbitStructuredLogHandlers(bizLogger),
  serviceName: "my-service",
});
```

Payloads are enriched with `occurredAt`, `sourceService`, and UUID `eventId` while keeping existing fields such as `timestamp` and `data`.

## API helpers

```javascript
bizLogger.business("Application approved", {
  eventType: "ApplicationApproved",
  applicationId: "...",
  profileId: "...",
}, req); // optional req merges x-user-id, x-tenant-id, correlationId

bizLogger.error("Payment webhook failure", {
  eventType: "PaymentFailed",
  stack: err.stack,
}, req);

bizLogger.rabbitPublished({
  eventId, correlationId, exchange, queue, routingKey, eventType,
  retryCount: 0, profileId, applicationId, membershipId,
});
```

## n8n → `POST /api/system-logs`

Optional shared secret: set `SYSTEM_LOG_API_KEY` and send header `x-system-log-key` (or `x-api-key`). The body must be a JSON object with **at least one** non-empty string among: `eventType`, `workflowName`, `executionId`, or `correlationId`. Invalid bodies return **400** with `{ success: false, error, details }`; failures while writing logs return **500** with a generic message (no stack). Success returns **204** with an empty body.

Additional fields (`profileId`, `membershipId`, `status`, etc.) are merged into the business log line.

**Note:** `winston-daily-rotate-file` may flush log files slightly asynchronously right after startup; allow a short delay before tailing new files in smoke tests.

## HTTP noise

Per-request `console` logging is off unless `LOG_HTTP_REQUESTS=true` where that middleware was gated (for example profile-service).
