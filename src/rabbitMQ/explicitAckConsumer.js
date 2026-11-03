/**
 * P5: explicit-acknowledgement consumer for ONE queue (audit.events.attendance: the three durable
 * attendance-audit keys published by events-service's transactional outbox).
 *
 * Why not the shared rabbitmq-middleware consumer: on a handler error it acks the delivery and
 * republishes a copy from an in-process setTimeout (x-retry-count). A crash inside that delay loses the
 * event. This adapter keeps every delivery owned by the broker until the audit row is committed:
 *
 *   handler resolves                     -> ack                 (row inserted, or an existing row = dedupe hit)
 *   handler throws err.permanent         -> nack(requeue=false)  dead-lettered at once (can never succeed:
 *                                                                tenant rejected, no eventId) - kept, not lost
 *   handler throws, first delivery       -> nack(requeue=true)   ONE broker-side redelivery (no timer, no copy)
 *   handler throws, redelivered          -> nack(requeue=false)  dead-lettered by the broker to <queue>.dlq
 *   unparseable / unknown event type     -> nack(requeue=false)  dead-lettered (never acked away)
 *   process/connection/channel dies      -> nothing settled; the broker redelivers (redelivered=true)
 *
 * Bounded by the broker's own `redelivered` flag (one immediate requeue, no loop, no in-memory retry).
 * Each delivery is settled exactly once. Uses a DEDICATED channel on the middleware's connection, so its
 * prefetch is independent of the shared channel and it never touches the shared consumer's handler map.
 * Redelivery is idempotent: createAuditLog dedupes on (tenant_id, event_id).
 *
 * Logs carry the event type, event id, outcome and redelivered flag only - never the payload.
 * Modelled on subscription-service rabbitMQ/explicitAckConsumer.js (P5 #29).
 */

export const DEFAULT_PREFETCH = 5;

function settleOnce(channel, msg) {
  let done = false;
  return (op, ...args) => {
    if (done) return false;
    done = true;
    channel[op](msg, ...args);
    return true;
  };
}

function safeLogId(v) {
  const s = v == null ? "" : String(v);
  return /^[A-Za-z0-9._:-]{1,128}$/.test(s) ? s : null;
}

/** An error the handler raises for a message that can never be stored (dead-letter, do not retry). */
export function permanentError(message, code) {
  const err = new Error(message);
  err.permanent = true;
  if (code) err.code = code;
  return err;
}

/**
 * Decide and apply the settlement for one delivery. Exported for tests (fake channel).
 * @returns {Promise<"ack"|"requeue"|"dead-letter">}
 */
export async function handleDelivery(msg, channel, handlers, logger = console) {
  const settle = settleOnce(channel, msg);
  const redelivered = Boolean(msg?.fields?.redelivered);
  let payload;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch {
    settle("nack", false, false);
    logger.error?.({ redelivered }, "[explicit-ack] unparseable message dead-lettered");
    return "dead-letter";
  }
  const eventType = typeof payload?.eventType === "string" ? payload.eventType : null;
  const eventId = safeLogId(payload?.eventId);
  const handler = eventType && Object.prototype.hasOwnProperty.call(handlers, eventType) ? handlers[eventType] : null;
  if (typeof handler !== "function") {
    settle("nack", false, false);
    logger.error?.({ eventType: safeLogId(eventType), eventId }, "[explicit-ack] no handler; dead-lettered");
    return "dead-letter";
  }
  try {
    await handler(payload, {
      redelivered,
      routingKey: msg.fields?.routingKey,
      exchange: msg.fields?.exchange,
      headers: msg.properties?.headers,
    });
  } catch (err) {
    if (err?.permanent) {
      settle("nack", false, false);
      logger.error?.({ eventType, eventId, code: err.code || null }, "[explicit-ack] permanent failure; dead-lettered");
      return "dead-letter";
    }
    if (!redelivered) {
      settle("nack", false, true);
      logger.warn?.({ eventType, eventId, error: err?.name || "Error" }, "[explicit-ack] handler failed; one broker redelivery");
      return "requeue";
    }
    settle("nack", false, false);
    logger.error?.({ eventType, eventId, error: err?.name || "Error" }, "[explicit-ack] handler failed on redelivery; dead-lettered");
    return "dead-letter";
  }
  settle("ack");
  return "ack";
}

/**
 * Start consuming `queueName` on a dedicated channel.
 * @param {{ connectionManager: any, queueName: string, handlers: Record<string, Function>, prefetch?: number, logger?: any }} opts
 * @returns {Promise<{ channel: any, consumerTag: string, stop: () => Promise<void> }>}
 */
export async function startExplicitAckConsumer({ connectionManager, queueName, handlers, prefetch = DEFAULT_PREFETCH, logger = console }) {
  if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 50) throw new Error("prefetch must be an integer 1..50");
  const { connection } = await connectionManager.connect();
  if (!connection) throw new Error("RabbitMQ connection not available");
  const channel = await connection.createChannel();
  await channel.prefetch(prefetch);
  channel.on("error", (e) => logger.warn?.({ queueName, error: e?.message }, "[explicit-ack] channel error"));
  channel.on("close", () => logger.warn?.({ queueName }, "[explicit-ack] channel closed; unacked deliveries return to the broker"));
  const { consumerTag } = await channel.consume(
    queueName,
    (msg) => {
      if (!msg) return; // consumer cancelled by the broker
      handleDelivery(msg, channel, handlers, logger).catch((e) =>
        logger.error?.({ queueName, error: e?.message }, "[explicit-ack] settlement failed; delivery left to the broker"),
      );
    },
    { noAck: false },
  );
  logger.info?.({ queueName, prefetch }, "[explicit-ack] consumer started");
  return {
    channel,
    consumerTag,
    stop: async () => {
      try {
        await channel.cancel(consumerTag);
        await channel.close();
      } catch {
        /* already closed: unacked deliveries are with the broker */
      }
    },
  };
}
