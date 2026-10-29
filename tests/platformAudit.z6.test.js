// Phase B / Z6 — cross-tenant platform tenant administration: outcome records + selective tenant copies.
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/platformAudit.z6.test.js
//   - platform.tenant.admin.changed.v1: platform actor, target = the route tenant (= data.tenantId), the
//     action's exact permission, success / failure; never owned by a tenant (no envelope tenant).
//   - reads / denials stay authz decisions with a real target and the sign-in tenant as context only.
//   - tenant.lifecycle.changed.v1: copy owned by the target tenant, only for approved actions, safe fields only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-z6-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, mock, beforeEach } = await import("node:test");
const assert = (await import("node:assert")).default;

const calls = [];
const storedEventIds = new Set();
const dbQuery = async (text, params = []) => {
  calls.push({ text, params });
  if (/^\s*INSERT INTO platform_audit_logs/.test(text)) {
    if (storedEventIds.has(params[0])) return { rows: [] };
    storedEventIds.add(params[0]);
    return { rows: [{ id: storedEventIds.size }] };
  }
  if (/^\s*INSERT INTO audit_logs/.test(text)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});

const { buildPlatformAuditRecord, runPlatformAuditHandler, TENANT_ADMIN_ACTIONS } = await import("../src/rabbitMQ/platformAudit.js");
const { handleTenantLifecycleEvent, TENANT_COPY_ACTIONS } = await import("../src/rabbitMQ/listeners/tenant.listener.js");
const { runTenantGatedHandler } = await import("../src/rabbitMQ/eventTenant.js");

const A = "68cbf7806080b4621d469d34"; // sign-in tenant (context only)
const B = "6acd6119b28a863c61361ae0"; // target tenant
const PID = "6a0000000000000000000a06";
const USER = "6a00000000000000000000c6";
const CONN = "6b0000000000000000000c01";
const log = { warnings: [], warn(o, m) { this.warnings.push([m, o]); }, debug() {}, info() {}, error() {} };
beforeEach(() => { calls.length = 0; log.warnings.length = 0; });

const ev = (eventType, data, auditContext, extra = {}) => ({
  payload: { eventId: `ev-${Math.random().toString(16).slice(2)}`, correlationId: "corr-z6", timestamp: "2026-10-30T10:00:00.000Z", data, metadata: { service: "user-service", auditContext }, ...extra },
  eventType,
});
const build = ({ payload, eventType }) => buildPlatformAuditRecord(payload, eventType, {});
const ctx = (o = {}) => ({ actorScope: "platform", actorTenantId: null, targetTenantId: B, loginTenantId: A, ...o });
const change = (o = {}) => ({ principalId: PID, actorUserId: USER, tenantId: B, action: "TENANT_UPDATED", permission: "platform:tenant:update:any", result: "success", status: 200, section: "profile", route: "PUT /api/tenants/:id", ...o });
const CHANGED = "platform.tenant.admin.changed.v1";

test("cross-tenant read / denial = authz decision: platform actor, target B, sign-in tenant A as context only", () => {
  const allowed = build(ev("platform.authz.decision.v1", { allowed: true, reason: "allowed", permission: "platform:tenant:read:any", principalId: PID, actorUserId: USER, status: 200, route: "GET /api/tenants/:id" }, ctx()));
  assert.ok(allowed.ok, allowed.reason);
  assert.deepStrictEqual([allowed.record.actorScope, allowed.record.actorId, allowed.record.actorTenantId, allowed.record.targetTenantId, allowed.record.metadata.loginTenantId], ["platform", PID, null, B, A]);
  const denied = build(ev("platform.authz.decision.v1", { allowed: false, reason: "permission_missing", permission: "platform:tenant:update:any", principalId: PID, status: 403 }, ctx()));
  assert.deepStrictEqual([denied.record.action, denied.record.result, denied.record.targetTenantId], ["PLATFORM_AUTHZ_DENIED", "denied", B]);
});

test("tenant-admin outcome: platform record, target = route tenant, exact permission, no owner tenant", () => {
  const r = build(ev(CHANGED, change(), ctx()));
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(
    [r.record.action, r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.permission, r.record.result, r.record.operation],
    ["TENANT_UPDATED", "platform", PID, null, B, "platform:tenant:update:any", "success", "PUT /api/tenants/:id"]
  );
  assert.deepStrictEqual(r.record.metadata, { status: 200, actorUserId: USER, section: "profile", loginTenantId: A });
  assert.ok(!("tenantId" in r.record), "no owner tenant field");
});

test("tenant-admin outcome: one permission never authorizes another action", () => {
  assert.strictEqual(TENANT_ADMIN_ACTIONS.TENANT_DELETED, "platform:tenant:delete:any");
  assert.strictEqual(TENANT_ADMIN_ACTIONS.AUTH_CONNECTION_ADDED, "platform:tenant:auth-connections:manage:any");
  for (const [action, permission] of [
    ["TENANT_DELETED", "platform:tenant:update:any"],
    ["AUTH_CONNECTION_ADDED", "platform:tenant:update:any"],
    ["TENANT_UPDATED", "platform:tenant:read:any"],
    ["TENANT_SUSPENDED", "platform:tenant:auth-connections:manage:any"],
  ]) {
    assert.strictEqual(build(ev(CHANGED, change({ action, permission }), ctx())).reason, "permission_action_mismatch", action);
  }
});

test("tenant-admin outcome fails closed: no target, target != data.tenantId, envelope owner, unknown action, bad result / connection id, no pid, wrong scope", () => {
  const r = (data, c = ctx(), extra) => build(ev(CHANGED, data, c, extra)).reason;
  assert.strictEqual(r(change(), ctx({ targetTenantId: null })), "target_tenant_required");
  assert.strictEqual(r(change({ tenantId: A })), "target_tenant_mismatch");
  assert.strictEqual(r(change(), ctx(), { tenantId: B }), "platform_record_has_no_owner");
  assert.strictEqual(r(change({ action: "TENANT_READ" })), "unknown_tenant_admin_action");
  assert.strictEqual(r(change({ action: "toString" })), "unknown_tenant_admin_action");
  assert.strictEqual(r(change({ result: "allowed" })), "result_required");
  assert.strictEqual(r(change({ action: "AUTH_CONNECTION_UPDATED", permission: "platform:tenant:auth-connections:manage:any", connectionId: "abc" })), "invalid_connection_id");
  assert.strictEqual(r(change({ principalId: null })), "principal_id_required");
  assert.strictEqual(r(change(), { actorScope: "tenant", actorTenantId: B, targetTenantId: B }), "scope_not_allowed_for_event");
  assert.strictEqual(r(change(), ctx({ targetTenantId: "default" })), "invalid_tenant_value");
});

test("tenant-admin outcome failure is recorded (after authorization) with reason; never an oid / email / body field", () => {
  const r = build(ev(CHANGED, change({ result: "failure", status: 404, reason: "not_found", clientSecret: "s3cret", email: "x@y.z", body: { a: 1 } }), ctx()));
  assert.ok(r.ok);
  assert.deepStrictEqual([r.record.result, r.record.reason, r.record.metadata.status], ["failure", "not_found", 404]);
  assert.ok(!/s3cret|x@y\.z/.test(JSON.stringify(r.record)));
});

test("handler: tenant-admin outcome goes to platform_audit_logs only and is idempotent on event_id", async () => {
  const e = ev(CHANGED, change(), ctx());
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true);
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true);
  assert.ok(calls.every((c) => /INSERT INTO platform_audit_logs/.test(c.text)));
  assert.strictEqual([...storedEventIds].filter((id) => id === e.payload.eventId).length, 1);
});

// ── tenant copies ────────────────────────────────────────────────────────────
const copy = (data, { tenantId = B, header = tenantId, eventId = `copy-${Math.random().toString(16).slice(2)}` } = {}) =>
  runTenantGatedHandler({
    payload: { tenantId, eventId, correlationId: "corr-z6", timestamp: "2026-10-30T10:00:00.000Z", data, metadata: { service: "user-service", auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: tenantId } } },
    messageContext: { headers: { "x-tenant-id": header } },
    handler: handleTenantLifecycleEvent,
    eventType: "tenant.lifecycle.changed.v1",
    exchange: "user.events",
    log,
  });

test("tenant copy rules: only approved lifecycle / configuration actions; reads, test, connect-start, delete are platform-only", () => {
  assert.deepStrictEqual(Object.keys(TENANT_COPY_ACTIONS).sort(), [
    "AUTH_CONNECTION_ADDED", "AUTH_CONNECTION_CONNECTED", "AUTH_CONNECTION_DISCONNECTED", "AUTH_CONNECTION_REMOVED", "AUTH_CONNECTION_UPDATED",
    "TENANT_REACTIVATED", "TENANT_STATUS_CHANGED", "TENANT_SUSPENDED", "TENANT_UPDATED",
  ]);
  for (const a of ["TENANT_DELETED", "AUTH_CONNECTION_TESTED", "AUTH_CONNECTION_CONNECT_STARTED"]) assert.ok(!(a in TENANT_COPY_ACTIONS), a);
});

test("tenant copy: owned by the target tenant, platform / null / target, safe fields only, no platform detail", async () => {
  assert.strictEqual(await copy({ tenantId: B, action: "TENANT_SUSPENDED", section: "status", fromStatus: "ACTIVE", toStatus: "SUSPENDED", principalId: PID, loginTenantId: A, permission: "platform:tenant:update:any", name: "Acme" }), true);
  const p = calls.find((c) => /INSERT INTO audit_logs/.test(c.text)).params;
  assert.deepStrictEqual([p[0], p[4], p[5], p[6], p[7], p[15], p[16], p[17]], [B, "TENANT_SUSPENDED", "tenant", B, null, "platform", null, B]);
  const s = JSON.stringify(p);
  assert.ok(!s.includes(PID) && !s.includes(A) && !s.includes("Acme") && !s.includes("platform:tenant"), "no principal, sign-in tenant, body field or permission");
  assert.ok(/toStatus\\*"?:\\*"SUSPENDED/.test(s) && /fromStatus\\*"?:\\*"ACTIVE/.test(s), "status values kept");
});

test("tenant copy: auth connection change -> resource auth_connection / connection id; never a connection body field", async () => {
  assert.strictEqual(await copy({ tenantId: B, action: "AUTH_CONNECTION_UPDATED", section: "auth-connections", connectionId: CONN, clientSecret: "s3cret", directoryId: "0000-tid" }), true);
  const p = calls.find((c) => /INSERT INTO audit_logs/.test(c.text)).params;
  assert.deepStrictEqual([p[0], p[4], p[5], p[6]], [B, "AUTH_CONNECTION_UPDATED", "auth_connection", CONN]);
  assert.ok(!/s3cret|0000-tid/.test(JSON.stringify(p)));
});

test("tenant copy fails closed: unknown / platform-only action, data tenant != owner, placeholder owner, header mismatch", async () => {
  assert.strictEqual(await copy({ tenantId: B, action: "TENANT_DELETED" }), true); // gate passes, listener drops
  assert.strictEqual(await copy({ tenantId: B, action: "PLATFORM_AUTHZ_ALLOWED" }), true);
  assert.ok(!calls.some((c) => /INSERT/.test(c.text)), "unknown / platform-only actions dropped by the listener (logged TenantLifecycleCopyRejected)");
  assert.strictEqual(await copy({ tenantId: A, action: "TENANT_UPDATED" }), false); // A1 gate: data tenant != envelope owner
  assert.strictEqual(await copy({ tenantId: "unknown", action: "TENANT_UPDATED" }, { tenantId: "unknown" }), false);
  assert.strictEqual(await copy({ tenantId: B, action: "TENANT_UPDATED" }, { header: A }), false);
  assert.ok(!calls.some((c) => /INSERT/.test(c.text)), "no row written");
});
