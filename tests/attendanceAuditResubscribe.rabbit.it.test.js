// P5 attendance audit: the explicit-ack consumer RESUBSCRIBES after a broker-side drop. REAL disposable
// RabbitMQ + Postgres only. Skipped unless AUDIT_IT_RABBIT_URL, AUDIT_IT_PG_URL and AUDIT_IT_RABBIT_CONTAINER
// (local throwaway broker container name, for `rabbitmqctl close_all_connections`) are set.
//   D1 broker closes every connection -> consumer comes back; events published while it was down are
//      stored; exactly ONE consumer on the queue afterwards;
//   D2 an in-flight (unacked) event whose handler dies with the connection is redelivered by the broker
//      and stored exactly once (dedupe on tenant_id, event_id); nothing dead-lettered;
//   D3 the dedicated channel alone closing -> resubscribed;
//   D4 repeated drops never accumulate consumers;
//   D5 stop() -> no resubscribe, zero consumers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const RABBIT = process.env.AUDIT_IT_RABBIT_URL;
const PG = process.env.AUDIT_IT_PG_URL;
const CONTAINER = process.env.AUDIT_IT_RABBIT_CONTAINER;
const { test, before, after } = await import("node:test");
const assert = (await import("node:assert")).default;
const skip = (!RABBIT || !PG || !CONTAINER) && "AUDIT_IT_RABBIT_URL / AUDIT_IT_PG_URL / AUDIT_IT_RABBIT_CONTAINER not set (disposable only)";

const QUEUE = "audit.events.attendance";
const DLQ = `${QUEUE}.dlq`;
const KEY = "events.attendance.corrected.v1";
const T = "68cbf7806080b4621d469d34";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let amqp, mw, adapter, idx, db, listener, handle;
let block = null;
let dieAfterBlock = false;

async function waitFor(fn, ms = 30000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* broker momentarily unavailable */
    }
    if (Date.now() > until) return false;
    await sleep(200);
  }
}
const rowsFor = async (eventId) => (await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event_id = $2", [T, eventId])).rows[0].n;
const killAllConnections = () =>
  execFileSync("docker", ["exec", CONTAINER, "rabbitmqctl", "-q", "close_all_connections", "p5-it-drop"], { stdio: "ignore" });

async function withAdmin(fn) {
  const conn = await amqp.connect(RABBIT);
  try {
    const ch = await conn.createConfirmChannel();
    return await fn(ch);
  } finally {
    await conn.close().catch(() => {});
  }
}
const queueState = () => withAdmin(async (ch) => {
  const q = await ch.checkQueue(QUEUE);
  const d = await ch.checkQueue(DLQ);
  return { ready: q.messageCount, consumers: q.consumerCount, dlq: d.messageCount };
});
function publish(eventId) {
  return withAdmin(async (ch) => {
    const env = { eventId, eventType: KEY, tenantId: T, timestamp: new Date().toISOString(), correlationId: eventId,
      data: { tenantId: T, registrationId: "6752b1f0a1b2c3d4e5f60718", sessionId: "6752b1f0a1b2c3d4e5f60719", eventId: "6752b1f0a1b2c3d4e5f6071a",
        actorUserId: "6752b1f0a1b2c3d4e5f6071c" }, metadata: { service: "events-service" } };
    ch.publish("events.events", KEY, Buffer.from(JSON.stringify(env)), { persistent: true, contentType: "application/json", headers: { "x-tenant-id": T } });
    await ch.waitForConfirms();
  });
}

before(async () => {
  if (skip) return;
  process.env.LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "audit-it-"));
  process.env.NODE_ENV = "test";
  process.env.POSTGRES_URI = PG;
  process.env.DB_RETRIES = "3";
  process.env.DB_RETRY_DELAY = "500";
  process.env.RABBIT_URL = RABBIT; // the middleware's own reconnect path reads RABBIT_URL (no config)
  amqp = (await import("amqplib")).default;
  mw = await import("@projectShell/rabbitmq-middleware");
  adapter = await import("../src/rabbitMQ/explicitAckConsumer.js");
  idx = await import("../src/rabbitMQ/index.js");
  listener = await import("../src/rabbitMQ/listeners/events.listener.js");
  const { runMigrations } = await import("../src/db/migrate.js");
  db = await import("../src/config/db.js");
  await runMigrations();
  await mw.init({ url: RABBIT, reconnectDelay: 300, maxReconnectAttempts: 50, logger: { info() {}, warn() {}, error() {} },
    exchanges: [{ name: "events.events", type: "topic", options: { durable: true } }] });
  const ensureTopology = async () => {
    await mw.consumer.createQueue(QUEUE, { durable: true });
    await mw.consumer.bindQueue(QUEUE, "events.events", [...listener.DURABLE_EVENTS_KEYS]);
  };
  await ensureTopology();
  await withAdmin(async (ch) => { await ch.purgeQueue(QUEUE); await ch.purgeQueue(DLQ); });
  await db.query("DELETE FROM audit_logs WHERE tenant_id = $1", [T]);
  const handlers = Object.fromEntries(
    listener.DURABLE_EVENTS_KEYS.map((key) => {
      const h = idx.buildDurableAuditHandler({ key, exchange: "events.events", handler: listener.handleEventsEvent });
      return [key, async (p, c) => {
        if (block) {
          await block;
          if (dieAfterBlock) { dieAfterBlock = false; throw new Error("simulated: worker died before commit"); }
        }
        return h(p, c);
      }];
    }),
  );
  handle = await adapter.startExplicitAckConsumer({ connectionManager: mw.connectionManager, queueName: QUEUE, handlers,
    logger: { info() {}, warn() {}, error() {} }, ensureTopology, reconnect: { initialDelayMs: 300, maxDelayMs: 2000 } });
  assert.equal((await queueState()).consumers, 1);
});

after(async () => {
  try { await handle?.stop(); } catch {}
  try { await db?.closeDB?.(); } catch {}
  try { await mw?.shutdown?.(); } catch {}
});

test("D1 broker closes all connections -> resubscribed; events published while down are stored; one consumer", { skip }, async () => {
  const E0 = "att-corr.d1-before-" + Date.now();
  await publish(E0);
  assert.ok(await waitFor(async () => (await rowsFor(E0)) === 1));
  killAllConnections();
  const E1 = "att-corr.d1-during-" + Date.now();
  await publish(E1); // queued while the consumer is gone
  assert.ok(await waitFor(async () => (await rowsFor(E1)) === 1), "event queued during the outage stored after resubscribe");
  assert.ok(await waitFor(async () => (await queueState()).consumers === 1), "exactly one consumer");
  const s = await queueState();
  assert.equal(s.ready, 0);
  assert.equal(s.dlq, 0);
});

test("D2 in-flight event whose handler dies with the connection -> redelivered, stored exactly once", { skip }, async () => {
  let release;
  block = new Promise((r) => (release = r));
  dieAfterBlock = true;
  const E = "att-corr.d2-inflight-" + Date.now();
  await publish(E);
  assert.ok(await waitFor(async () => (await queueState()).ready === 0), "delivered, unacked");
  assert.equal(await rowsFor(E), 0, "nothing committed while in flight");
  killAllConnections();
  block = null;
  release();
  assert.ok(await waitFor(async () => (await rowsFor(E)) === 1), "stored via the broker's redelivery");
  await sleep(500);
  assert.equal(await rowsFor(E), 1, "exactly one row");
  assert.ok(await waitFor(async () => (await queueState()).consumers === 1));
  const s = await queueState();
  assert.equal(s.ready, 0);
  assert.equal(s.dlq, 0, "not dead-lettered");
});

test("D3 dedicated channel alone closing -> resubscribed", { skip }, async () => {
  const before = handle.restarts();
  await handle.channel.close();
  assert.ok(await waitFor(async () => handle.restarts() === before + 1 && handle.isActive()));
  assert.ok(await waitFor(async () => (await queueState()).consumers === 1));
  const E = "att-corr.d3-after-" + Date.now();
  await publish(E);
  assert.ok(await waitFor(async () => (await rowsFor(E)) === 1));
});

test("D4 repeated drops never accumulate consumers", { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    killAllConnections();
    assert.ok(await waitFor(async () => (await queueState()).consumers === 1), `one consumer after drop ${i + 1}`);
  }
  const E = "att-corr.d4-after-" + Date.now();
  await publish(E);
  assert.ok(await waitFor(async () => (await rowsFor(E)) === 1));
  assert.equal((await queueState()).consumers, 1);
});

test("D5 stop() -> no resubscribe, zero consumers", { skip }, async () => {
  await handle.stop();
  await sleep(1500);
  assert.equal((await queueState()).consumers, 0);
});
