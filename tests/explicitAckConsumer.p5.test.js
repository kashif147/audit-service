// P5 audit explicit-ack adapter: settlement decisions against a fake channel (no broker).
// Native node:test (ESM). Run: node --test tests/explicitAckConsumer.p5.test.js
//   E1 handler resolves -> exactly one ack, nothing else
//   E2 transient failure, first delivery -> one nack(requeue=true); never ack
//   E3 transient failure, redelivered -> one nack(requeue=false) (dead-letter); never ack
//   E4 permanent failure -> dead-letter at once, even on the first delivery; never ack
//   E5 unparseable / unknown eventType / prototype key -> dead-letter; never ack
//   E6 nothing is settled while the handler is still running (a crash then leaves it with the broker)
//   E7 handler receives headers/routingKey/exchange; logs never carry the payload
import { test } from "node:test";
import assert from "node:assert";
import { handleDelivery, permanentError } from "../src/rabbitMQ/explicitAckConsumer.js";

function fakeChannel() {
  const calls = [];
  return {
    calls,
    ack: (m) => calls.push(["ack"]),
    nack: (m, allUpTo, requeue) => calls.push(["nack", requeue]),
  };
}
const SENTINEL = "P5-SENTINEL-PAYLOAD-VALUE";
function msg(payload, { redelivered = false, raw } = {}) {
  return {
    content: Buffer.from(raw ?? JSON.stringify(payload)),
    fields: { redelivered, routingKey: payload?.eventType, exchange: "events.events" },
    properties: { headers: { "x-tenant-id": "68cbf7806080b4621d469d34" } },
  };
}
const KEY = "events.attendance.corrected.v1";
const body = { eventType: KEY, eventId: "att-corr.1", data: { note: SENTINEL } };
function capturingLogger() {
  const lines = [];
  const rec = (...a) => lines.push(JSON.stringify(a));
  return { lines, info: rec, warn: rec, error: rec };
}

test("E1 success -> exactly one ack", async () => {
  const ch = fakeChannel();
  const out = await handleDelivery(msg(body), ch, { [KEY]: async () => {} }, capturingLogger());
  assert.equal(out, "ack");
  assert.deepStrictEqual(ch.calls, [["ack"]]);
});

test("E2 transient failure on first delivery -> one requeue, never ack", async () => {
  const ch = fakeChannel();
  const out = await handleDelivery(msg(body), ch, { [KEY]: async () => { throw new Error("pg down"); } }, capturingLogger());
  assert.equal(out, "requeue");
  assert.deepStrictEqual(ch.calls, [["nack", true]]);
});

test("E3 transient failure on redelivery -> dead-letter, never ack", async () => {
  const ch = fakeChannel();
  const out = await handleDelivery(msg(body, { redelivered: true }), ch, { [KEY]: async () => { throw new Error("pg down"); } }, capturingLogger());
  assert.equal(out, "dead-letter");
  assert.deepStrictEqual(ch.calls, [["nack", false]]);
});

test("E4 permanent failure -> dead-letter at once on the first delivery, never ack", async () => {
  const ch = fakeChannel();
  const out = await handleDelivery(msg(body), ch, { [KEY]: async () => { throw permanentError("rejected", "AUDIT_EVENT_REJECTED"); } }, capturingLogger());
  assert.equal(out, "dead-letter");
  assert.deepStrictEqual(ch.calls, [["nack", false]]);
});

test("E5 unparseable, unknown eventType and prototype keys -> dead-letter, never ack", async () => {
  for (const m of [
    msg(null, { raw: "{not json" }),
    msg({ eventType: "events.unknown.v1", eventId: "x" }),
    msg({ eventType: "__proto__", eventId: "x" }),
    msg({ eventType: "constructor", eventId: "x" }),
    msg({ eventId: "x" }),
  ]) {
    const ch = fakeChannel();
    assert.equal(await handleDelivery(m, ch, { [KEY]: async () => {} }, capturingLogger()), "dead-letter");
    assert.deepStrictEqual(ch.calls, [["nack", false]]);
  }
});

test("E6 nothing is settled while the handler is still running", async () => {
  const ch = fakeChannel();
  let release;
  const pending = handleDelivery(msg(body), ch, { [KEY]: () => new Promise((r) => (release = r)) }, capturingLogger());
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ch.calls, []); // a crash here leaves the delivery unacked with the broker
  release();
  await pending;
  assert.deepStrictEqual(ch.calls, [["ack"]]);
});

test("E7 handler context carries headers/routingKey/exchange; logs never carry the payload", async () => {
  const ch = fakeChannel();
  const log = capturingLogger();
  let ctx;
  await handleDelivery(msg(body), ch, { [KEY]: async (_p, c) => { ctx = c; throw new Error("boom"); } }, log);
  assert.equal(ctx.headers["x-tenant-id"], "68cbf7806080b4621d469d34");
  assert.equal(ctx.routingKey, KEY);
  assert.equal(ctx.exchange, "events.events");
  assert.equal(ctx.redelivered, false);
  assert.ok(log.lines.length > 0);
  assert.ok(log.lines.every((l) => !l.includes(SENTINEL)));
});
