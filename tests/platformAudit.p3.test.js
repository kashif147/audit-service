// Phase B / P3 prerequisite - the NARROW system-actor target-tenant exception: platform.provisioning.step.changed.v1
// (reserved actor platform:provisioning) REQUIRES a verified target tenant; every other system event still refuses one.
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/platformAudit.p3.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-p3-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, mock } = await import("node:test");
const assert = (await import("node:assert")).default;
const dbQuery = async (text, params = []) => (/INSERT INTO platform_audit_logs/.test(text) ? { rows: [{ id: 1 }] } : { rows: [] });
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});
const { buildPlatformAuditRecord, PLATFORM_EVENT_TYPES, PROVISIONING_STEP_ACTIONS } = await import("../src/rabbitMQ/platformAudit.js");

const T = "6acd6119b28a863c61361ae0";
const RUN = "11111111-2222-4333-8444-555555555555";
const KEY = `psk2:${RUN}:account-service:grid-system-defaults:ensure-defaults`;
const STEP = "platform.provisioning.step.changed.v1";
const ev = (eventType, data, auditContext, extra = {}) => ({ payload: { eventId: `ev-${Math.random().toString(16).slice(2)}`, timestamp: "2026-11-01T17:00:00.000Z", data, metadata: { service: "user-service", auditContext }, ...extra }, eventType });
const build = (e) => buildPlatformAuditRecord(e.payload, e.eventType, {});
const sysT = (o = {}) => ({ actorScope: "system", actorTenantId: null, targetTenantId: T, ...o });
const step = (o = {}) => ({ actorId: "platform:provisioning", tenantId: T, action: "PROVISIONING_STEP_SUCCEEDED", result: "success", runId: RUN, stepKey: KEY, component: "account-service:grid-system-defaults", manifestVersion: 1, attempt: 1, stepStatus: "succeeded", runStatus: "running", insertedCount: 4, skippedCount: 0, ...o });

test("step.changed is bound and accepted: system actor platform:provisioning + verified target tenant", () => {
  assert.ok(PLATFORM_EVENT_TYPES.includes(STEP));
  for (const action of PROVISIONING_STEP_ACTIONS) {
    const r = build(ev(STEP, step({ action, result: action.endsWith("FAILED") || action.endsWith("REFUSED") ? "failure" : "success" }), sysT()));
    assert.ok(r.ok, `${action}: ${r.reason}`);
  }
  const r = build(ev(STEP, step(), sysT()));
  assert.deepStrictEqual([r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.operation], ["system", "platform:provisioning", null, T, "provisioning-orchestrator"]);
  assert.deepStrictEqual(r.record.metadata, { runId: RUN, stepKey: KEY, component: "account-service:grid-system-defaults", manifestVersion: 1, attempt: 1, stepStatus: "succeeded", runStatus: "running", insertedCount: 4, skippedCount: 0 });
});

test("step.changed fails closed: no target, mismatched target, owner envelope, wrong actor, other scopes, bad ids, legacy/ambiguous step key", () => {
  const r = (data, c = sysT(), extra) => build(ev(STEP, data, c, extra)).reason;
  assert.strictEqual(r(step(), sysT({ targetTenantId: null })), "system_actor_requires_target");
  assert.strictEqual(r(step({ tenantId: "68cbf7806080b4621d469d34" })), "target_tenant_mismatch");
  assert.strictEqual(r(step(), sysT(), { tenantId: T }), "platform_record_has_no_owner");
  assert.strictEqual(r(step({ actorId: "platform:principal-admin" })), "unknown_system_actor");
  assert.strictEqual(r(step({ actorId: "platform:migration" })), "unknown_system_actor");
  assert.strictEqual(r(step(), { actorScope: "platform", actorTenantId: null, targetTenantId: T }), "scope_not_allowed_for_event");
  assert.strictEqual(r(step(), { actorScope: "tenant", actorTenantId: T, targetTenantId: T }), "scope_not_allowed_for_event");
  assert.strictEqual(r(step(), sysT({ loginTenantId: T })), "system_actor_tenant_context");
  assert.strictEqual(r(step(), sysT({ targetTenantId: "DEVTENANTB" })), "invalid_tenant_value");
  assert.strictEqual(r(step({ action: "PROVISIONING_STEP_DISPATCHED" })), "unknown_provisioning_step_action");
  assert.strictEqual(r(step({ runId: "x" })), "invalid_run_id");
  assert.strictEqual(r(step({ stepKey: `${T}:standard-tenant@1:account-service:account-service:grid-system-defaults` })), "invalid_step_key"); // legacy P2 shape
  assert.strictEqual(r(step({ stepKey: `psk2:22222222-2222-4333-8444-555555555555:account-service:grid-system-defaults:ensure-defaults` })), "invalid_step_key"); // other run
});

test("the exception stays NARROW: every other system event still refuses a target tenant", () => {
  const principal = { actorId: "platform:principal-admin", action: "create", result: "success", principalId: "6a0000000000000000000a03", operatorLabel: "ops", approvalRef: "ref" };
  assert.strictEqual(build(ev("platform.principal.changed.v1", principal, sysT())).reason, "system_actor_tenant_context");
  assert.ok(build(ev("platform.principal.changed.v1", principal, sysT({ targetTenantId: null }))).ok);
  const tpl = { actorId: "platform:provisioning", action: "PLATFORM_TEMPLATE_PUBLISHED", result: "success", templateKey: "standard-tenant", templateVersion: 1, operatorLabel: "ops", approvalRef: "ref" };
  assert.strictEqual(build(ev("platform.provisioning.template.published.v1", tpl, sysT())).reason, "system_actor_tenant_context");
  assert.ok(build(ev("platform.provisioning.template.published.v1", tpl, sysT({ targetTenantId: null }))).ok);
});

test("no secrets / free-form data stored", () => {
  const r = build(ev(STEP, step({ token: "eyJhbGciOiJIUzI1NiJ9.e30.x", email: "a@b.c", error: "Mongo connection string ...", body: { x: 1 } }), sysT()));
  assert.ok(r.ok);
  assert.ok(!/eyJ|a@b\.c|Mongo connection/.test(JSON.stringify(r.record)));
});
