// Phase A / A1 — audit rows are tenant-owned; the tenant comes only from trusted sources.
// Native node:test (ESM). Run: node --test tests/auditTenant.a1.test.js
//   - RabbitMQ: envelope tenant canonical, data/header must agree, placeholders rejected,
//     rejected events are skipped (no handler call, no throw) — never written as "unknown".
//   - POST /internal/audit-logs: tenant from x-internal-request + x-tenant-id only; a body tenantId
//     can never decide ownership.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-a1-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SERVICE_AUDIT_SECRET = "test-only-audit-secret";

const test = (await import("node:test")).default;
const assert = (await import("node:assert")).default;
const { resolveAuditEventTenant, runTenantGatedHandler } = await import("../src/rabbitMQ/eventTenant.js");
const { createAuditLog } = await import("../src/models/auditLog.model.js");
const { postInternalAuditLog } = await import("../src/controllers/internalAudit.controller.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";

const mkRes = () => {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const internalReq = ({ headers = {}, body = { action: "CAMPAIGN_SENT" } } = {}) => ({
  headers: {
    "x-service-secret": "test-only-audit-secret",
    "x-internal-request": "true",
    "x-tenant-id": A,
    ...headers,
  },
  body,
});

// ── resolver ──────────────────────────────────────────────────────────────────
test("envelope tenant is accepted", () => {
  assert.deepStrictEqual(resolveAuditEventTenant({ tenantId: A, data: {} }), { ok: true, tenantId: A });
});
test("data tenant is the fallback when the envelope has none", () => {
  assert.deepStrictEqual(resolveAuditEventTenant({ data: { tenantId: A } }), { ok: true, tenantId: A });
});
test("envelope, data and header agreeing are accepted", () => {
  const r = resolveAuditEventTenant({ tenantId: A, data: { tenantId: A } }, { headerTenantId: A });
  assert.deepStrictEqual(r, { ok: true, tenantId: A });
});
test("envelope vs data mismatch is rejected", () => {
  assert.deepStrictEqual(resolveAuditEventTenant({ tenantId: A, data: { tenantId: B } }), { ok: false, reason: "mismatch" });
});
test("header disagreeing with the envelope is rejected", () => {
  assert.deepStrictEqual(resolveAuditEventTenant({ tenantId: A }, { headerTenantId: B }), { ok: false, reason: "mismatch" });
});
test("no tenant anywhere is rejected", () => {
  assert.deepStrictEqual(resolveAuditEventTenant({ data: {} }), { ok: false, reason: "missing" });
  assert.deepStrictEqual(resolveAuditEventTenant({ tenantId: "  " }), { ok: false, reason: "missing" });
});
test("placeholder tenants are rejected as malformed", () => {
  for (const v of ["unknown", "UNKNOWN", "default", "system", "null", "a b"]) {
    assert.deepStrictEqual(resolveAuditEventTenant({ tenantId: v }), { ok: false, reason: "malformed" }, v);
  }
});

// ── gate (what the consumer wrapper runs) ─────────────────────────────────────
const fakeLog = () => {
  const calls = [];
  return { calls, warn: (o, m) => calls.push({ o, m }) };
};
test("gate: missing tenant -> handler NOT called, rejection logged, no throw", async () => {
  const log = fakeLog();
  let called = 0;
  const ran = await runTenantGatedHandler({
    payload: { eventId: "e1", data: {} },
    messageContext: { headers: {} },
    handler: async () => { called++; },
    eventType: "journal.created.v1",
    exchange: "journal.events",
    log,
  });
  assert.strictEqual(ran, false);
  assert.strictEqual(called, 0);
  assert.strictEqual(log.calls[0].m, "AuditEventTenantRejected");
  assert.strictEqual(log.calls[0].o.reason, "missing");
});
test("gate: mismatched tenant -> handler NOT called", async () => {
  let called = 0;
  const ran = await runTenantGatedHandler({
    payload: { tenantId: A, data: { tenantId: B } },
    handler: async () => { called++; },
    eventType: "x", exchange: "y", log: fakeLog(),
  });
  assert.strictEqual(ran, false);
  assert.strictEqual(called, 0);
});
test("gate: valid tenant -> handler receives the resolved tenant on the envelope", async () => {
  let seen;
  const ran = await runTenantGatedHandler({
    payload: { data: { tenantId: A }, eventId: "e2" },
    messageContext: { headers: { "x-tenant-id": A } },
    handler: async (p, t, ex) => { seen = { tenantId: p.tenantId, t, ex }; },
    eventType: "profile.updated", exchange: "profile.events", log: fakeLog(),
  });
  assert.strictEqual(ran, true);
  assert.deepStrictEqual(seen, { tenantId: A, t: "profile.updated", ex: "profile.events" });
});

// ── persistence guard (defence in depth; runs before any DB access) ────────────
test("createAuditLog refuses a placeholder or missing tenant", async () => {
  for (const t of ["unknown", "", undefined, "default"]) {
    await assert.rejects(() => createAuditLog({ tenantId: t, eventType: "x", action: "y" }), (e) => e.code === "AUDIT_TENANT_REQUIRED", String(t));
  }
});

// ── internal route ─────────────────────────────────────────────────────────────
test("internal: wrong or missing secret -> 403", async () => {
  const res = mkRes();
  await postInternalAuditLog(internalReq({ headers: { "x-service-secret": "nope" } }), res);
  assert.strictEqual(res.statusCode, 403);
});
test("internal: no x-internal-request -> 403", async () => {
  const res = mkRes();
  await postInternalAuditLog(internalReq({ headers: { "x-internal-request": undefined } }), res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, "INTERNAL_CALLER_REQUIRED");
});
test("internal: missing / placeholder x-tenant-id -> 400 even with a body tenantId", async () => {
  for (const h of [undefined, "", "unknown"]) {
    const res = mkRes();
    await postInternalAuditLog(internalReq({ headers: { "x-tenant-id": h }, body: { tenantId: A, action: "X" } }), res);
    assert.strictEqual(res.statusCode, 400, String(h));
    assert.strictEqual(res.body.code, "TENANT_REQUIRED");
  }
});
test("internal: body tenantId different from the trusted header -> 403 (spoof cannot change ownership)", async () => {
  const res = mkRes();
  await postInternalAuditLog(internalReq({ body: { tenantId: B, action: "X" } }), res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, "TENANT_MISMATCH");
});
test("internal: missing action -> 400 (after tenant checks pass)", async () => {
  const res = mkRes();
  await postInternalAuditLog(internalReq({ body: {} }), res);
  assert.strictEqual(res.statusCode, 400);
});

// ── source guards ──────────────────────────────────────────────────────────────
test("no listener falls back to a placeholder tenant", () => {
  const dir = path.join(__dirname, "..", "src", "rabbitMQ", "listeners");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/tenantId[^\n]*"unknown"/.test(src), `${f} still falls back to "unknown"`);
    assert.ok(/tenantId:\s+payload\.tenantId,/.test(src), `${f} must use the gated envelope tenant`);
  }
});
test("consumer wrapper routes every handler through the tenant gate", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "rabbitMQ", "index.js"), "utf8");
  assert.ok(src.includes("runTenantGatedHandler({"));
  assert.ok(!/await handler\(payload, key, boundExchange\)/.test(src));
});
