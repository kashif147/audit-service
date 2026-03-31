import {
  init,
  consumer,
  connectionManager,
  shutdown,
} from "@projectShell/rabbitmq-middleware";
import logger from "../config/logger.js";

import { handleUserEvent }         from "./listeners/user.listener.js";
import { handleApplicationEvent }  from "./listeners/application.listener.js";
import { handleMembershipEvent }   from "./listeners/membership.listener.js";
import { handleProductEvent }      from "./listeners/product.listener.js";
import { handleBatchEvent }        from "./listeners/batch.listener.js";
import { handleJournalEvent }      from "./listeners/journal.listener.js";

// ── Queues ────────────────────────────────────────────────────────────────────
const QUEUES = {
  user:        "audit.user.events",
  application: "audit.application.events",
  membership:  "audit.membership.events",
  product:     "audit.product.events",
  batch:       "audit.batch.events",
  journal:     "audit.journal.events",
};

export async function initEventSystem() {
  await init({
    url:            process.env.RABBIT_URL,
    logger,
    prefetch:       10,
    connectionName: "audit-service",
    serviceName:    "audit-service",
  });
  logger.info("RabbitMQ initialised for audit-service");
}

export async function setupConsumers() {
  // ── Helper ──────────────────────────────────────────────────────────────────
  async function assertExchange(name, type = "topic") {
    try {
      const ch = await connectionManager.getNamedChannel("consumer", 10);
      await ch.assertExchange(name, type, { durable: true });
    } catch (err) {
      logger.warn({ exchange: name, error: err.message }, "Could not assert exchange");
    }
  }

  async function setupQueue(queueName, exchange, routingKeys, handler) {
    try {
      await consumer.createQueue(queueName, { durable: true, messageTtl: 3_600_000 });
      await assertExchange(exchange);
      await consumer.bindQueue(queueName, exchange, routingKeys);

      for (const key of routingKeys) {
        consumer.registerHandler(key, async (payload) => {
          try {
            await handler(payload, key, exchange);
          } catch (err) {
            logger.error({ eventType: key, error: err.message }, "Audit handler error");
          }
        });
      }

      await consumer.consume(queueName, { prefetch: 10 });
      logger.info({ queue: queueName, exchange, routingKeys }, "Consumer ready");
    } catch (err) {
      logger.error({ queue: queueName, error: err.message }, "Failed to set up consumer");
    }
  }

  // ── user.events ─────────────────────────────────────────────────────────────
  await setupQueue(
    QUEUES.user,
    "user.events",
    ["user.crm.created.v1", "user.crm.updated.v1",
     "user.portal.created.v1", "user.portal.updated.v1"],
    handleUserEvent
  );

  // ── application.events ──────────────────────────────────────────────────────
  await setupQueue(
    QUEUES.application,
    "application.events",
    ["applications.review.approved.v1",
     "applications.review.rejected.v1",
     "application.status.submitted.v1"],
    handleApplicationEvent
  );

  // ── membership.events ───────────────────────────────────────────────────────
  await setupQueue(
    QUEUES.membership,
    "membership.events",
    ["members.subscription.current.updated.v1",
     "members.subscription.resigned.v1",
     "members.subscription.resignation.undone.v1",
     "members.subscription.cancel.grace.ended.v1"],
    handleMembershipEvent
  );

  // ── product.events ──────────────────────────────────────────────────────────
  await setupQueue(
    QUEUES.product,
    "product.events",
    ["product.type.created.v1", "product.type.updated.v1", "product.type.deleted.v1",
     "product.created.v1",      "product.updated.v1",      "product.deleted.v1",
     "pricing.created.v1",      "pricing.updated.v1",      "pricing.deleted.v1"],
    handleProductEvent
  );

  // ── batch.events ─────────────────────────────────────────────────────────────
  await setupQueue(
    QUEUES.batch,
    "batch.events",
    ["batch.completed"],
    handleBatchEvent
  );

  // ── journal.events (published by account-service) ───────────────────────────
  await setupQueue(
    QUEUES.journal,
    "journal.events",
    ["journal.created.v1"],
    handleJournalEvent
  );

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
