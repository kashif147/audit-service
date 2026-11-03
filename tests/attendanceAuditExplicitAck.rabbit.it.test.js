// P5 attendance audit: explicit-ack consumer against a REAL RabbitMQ and a REAL Postgres (both
// disposable; never a shared environment). Skipped unless AUDIT_IT_RABBIT_URL and AUDIT_IT_PG_URL are set:
//   docker run -d --name it-rabbit --user 999:999 -e HOME=/tmp/rmq ... rabbitmq:3.13-management
//   docker run -d --name it-pg -e POSTGRES_PASSWORD=... -p 127.0.0.1:<port>:5432 postgres:16-alpine
// Run: node --test --test-force-exit tests/attendanceAuditExplicitAck.rabbit.it.test.js
// Proves, with the real middleware createQueue/DLX setup, the real adapter, the real durable handler and
// the real createAuditLog (migrated schema, (tenant_id, event_id) unique index):
//   R1 consumer SIGKILLed after receipt but BEFORE the row commit -> the event stays in the broker, is
//      redelivered to the next consumer and stored exactly once; a later duplicate publish adds no row;
//   R2 the insert keeps failing (table unavailable) -> ONE broker redelivery, then dead-lettered to
//      audit.events.attendance.dlq; the main queue is empty and nothing loops; the event is retained;
//   R3 one event of each durable key -> exactly one row each (no lost correction / review event).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const RABBIT = process.env.AUDIT_IT_RABBIT_URL;
const PG = process.env.AUDIT_IT_PG_URL;
const { test, before, after } = await import("node:test");
const assert = (await import("node:assert")).default;
const skip = (!RABBIT || !PG) && "AUDIT_IT_RABBIT_URL / AUDIT_IT_PG_URL not set (disposable broker + Postgres only)";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = "audit.events.attendance";
const DLQ = `${QUEUE}.dlq`;
const T = "68cbf7806080b4621d469d34";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let amqp, pub, mw, adapter, idx, db, listener;
const consumers = [];

async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await sleep(100);
  }
}
const depth = async () => [(await pub.checkQueue(QUEUE)).messageCount, (await pub.checkQueue(DLQ)).messageCount];
const rowsFor = async (eventId) => (await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event_id = $2", [T, eventId])).rows[0].n;
function publish(key, eventId, data = {}) {
  const env = { eventId, eventType: key, tenantId: T, timestamp: new Date().toISOString(), correlationId: eventId,
    data: { tenantId: T, registrationId: "6752b1f0a1b2c3d4e5f60718", sessionId: "6752b1f0a1b2c3d4e5f60719", eventId: "6752b1f0a1b2c3d4e5f6071a",
      certificateId: "6752b1f0a1b2c3d4e5f6071b", actorUserId: "6752b1f0a1b2c3d4e5f6071c", ...data }, metadata: { service: "events-service" } };
  pub.publish("events.events", key, Buffer.from(JSON.stringify(env)), { persistent: true, contentType: "application/json", headers: { "x-tenant-id": T } });
  return pub.waitForConfirms();
}
async function startRealConsumer(onCall = () => {}) {
  const handlers = Object.fromEntries(
    listener.DURABLE_EVENTS_KEYS.map((key) => {
      const h = idx.buildDurableAuditHandler({ key, exchange: "events.events", handler: listener.handleEventsEvent });
      return [key, async (p, c) => { onCall(p, c); return h(p, c); }];
    }),
  );
  const c = await adapter.startExplicitAckConsumer({ connectionManager: mw.connectionManager, queueName: QUEUE, handlers, logger: { info() {}, warn() {}, error() {} } });
  consumers.push(c);
  return c;
}

before(async () => {
  if (skip) return;
  process.env.LOG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "audit-it-"));
  process.env.NODE_ENV = "test";
  process.env.POSTGRES_URI = PG;
  process.env.DB_RETRIES = "3";
  process.env.DB_RETRY_DELAY = "500";
  amqp = (await import("amqplib")).default;
  mw = await import("@projectShell/rabbitmq-middleware");
  adapter = await import("../src/rabbitMQ/explicitAckConsumer.js");
  idx = await import("../src/rabbitMQ/index.js");
  listener = await import("../src/rabbitMQ/listeners/events.listener.js");
  const { runMigrations } = await import("../src/db/migrate.js");
  db = await import("../src/config/db.js");
  await runMigrations();
  await mw.init({ url: RABBIT, exchanges: [{ name: "events.events", type: "topic", options: { durable: true } }] });
  // Same setup as setupConsumers(): durable queue + DLX/DLQ, bound to the three durable keys only.
  await mw.consumer.createQueue(QUEUE, { durable: true });
  await mw.consumer.bindQueue(QUEUE, "events.events", [...listener.DURABLE_EVENTS_KEYS]);
  const conn = await amqp.connect(RABBIT);
  pub = await conn.createConfirmChannel();
  await pub.purgeQueue(QUEUE); // disposable broker only
  await pub.purgeQueue(DLQ);
  await db.query("DELETE FROM audit_logs WHERE tenant_id = $1", [T]);
});

after(async () => {
  for (const c of consumers) await c.stop();
  try { await db?.closeDB?.(); } catch {}
  try { await mw?.shutdown?.(); } catch {}
});

test("R1 SIGKILL before the row commit -> retained by the broker, redelivered, stored exactly once", { skip }, async () => {
  const E = "att-corr.it-r1-" + Date.now();
  await publish("events.attendance.corrected.v1", E);
  const child = spawn(process.execPath, [path.join(__dirname, "helpers", "auditExplicitAckCrashChild.js")], {
    env: { ...process.env, AUDIT_IT_QUEUE: QUEUE, AUDIT_IT_RABBIT_URL: RABBIT },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  assert.ok(await waitFor(() => out.includes(`RECEIVED ${E}`)), "child received the event");
  assert.equal(await rowsFor(E), 0, "no row before commit");
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  assert.ok(await waitFor(async () => (await depth())[0] === 1), "event back in the main queue after the crash");
  let redeliveredSeen = false;
  await startRealConsumer((p, c) => { if (p.eventId === E && c.redelivered) redeliveredSeen = true; });
  assert.ok(await waitFor(async () => (await rowsFor(E)) === 1), "stored after redelivery");
  assert.ok(redeliveredSeen, "the next consumer saw redelivered=true");
  assert.ok(await waitFor(async () => (await depth()).join("/") === "0/0"));
  await publish("events.attendance.corrected.v1", E); // duplicate publish (lost confirm) -> dedupe
  assert.ok(await waitFor(async () => (await depth())[0] === 0));
  await sleep(300);
  assert.equal(await rowsFor(E), 1, "duplicate adds no row");
  for (const c of consumers.splice(0)) await c.stop();
});

test("R2 insert keeps failing -> one broker redelivery, then dead-lettered; main queue empty, event retained", { skip }, async () => {
  const E = "att-corr.it-r2-" + Date.now();
  await db.query("ALTER TABLE audit_logs RENAME TO audit_logs_it_off");
  try {
    let calls = 0;
    await startRealConsumer((p) => { if (p.eventId === E) calls += 1; });
    await publish("events.attendance.corrected.v1", E);
    assert.ok(await waitFor(async () => (await depth())[1] === 1), "dead-lettered");
    await sleep(500);
    assert.equal(calls, 2, "exactly one redelivery (no loop)");
    assert.equal((await depth())[0], 0, "main queue empty");
  } finally {
    for (const c of consumers.splice(0)) await c.stop();
    await db.query("ALTER TABLE audit_logs_it_off RENAME TO audit_logs");
  }
  assert.equal(await rowsFor(E), 0);
  const m = await pub.get(DLQ, { noAck: false }); // inspect the retained dead letter, then requeue it untouched
  assert.ok(m, "dead letter present");
  assert.equal(JSON.parse(m.content.toString()).eventId, E);
  pub.nack(m, false, true);
});

test("R3 one event of each durable key -> exactly one row each (no lost correction / review event)", { skip }, async () => {
  await startRealConsumer();
  const ids = {};
  for (const key of listener.DURABLE_EVENTS_KEYS) {
    ids[key] = `it-r3.${key}.${Date.now()}`;
    await publish(key, ids[key], key === "events.attendance.corrected.v1" ? { from: { status: "attended" }, to: { status: "absent" } } : {});
  }
  for (const key of listener.DURABLE_EVENTS_KEYS) {
    assert.ok(await waitFor(async () => (await rowsFor(ids[key])) === 1), `${key} stored once`);
  }
  assert.equal((await depth())[0], 0);
});
