import { init, consumer, shutdown } from "@projectShell/rabbitmq-middleware";
import logger from "../config/logger.js";
import bizLogger from "../config/bizLogger.js";
import { createRabbitStructuredLogHandlers } from "@projectShell/logging-lib";

import { handleUserEvent }         from "./listeners/user.listener.js";
import { handleApplicationEvent }  from "./listeners/application.listener.js";
import { handleMembershipEvent }   from "./listeners/membership.listener.js";
import { handleProductEvent }      from "./listeners/product.listener.js";
import { handleBatchEvent }        from "./listeners/batch.listener.js";
import { handleJournalEvent }      from "./listeners/journal.listener.js";
import { handleProfileEvent }      from "./listeners/profile.listener.js";

// ── Queues ────────────────────────────────────────────────────────────────────
const QUEUES = {
  user:        "audit.user.events",
  application: "audit.application.events",
  membership:  "audit.membership.events",
  product:     "audit.product.events",
  batch:       "audit.batch.events",
  journal:     "audit.journal.events",
  profile:     "audit.profile.events",
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
   */
  async function setupQueue(queueName, bindings, handler) {
    try {
      if (!bindings?.length) throw new Error("bindings required");

      await consumer.createQueue(queueName, { durable: true, messageTtl: 3_600_000 });

      const routingKeyExchange = new Map();

      for (const { exchange, routingKeys } of bindings) {
        await consumer.bindQueue(queueName, exchange, routingKeys);
        for (const rk of routingKeys) {
          if (!routingKeyExchange.has(rk)) routingKeyExchange.set(rk, exchange);
        }
      }

      const allKeys = [...routingKeyExchange.keys()];
      for (const key of allKeys) {
        const boundExchange = routingKeyExchange.get(key);
        consumer.registerHandler(key, async (payload) => {
          try {
            await handler(payload, key, boundExchange);
          } catch (err) {
            logger.error({ eventType: key, error: err.message }, "Audit handler error");
          }
        });
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

  // application.events: approvals/rejections (+ optional .v1 submission if introduced).
  // accounts.events: account-service publishes application.status.submitted here (middleware mapping).
  await setupQueue(QUEUES.application, [
    {
      exchange: "application.events",
      routingKeys: [
        "applications.review.approved.v1",
        "applications.review.rejected.v1",
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
    { exchange: "batch.events", routingKeys: ["batch.completed"] },
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
      routingKeys: ["profile.created", "profile.updated", "profile.deleted"],
    },
  ], handleProfileEvent);

  logger.info("All audit consumers ready");
}

export async function shutdownEventSystem() {
  try {
    await shutdown();
    logger.info("Audit-service RabbitMQ shutdown complete");
  } catch (err) {
    logger.error({ error: err.message }, "Error during shutdown");
  }
}
