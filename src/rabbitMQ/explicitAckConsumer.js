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

export const DEFAULT_RECONNECT = Object.freeze({ initialDelayMs: 1000, maxDelayMs: 30000, connectTimeoutMs: 30000 });

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Start consuming `queueName` on a dedicated channel, and keep it consuming.
 *
 * Resubscription (P5): the shared ConnectionManager re-opens its connection after a broker drop but
 * never re-registers consumers, and this adapter's dedicated channel dies with the old connection. So a
 * channel close that was not requested by stop() schedules a supervised re-open: wait for a live
 * connection (connectionManager.connect(), bounded by connectTimeoutMs because its "wait for the
 * in-flight attempt" branch never settles if that attempt fails), re-assert topology (ensureTopology,
 * idempotent), open a NEW channel, prefetch, consume. Capped exponential backoff, retried until stop().
 * At most one channel/consumer is active at a time; a re-open that finishes after stop() is closed again.
 * Nothing is lost: deliveries unacked on the dead channel are returned to the queue by the broker and
 * redelivered (redelivered=true) to the new consumer - at-least-once; inserts dedupe on (tenant_id, event_id).
 *
 * @param {{ connectionManager: any, queueName: string, handlers: Record<string, Function>, prefetch?: number,
 *   logger?: any, ensureTopology?: () => Promise<void>,
 *   reconnect?: { initialDelayMs?: number, maxDelayMs?: number, connectTimeoutMs?: number } }} opts
 * @returns {Promise<{ channel: any, consumerTag: string, stop: () => Promise<void>, isActive: () => boolean, restarts: () => number }>}
 */
export async function startExplicitAckConsumer({
  connectionManager,
  queueName,
  handlers,
  prefetch = DEFAULT_PREFETCH,
  logger = console,
  ensureTopology = null,
  reconnect = {},
}) {
  if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 50) throw new Error("prefetch must be an integer 1..50");
  const rc = { ...DEFAULT_RECONNECT, ...reconnect };
  let stopped = false;
  let current = null; // { channel, consumerTag }
  let restarting = false;
  let restarts = 0;
  let timer = null;

  async function open() {
    const { connection } = await withTimeout(connectionManager.connect(), rc.connectTimeoutMs, "RabbitMQ connect");
    if (!connection) throw new Error("RabbitMQ connection not available");
    const channel = await connection.createChannel();
    try {
      await channel.prefetch(prefetch);
      channel.on("error", (e) => logger.warn?.({ queueName, error: e?.message }, "[explicit-ack] channel error"));
      channel.on("close", () => {
        if (!current || current.channel !== channel) return; // superseded or never activated
        current = null;
        if (stopped) return;
        logger.warn?.({ queueName }, "[explicit-ack] channel closed; unacked deliveries return to the broker; resubscribing");
        scheduleRestart();
      });
      const { consumerTag } = await channel.consume(
        queueName,
        (msg) => {
          if (!msg) return; // consumer cancelled by the broker (queue deleted): the channel stays open
          handleDelivery(msg, channel, handlers, logger).catch((e) =>
            logger.error?.({ queueName, error: e?.message }, "[explicit-ack] settlement failed; delivery left to the broker"),
          );
        },
        { noAck: false },
      );
      return { channel, consumerTag };
    } catch (e) {
      try {
        await channel.close();
      } catch {
        /* already closed */
      }
      throw e;
    }
  }

  function scheduleRestart() {
    if (restarting || stopped) return;
    restarting = true;
    let delay = rc.initialDelayMs;
    const attempt = () => {
      timer = setTimeout(async () => {
        timer = null;
        if (stopped) {
          restarting = false;
          return;
        }
        try {
          if (ensureTopology) await withTimeout(ensureTopology(), rc.connectTimeoutMs, "topology assert");
          const next = await open();
          if (stopped) {
            try {
              await next.channel.close();
            } catch {
              /* ignore */
            }
            restarting = false;
            return;
          }
          current = next;
          restarts += 1;
          restarting = false;
          logger.info?.({ queueName, prefetch, restarts }, "[explicit-ack] consumer resubscribed");
        } catch (e) {
          delay = Math.min(delay * 2, rc.maxDelayMs);
          logger.warn?.({ queueName, error: e?.message, retryInMs: delay }, "[explicit-ack] resubscribe failed; retrying");
          attempt();
        }
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
    };
    attempt();
  }

  current = await open();
  logger.info?.({ queueName, prefetch }, "[explicit-ack] consumer started");
  return {
    get channel() {
      return current?.channel ?? null;
    },
    get consumerTag() {
      return current?.consumerTag ?? null;
    },
    isActive: () => Boolean(current),
    restarts: () => restarts,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const c = current;
      current = null;
      if (!c) return;
      try {
        await c.channel.cancel(c.consumerTag);
        await c.channel.close();
      } catch {
        /* already closed: unacked deliveries are with the broker */
      }
    },
  };
}
