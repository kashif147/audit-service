// Child process for the real-broker crash test (tests/attendanceAuditExplicitAck.rabbit.it.test.js).
// Consumes audit.events.attendance with the REAL explicit-ack adapter, but the handler blocks forever
// after receipt - BEFORE the audit row is written - so the parent can SIGKILL it mid-delivery.
// Disposable broker / Postgres only (env AUDIT_IT_RABBIT_URL); prints "RECEIVED <eventId>" on stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-it-child-"));
const { init, connectionManager } = await import("@projectShell/rabbitmq-middleware");
const { startExplicitAckConsumer } = await import("../../src/rabbitMQ/explicitAckConsumer.js");

const QUEUE = process.env.AUDIT_IT_QUEUE;
await init({ url: process.env.AUDIT_IT_RABBIT_URL, exchanges: [{ name: "events.events", type: "topic", options: { durable: true } }] });
const block = (payload) =>
  new Promise(() => {
    process.stdout.write(`RECEIVED ${payload.eventId}\n`); // never resolves: no row written, no ack
  });
await startExplicitAckConsumer({
  connectionManager,
  queueName: QUEUE,
  handlers: { "events.attendance.corrected.v1": block },
  logger: { info() {}, warn() {}, error() {} },
});
process.stdout.write("READY\n");
