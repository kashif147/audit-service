import { init, consumer, shutdown, connectionManager } from "@projectShell/rabbitmq-middleware";
import logger from "../config/logger.js";
import bizLogger from "../config/bizLogger.js";
import { createRabbitStructuredLogHandlers } from "@projectShell/logging-lib";
import { assertExchangeBindable } from "./exchangeGuard.js";
import { runTenantGatedHandler } from "./eventTenant.js";
import { startExplicitAckConsumer, permanentError } from "./explicitAckConsumer.js";

import { handleUserEvent }         from "./listeners/user.listener.js";
import { handleApplicationEvent }  from "./listeners/application.listener.js";
import { handleMembershipEvent }   from "./listeners/membership.listener.js";
import { handleProductEvent }      from "./listeners/product.listener.js";
import { handleBatchEvent }        from "./listeners/batch.listener.js";
import { handleJournalEvent }      from "./listeners/journal.listener.js";
import { handleProfileEvent }      from "./listeners/profile.listener.js";
import { handleFinanceEvent }      from "./listeners/finance.listener.js";
import { handleEventsEvent, DURABLE_EVENTS_KEYS } from "./listeners/events.listener.js";
import { handleIssueAuditEvent }   from "./listeners/issues.listener.js";
import { handleTenantLifecycleEvent, TENANT_LIFECYCLE_EVENT_TYPES } from "./listeners/tenant.listener.js";
import { runPlatformAuditHandler, PLATFORM_EVENT_TYPES } from "./platformAudit.js";

/**
 * Per-routing-key audit handler (registered by setupQueue).
 *
 * Phase A / A1: an audit row is tenant-owned. The gate resolves the event tenant before any write and
 * rejects (log + skip, no throw - see eventTenant.js) when it is missing, malformed or inconsistent. A
 * placeholder tenant such as "unknown" is never persisted.
 *
 * Shared-consumer keys are log-and-skip (never thrown): a throw makes rabbitmq-middleware ack and
 * republish from an in-memory timer. Keys that need durable delivery do not use this path - see
 * buildDurableAuditHandler + the explicit-ack queue (P5).
 */
export function buildAuditKeyHandler({ key, exchange: boundExchange, handler, platform = false }) {
  return async (payload, messageContext) => {
    try {
      if (platform) {
        await runPlatformAuditHandler({ payload, messageContext, eventType: key, log: logger });
        return;
      }
      await runTenantGatedHandler({
        payload,
        messageContext,
        handler,
        eventType: key,
        exchange: boundExchange,
        log: logger,
      });
    } catch (err) {
      logger.error({ eventType: key, error: err.message }, "Audit handler error");
    }
  };
}

/**
 * P5 durable audit handler (explicit-ack queue only). Resolves ONLY when the row is committed or already
 * exists (createAuditLog dedupes on tenant_id + event_id). A message that can never be stored - no eventId
 * (could not be deduplicated), tenant/context rejected - throws a *permanent* error: the adapter
 * dead-letters it at once (kept for inspection, never acked away, never retried). Any other error (e.g.
 * Postgres unavailable) throws a transient error: one broker redelivery, then the DLQ.
 */
const PERMANENT_WRITE_CODES = new Set(["AUDIT_TENANT_REQUIRED", "AUDIT_CONTEXT_INVALID"]);
export function buildDurableAuditHandler({ key, exchange, handler }) {
  return async (payload, messageContext) => {
    if (!payload?.eventId) throw permanentError("durable audit event without eventId", "AUDIT_EVENT_ID_REQUIRED");
    let ran;
    try {
      ran = await runTenantGatedHandler({ payload, messageContext, handler, eventType: key, exchange, log: logger });
    } catch (err) {
      if (PERMANENT_WRITE_CODES.has(err?.code)) throw permanentError(err.message, err.code);
      throw err;
    }
    if (!ran) throw permanentError("durable audit event rejected by the tenant/context gate", "AUDIT_EVENT_REJECTED");
  };
}

let durableConsumer = null;

// ── Queues ────────────────────────────────────────────────────────────────────
const QUEUES = {
  user:        "audit.user.events",
  application: "audit.application.events",
  membership:  "audit.membership.events",
  product:     "audit.product.events",
  batch:       "audit.batch.events",
  journal:     "audit.journal.events",
  profile:     "audit.profile.events",
  finance:     "audit.finance.events",
  events:      "audit.events.events",
  // P5: the three durable attendance-audit keys, on their own queue with an explicit-ack consumer.
  attendance:  "audit.events.attendance",
  issues:      "audit.issues.events",
  platform:    "audit.platform.events",
  tenant:      "audit.tenant.events",
};

export async function initEventSystem() {
  await init({
    url:            process.env.RABBIT_URL,
    logger,
    structuredLog: createRabbitStructuredLogHandlers(bizLogger),
    prefetch:       10,
    connectionName: "audit-service",
    serviceName:    "audit-service",
    // Not in middleware default list; needed before account-service asserts it.
    exchanges: [
      { name: "batch.events", type: "topic", options: { durable: true } },
      { name: "finance.events", type: "topic", options: { durable: true } },
      { name: "events.events", type: "topic", options: { durable: true } },
      { name: "issues.events", type: "topic", options: { durable: true } },
      // product.events: only in the middleware defaults on its develop/gateway line (1913bdb),
      // not in the pinned main/db70fb8. audit.product.events binds to it.
      { name: "product.events", type: "topic", options: { durable: true } },
    ],
  });
  logger.info("RabbitMQ initialised for audit-service");
}

export async function setupConsumers() {
  /**
   * One durable queue may bind to multiple exchanges (topic routing keys must be unique per queue).
   * @param {string} queueName
   * @param {{ exchange: string, routingKeys: string[] }[]} bindings
   * @param {(payload: object, eventType: string, exchange: string) => Promise<void>} handler
   * @param {{ platform?: boolean }} [opts] platform: true = audit.platform.events (Phase B / Z5): tenantless
   *   platform / system security events go through the platform gate into platform_audit_logs, never the
   *   tenant gate / audit_logs (see platformAudit.js). Every other queue is tenant-gated (A1).
   */
  async function setupQueue(queueName, bindings, handler, { platform = false } = {}) {
    try {
      if (!bindings?.length) throw new Error("bindings required");

      await consumer.createQueue(queueName, { durable: true, messageTtl: 3_600_000 });

      const routingKeyExchange = new Map();

      for (const { exchange, routingKeys } of bindings) {
        // Check first on a throwaway channel: binding to a missing exchange would close the
        // shared channel and kill every consumer already started (see exchangeGuard.js).
        await assertExchangeBindable(exchange);
        await consumer.bindQueue(queueName, exchange, routingKeys);
        for (const rk of routingKeys) {
          if (!routingKeyExchange.has(rk)) routingKeyExchange.set(rk, exchange);
        }
      }

      const allKeys = [...routingKeyExchange.keys()];
      for (const key of allKeys) {
        const boundExchange = routingKeyExchange.get(key);
        consumer.registerHandler(
          key,
          buildAuditKeyHandler({ key, exchange: boundExchange, handler, platform }),
        );
      }

      await consumer.consume(queueName, { prefetch: 10 });
      logger.info({ queue: queueName, bindings }, "Consumer ready");
    } catch (err) {
      logger.error({ queue: queueName, error: err.message }, "Failed to set up consumer");
    }
  }

  // ── user.events ─────────────────────────────────────────────────────────────
  await setupQueue(QUEUES.user, [
    {
      exchange: "user.events",
      routingKeys: [
        "user.crm.created.v1",
        "user.crm.updated.v1",
        "user.portal.created.v1",
        "user.portal.updated.v1",
      ],
    },
  ], handleUserEvent);

  // Phase B / Z4-Z5: platform / system security events from user-service (claim decisions for a real
  // principal, enforced platform authorization allow / deny, platform tenant create / failure, principal-admin
  // changes) -> platform_audit_logs (Z5; no tenant owner). Same user.events exchange, own queue and routing
  // keys (no other service binds these keys). No tenant handler: the platform gate writes the row itself.
  await setupQueue(QUEUES.platform, [
    { exchange: "user.events", routingKeys: [...PLATFORM_EVENT_TYPES] },
  ], null, { platform: true });

  // Phase B / Z5: tenant-visible lifecycle copy of a successful platform tenant creation (owned by the new
  // tenant; tenant-gated like every tenant listener).
  await setupQueue(QUEUES.tenant, [
    { exchange: "user.events", routingKeys: [...TENANT_LIFECYCLE_EVENT_TYPES] },
  ], handleTenantLifecycleEvent);

  // application.events: approvals/rejections (+ optional .v1 submission if introduced).
  // accounts.events: account-service publishes application.status.submitted here (middleware mapping).
  await setupQueue(QUEUES.application, [
    {
      exchange: "application.events",
      routingKeys: [
        "applications.review.processed.v1",
        "applications.review.rejected.v1",
        "applications.executive-council.approved.v1",
        "applications.executive-council.rejected.v1",
        "application.status.submitted.v1",
        "applications.duplicate.review.decided.v1",
        "applications.duplicate.detection.run.v1",
      ],
    },
    {
      exchange: "accounts.events",
      routingKeys: ["application.status.submitted"],
    },
  ], handleApplicationEvent);

  // ── membership.events ───────────────────────────────────────────────────────
  await setupQueue(QUEUES.membership, [
    {
      exchange: "membership.events",
      routingKeys: [
        "members.subscription.current.updated.v1",
        "members.subscription.changed.v1",
        "members.subscription.category.changed.v1",
        "members.subscription.resigned.v1",
        "members.subscription.resignation.undone.v1",
        "members.subscription.cancelled.v1",
        "members.subscription.cancellation.undone.v1",
        "members.subscription.cancel.grace.ended.v1",
      ],
    },
  ], handleMembershipEvent);

  // ── product.events ──────────────────────────────────────────────────────────
  await setupQueue(QUEUES.product, [
    {
      exchange: "product.events",
      routingKeys: [
        "product.type.created.v1",
        "product.type.updated.v1",
        "product.type.deleted.v1",
        "product.created.v1",
        "product.updated.v1",
        "product.deleted.v1",
        "pricing.created.v1",
        "pricing.updated.v1",
        "pricing.deleted.v1",
      ],
    },
  ], handleProductEvent);

  // ── batch.events ─────────────────────────────────────────────────────────────
  await setupQueue(QUEUES.batch, [
    {
      exchange: "batch.events",
      routingKeys: [
        "batch.completed",
        "batch.process.completed.v1",
        "batch.process.queued.v1",
      ],
    },
  ], handleBatchEvent);

  // journal.created.v1: middleware defaults unknown keys to application.events; also bind journal.events if mapped later.
  await setupQueue(QUEUES.journal, [
    { exchange: "application.events", routingKeys: ["journal.created.v1"] },
    { exchange: "journal.events", routingKeys: ["journal.created.v1"] },
  ], handleJournalEvent);

  // ── profile.events (published by profile-service) ───────────────────────────
  await setupQueue(QUEUES.profile, [
    {
      exchange: "profile.events",
      routingKeys: [
        "profile.created",
        "profile.updated",
        "profile.deleted",
        "profile.duplicate.detection.run",
        "profile.duplicate.merged",
      ],
    },
  ], handleProfileEvent);

  // ── finance.events ──────────────────────────────────────────────────────────
  await setupQueue(QUEUES.finance, [
    {
      exchange: "finance.events",
      routingKeys: ["finance.audit.v1"],
    },
  ], handleFinanceEvent);

  // ── events.events (published by events-service) ─────────────────────────────
  await setupQueue(QUEUES.events, [
    {
      exchange: "events.events",
      routingKeys: [
        "events.registration.created.v1",
        "events.registration.confirmed.v1",
        "events.registration.cancelled.v1",
        "events.certificate.issued.v1",
      ],
    },
  ], handleEventsEvent);

  // ── events.events P5 durable attendance audit keys (explicit ack, dedicated queue + channel) ───────
  // Not on audit.events.events: that queue is consumed by the shared middleware consumer, which acks and
  // republishes from an in-memory timer on failure (a crash in the delay loses the event). No new exchange
  // or routing key: the keys are already published on events.events; only a queue binding is added.
  try {
    // Idempotent queue/DLX/binding assertion; re-run before every resubscribe (P5) so a broker that lost
    // its definitions gets them back instead of failing consume with 404.
    const assertAttendanceTopology = async () => {
      await consumer.createQueue(QUEUES.attendance, { durable: true }); // DLX dlx -> audit.events.attendance.dlq; no TTL
      await assertExchangeBindable("events.events");
      await consumer.bindQueue(QUEUES.attendance, "events.events", [...DURABLE_EVENTS_KEYS]);
    };
    await assertAttendanceTopology();
    const handlers = Object.fromEntries(
      DURABLE_EVENTS_KEYS.map((key) => [key, buildDurableAuditHandler({ key, exchange: "events.events", handler: handleEventsEvent })]),
    );
    // P5: resubscribes after a broker/channel drop (the shared middleware reconnects its connection but never
    // re-registers consumers).
    durableConsumer = await startExplicitAckConsumer({ connectionManager, queueName: QUEUES.attendance, handlers, logger, ensureTopology: assertAttendanceTopology });
    logger.info({ queue: QUEUES.attendance, keys: DURABLE_EVENTS_KEYS }, "Durable explicit-ack consumer ready");
  } catch (err) {
    logger.error({ queue: QUEUES.attendance, error: err.message }, "Failed to set up durable explicit-ack consumer");
  }

  // ── issues.events (published by issue-service) ──────────────────────────────
  await setupQueue(QUEUES.issues, [
    {
      exchange: "issues.events",
      routingKeys: ["issues.issue.audit.v1"],
    },
  ], handleIssueAuditEvent);

  logger.info("All audit consumers ready");
}

// Test-only accessor for the live durable consumer handle (real-broker resubscribe test).
export const __durableConsumerForTests = () => durableConsumer;

export async function shutdownEventSystem() {
  try {
    if (durableConsumer) {
      await durableConsumer.stop(); // unacked deliveries return to the broker
      durableConsumer = null;
    }
    await shutdown();
    logger.info("Audit-service RabbitMQ shutdown complete");
  } catch (err) {
    logger.error({ error: err.message }, "Error during shutdown");
  }
}
