// Phase B / P1 — provisioning control plane audit records (platform_audit_logs).
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/platformAudit.p1.test.js
//   - platform.provisioning.run.changed.v1: platform actor holding EXACTLY platform:provisioning:admin, target = the
//     run's tenant (= data.tenantId); only a refusal may have no target; never an owner tenant; ids/statuses/counts.
//   - platform.provisioning.template.published.v1: reserved system actor platform:provisioning, no tenant at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-p1-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, mock, beforeEach } = await import("node:test");
const assert = (await import("node:assert")).default;

const calls = [];
const stored = new Set();
const dbQuery = async (text, params = []) => {
  calls.push({ text, params });
  if (/^\s*INSERT INTO platform_audit_logs/.test(text)) {
    if (stored.has(params[0])) return { rows: [] };
    stored.add(params[0]);
    return { rows: [{ id: stored.size }] };
  }
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});

const { buildPlatformAuditRecord, runPlatformAuditHandler, PLATFORM_EVENT_TYPES, PROVISIONING_RUN_ACTIONS } = await import("../src/rabbitMQ/platformAudit.js");

const A = "68cbf7806080b4621d469d34"; // the principal's sign-in tenant (context only)
const T = "6a00000000000000000000f1"; // the tenant being provisioned
const PID = "6a0000000000000000000a03";
const USER = "6a00000000000000000000c1";
const RUN = "11111111-2222-4333-8444-555555555555";
const RUN_EV = "platform.provisioning.run.changed.v1";
const TPL_EV = "platform.provisioning.template.published.v1";
const log = { warnings: [], warn(o, m) { this.warnings.push([m, o]); }, debug() {}, info() {}, error() {} };
beforeEach(() => { calls.length = 0; log.warnings.length = 0; });

const ev = (eventType, data, auditContext, extra = {}) => ({
  payload: { eventId: `ev-${Math.random().toString(16).slice(2)}`, correlationId: "corr-p1", timestamp: "2026-11-01T15:00:00.000Z", data, metadata: { service: "user-service", auditContext }, ...extra },
  eventType,
});
const build = (e) => buildPlatformAuditRecord(e.payload, e.eventType, {});
const ctx = (o = {}) => ({ actorScope: "platform", actorTenantId: null, targetTenantId: T, loginTenantId: A, ...o });
const sys = () => ({ actorScope: "system", actorTenantId: null, targetTenantId: null });
const run = (o = {}) => ({
  principalId: PID, actorUserId: USER, tenantId: T, action: "PROVISIONING_RUN_CREATED", permission: "platform:provisioning:admin", result: "success",
  route: "POST /api/platform/provisioning/runs", runId: RUN, templateKey: "standard-tenant", templateVersion: 1, runStatus: "pending", attempt: 1,
  stepCount: 7, stepsSucceeded: 0, insertedCount: 0, skippedCount: 0, ...o,
});
const tpl = (o = {}) => ({ actorId: "platform:provisioning", action: "PLATFORM_TEMPLATE_PUBLISHED", result: "success", templateKey: "standard-tenant", templateVersion: 1, contentHash: "8".repeat(64), componentCount: 7, operatorLabel: "ops-p1", approvalRef: "owner-2026-11-01", ...o });

test("both P1 event types are bound (the consumer subscribes to PLATFORM_EVENT_TYPES)", () => {
  assert.ok(PLATFORM_EVENT_TYPES.includes(RUN_EV));
  assert.ok(PLATFORM_EVENT_TYPES.includes(TPL_EV));
});

test("run action: platform record, actor = principal, target = provisioned tenant, sign-in tenant as context only; ids and counts", () => {
  const r = build(ev(RUN_EV, run(), ctx()));
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual(
    [r.record.action, r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.permission, r.record.result, r.record.operation],
    ["PROVISIONING_RUN_CREATED", "platform", PID, null, T, "platform:provisioning:admin", "success", "POST /api/platform/provisioning/runs"]
  );
  assert.deepStrictEqual(r.record.metadata, { actorUserId: USER, runId: RUN, templateKey: "standard-tenant", templateVersion: 1, runStatus: "pending", attempt: 1, stepCount: 7, stepsSucceeded: 0, insertedCount: 0, skippedCount: 0, loginTenantId: A });
  for (const action of PROVISIONING_RUN_ACTIONS) assert.ok(build(ev(RUN_EV, run({ action }), ctx())).ok, action);
});

test("run action fails closed: wrong permission, tenant actor, no pid, owner tenant, target mismatch, unknown action, bad run id", () => {
  const r = (data, c = ctx(), extra) => build(ev(RUN_EV, data, c, extra)).reason;
  assert.strictEqual(r(run({ permission: "platform:tenant:create" })), "permission_required");
  assert.strictEqual(r(run({ permission: "*" })), "permission_required");
  assert.strictEqual(r(run(), { actorScope: "tenant", actorTenantId: A, targetTenantId: A }), "scope_not_allowed_for_event"); // ASU / SU never provision
  assert.strictEqual(r(run(), sys()), "scope_not_allowed_for_event");
  assert.strictEqual(r(run({ principalId: null })), "principal_id_required");
  assert.strictEqual(r(run(), ctx(), { tenantId: T }), "platform_record_has_no_owner");
  assert.strictEqual(r(run({ tenantId: A })), "target_tenant_mismatch");
  assert.strictEqual(r(run(), ctx({ targetTenantId: null })), "target_tenant_required");
  assert.strictEqual(r(run({ action: "PROVISIONING_STEP_DISPATCHED" })), "unknown_provisioning_action");
  assert.strictEqual(r(run({ result: "allowed" })), "result_required");
  assert.strictEqual(r(run({ runId: "not-a-uuid" })), "invalid_run_id");
  assert.strictEqual(r(run(), ctx({ targetTenantId: "MULTIAUTH" })), "invalid_tenant_value"); // org code is never a tenant value
});

test("a refusal may carry no target (no existing tenant was named), never a fabricated one", () => {
  const refused = build(ev(RUN_EV, { principalId: PID, actorUserId: USER, action: "PROVISIONING_RUN_REFUSED", permission: "platform:provisioning:admin", result: "failure", reason: "internal_tenant_id_required", route: "POST /api/platform/provisioning/runs" }, ctx({ targetTenantId: null })));
  assert.ok(refused.ok, refused.reason);
  assert.deepStrictEqual([refused.record.targetTenantId, refused.record.result, refused.record.reason], [null, "failure", "internal_tenant_id_required"]);
});

test("no secrets or free-form data are stored", () => {
  const r = build(ev(RUN_EV, run({ token: "eyJhbGciOiJIUzI1NiJ9.e30.x", email: "a@b.c", clientSecret: "s3cret", body: { a: 1 } }), ctx()));
  assert.ok(r.ok);
  assert.ok(!/eyJ|a@b\.c|s3cret/.test(JSON.stringify(r.record)));
});

test("template publish: reserved system actor platform:provisioning, no tenant, operator labels required", () => {
  const r = build(ev(TPL_EV, tpl(), sys()));
  assert.ok(r.ok, r.reason);
  assert.deepStrictEqual([r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.action, r.record.operation], ["system", "platform:provisioning", null, null, "PLATFORM_TEMPLATE_PUBLISHED", "platform-template publish"]);
  assert.deepStrictEqual(r.record.metadata, { templateKey: "standard-tenant", templateVersion: 1, contentHash: "8".repeat(64), componentCount: 7, operatorLabel: "ops-p1", approvalRef: "owner-2026-11-01" });
  assert.ok(build(ev(TPL_EV, tpl({ action: "PLATFORM_TEMPLATE_RETIRED" }), sys())).ok);
  const bad = (data, c = sys()) => build(ev(TPL_EV, data, c)).reason;
  assert.strictEqual(bad(tpl({ actorId: "platform:principal-admin" })), "unknown_system_actor");
  assert.strictEqual(bad(tpl(), ctx()), "scope_not_allowed_for_event");
  assert.strictEqual(bad(tpl(), { actorScope: "system", actorTenantId: null, targetTenantId: T }), "system_actor_tenant_context");
  assert.strictEqual(bad(tpl({ action: "PLATFORM_TEMPLATE_EDITED" })), "unknown_template_action");
  assert.strictEqual(bad(tpl({ contentHash: "xyz" })), "invalid_content_hash");
  assert.strictEqual(bad(tpl({ approvalRef: "" })), "operator_metadata_required");
  assert.strictEqual(bad(tpl({ operatorLabel: "ops@example.org" })), "operator_metadata_required");
});

test("handler: P1 records go to platform_audit_logs only and are idempotent on event_id", async () => {
  const e = ev(RUN_EV, run(), ctx());
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true);
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true);
  assert.ok(calls.length > 0 && calls.every((c) => /INSERT INTO platform_audit_logs/.test(c.text)));
  assert.strictEqual(await runPlatformAuditHandler({ ...ev(RUN_EV, run({ permission: "platform:tenant:create" }), ctx()), log }), false);
  assert.strictEqual(log.warnings[0][0], "PlatformAuditEventRejected");
});
