// P5 attendance audit keys from events-service (transactional outbox, confirmed publish).
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/eventsAttendanceAudit.p5.test.js
//   - the three keys are bound on events.events and mapped (action, resource, actor, before/after);
//   - idempotent: a re-published / redelivered message (same eventId) stores ONE row;
//   - the keys live on their own queue (audit.events.attendance) with an explicit-ack consumer, NOT on
//     the shared audit.events.events queue;
//   - the durable handler resolves only when the row is committed/deduped; a write failure throws a
//     transient error (adapter: one broker redelivery, then DLQ); an un-storable message (no eventId,
//     tenant/context rejected) throws a PERMANENT error (adapter: dead-letter at once) - never acked away;
//   - other keys keep log-and-skip on the shared consumer (unchanged).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-p5att-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, mock, beforeEach } = await import("node:test");
const assert = (await import("node:assert")).default;

// In-memory audit_logs with the real (tenant_id, event_id) uniqueness semantics.
const rows = [];
let failNextInsert = false;
const dbQuery = async (text, params = []) => {
  if (/^\s*SELECT \* FROM audit_logs WHERE tenant_id = \$1 AND event_id = \$2/.test(text)) {
    return { rows: rows.filter((r) => r.tenant_id === params[0] && r.event_id === params[1]).slice(0, 1) };
  }
  if (/^\s*INSERT INTO audit_logs/.test(text)) {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error("connection terminated");
    }
    const [tenant_id, event_type, exchange, service, action, resource_type, resource_id, actor_id, , , event_id, before_state, after_state] = params;
    const existing = rows.find((r) => r.tenant_id === tenant_id && r.event_id === event_id && event_id);
    if (existing) return { rows: [existing] }; // ON CONFLICT (tenant_id, event_id) DO UPDATE ... RETURNING
    const row = { tenant_id, event_type, exchange, service, action, resource_type, resource_id, actor_id, event_id, before_state, after_state };
    rows.push(row);
    return { rows: [row] };
  }
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});

const { handleEventsEvent, DURABLE_EVENTS_KEYS } = await import("../src/rabbitMQ/listeners/events.listener.js");
const { buildAuditKeyHandler, buildDurableAuditHandler } = await import("../src/rabbitMQ/index.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T = "68cbf7806080b4621d469d34";
const OTHER = "6acd6119b28a863c61361ae0";

function envelope(eventType, data, eventId = "att-corr.6752b1f0a1b2c3d4e5f60718") {
  return { eventId, eventType, tenantId: T, timestamp: new Date().toISOString(), correlationId: eventId, data: { tenantId: T, ...data }, metadata: { service: "events-service" } };
}

beforeEach(() => {
  rows.length = 0;
  failNextInsert = false;
});

test("the three keys are bound on events.events to their own explicit-ack queue, not the shared one", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "rabbitMQ", "index.js"), "utf8");
  assert.deepStrictEqual([...DURABLE_EVENTS_KEYS].sort(), [
    "events.attendance.corrected.v1",
    "events.certificate.review_flagged.v1",
    "events.session.schedule_changed.v1",
  ]);
  assert.match(src, /attendance:\s+"audit\.events\.attendance"/);
  assert.match(src, /bindQueue\(QUEUES\.attendance, "events\.events", \[\.\.\.DURABLE_EVENTS_KEYS\]\)/);
  assert.match(src, /startExplicitAckConsumer\(\{ connectionManager, queueName: QUEUES\.attendance/);
  // The shared audit.events.events binding must not carry the durable keys (shared consumer acks+republishes).
  const shared = src.slice(src.indexOf("await setupQueue(QUEUES.events"), src.indexOf("], handleEventsEvent);"));
  assert.ok(shared.length > 0 && !/DURABLE_EVENTS_KEYS/.test(shared));
  assert.doesNotMatch(src, /rethrowKeys|rethrow:/);
});

test("attendance correction: action, registration resource, actor, before = previous entry", async () => {
  await handleEventsEvent(
    envelope("events.attendance.corrected.v1", {
      registrationId: "reg-1",
      sessionId: "ses-1",
      eventId: "ev-1",
      from: { status: "attended", method: "qr-organizer" },
      to: { status: "absent", method: "manual-crm" },
      reason: "Scanned in error",
      actorUserId: "crm-1",
    }),
    "events.attendance.corrected.v1",
    "events.events",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "EVENT_ATTENDANCE_CORRECTED");
  assert.equal(rows[0].resource_type, "registration");
  assert.equal(rows[0].resource_id, "reg-1");
  assert.equal(rows[0].actor_id, "crm-1");
  assert.deepStrictEqual(JSON.parse(rows[0].before_state), { status: "attended", method: "qr-organizer" });
  assert.equal(JSON.parse(rows[0].after_state).reason, "Scanned in error");
});

test("schedule change: session vs event-timezone resource; certificate review: certificate resource", async () => {
  await handleEventsEvent(envelope("events.session.schedule_changed.v1", { scope: "session-update", eventId: "ev-1", sessionId: "ses-1", changes: {} }, "sched.a1"), "events.session.schedule_changed.v1", "events.events");
  await handleEventsEvent(envelope("events.session.schedule_changed.v1", { scope: "event-timezone", eventId: "ev-1", sessionId: null, changes: {} }, "sched.a2"), "events.session.schedule_changed.v1", "events.events");
  await handleEventsEvent(envelope("events.certificate.review_flagged.v1", { certificateId: "cert-1", registrationId: "reg-1" }, "cert-review.a3"), "events.certificate.review_flagged.v1", "events.events");
  assert.deepStrictEqual(rows.map((r) => [r.action, r.resource_type, r.resource_id]), [
    ["EVENT_SCHEDULE_CHANGED", "event_session", "ses-1"],
    ["EVENT_SCHEDULE_CHANGED", "event", "ev-1"],
    ["EVENT_CERTIFICATE_REVIEW_FLAGGED", "certificate", "cert-1"],
  ]);
});

test("idempotent: the same eventId delivered three times (lost confirm / redelivery) stores one row", async () => {
  const msg = envelope("events.attendance.corrected.v1", { registrationId: "reg-1", sessionId: "ses-1", actorUserId: "crm-1" });
  for (let i = 0; i < 3; i += 1) await handleEventsEvent(msg, "events.attendance.corrected.v1", "events.events");
  assert.equal(rows.length, 1);
});

test("durable key without an eventId: PERMANENT error (dead-lettered, never acked away, never stored)", async () => {
  const h = buildDurableAuditHandler({ key: "events.attendance.corrected.v1", exchange: "events.events", handler: handleEventsEvent });
  const msg = envelope("events.attendance.corrected.v1", { registrationId: "reg-1" });
  delete msg.eventId;
  await assert.rejects(() => h(msg, { headers: {} }), (e) => e.permanent === true && e.code === "AUDIT_EVENT_ID_REQUIRED");
  assert.equal(rows.length, 0);
});

test("write failure on a durable key is a TRANSIENT throw (broker redelivery), then the retry stores exactly one row", async () => {
  const h = buildDurableAuditHandler({ key: "events.attendance.corrected.v1", exchange: "events.events", handler: handleEventsEvent });
  const msg = envelope("events.attendance.corrected.v1", { registrationId: "reg-1", sessionId: "ses-1", actorUserId: "crm-1" });
  failNextInsert = true;
  await assert.rejects(() => h(msg, { headers: { "x-tenant-id": T } }), (e) => /connection terminated/.test(e.message) && !e.permanent);
  assert.equal(rows.length, 0);
  await h(msg, { headers: { "x-tenant-id": T } }); // redelivery
  await h(msg, { headers: { "x-tenant-id": T } }); // duplicate redelivery
  assert.equal(rows.length, 1);
});

test("non-durable keys keep log-and-skip on a write failure (unchanged behaviour)", async () => {
  const h = buildAuditKeyHandler({ key: "events.registration.created.v1", exchange: "events.events", handler: handleEventsEvent });
  failNextInsert = true;
  await h(envelope("events.registration.created.v1", { registrationId: "reg-9" }, "evt-created-1"), {});
  assert.equal(rows.length, 0);
});

test("tenant-gate rejection on a durable key: PERMANENT error (dead-letter at once, no retry loop, nothing stored)", async () => {
  const h = buildDurableAuditHandler({ key: "events.attendance.corrected.v1", exchange: "events.events", handler: handleEventsEvent });
  const msg = envelope("events.attendance.corrected.v1", { registrationId: "reg-1" });
  msg.data.tenantId = OTHER; // envelope / data tenant mismatch
  await assert.rejects(() => h(msg, {}), (e) => e.permanent === true && e.code === "AUDIT_EVENT_REJECTED");
  assert.equal(rows.length, 0);
});
