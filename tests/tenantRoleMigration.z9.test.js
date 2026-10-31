// Phase B / Z9 - the tenant SU -> ASU role migration audit record (tenant.lifecycle.changed.v1, action
// TENANT_ROLE_MIGRATED, written by user-service scripts/migrate-su-to-asu.js as the reserved system actor).
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/tenantRoleMigration.z9.test.js
const { test, mock, beforeEach } = await import("node:test");
const assert = (await import("node:assert")).default;

const calls = [];
const dbQuery = async (text, params = []) => {
  calls.push({ text, params });
  if (/^\s*INSERT INTO audit_logs/.test(text)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});

const { handleTenantLifecycleEvent, TENANT_COPY_ACTIONS, roleMigrationAfter, ROLE_MIGRATION_ACTION, ROLE_MIGRATION_ACTOR } = await import("../src/rabbitMQ/listeners/tenant.listener.js");
const { runTenantGatedHandler } = await import("../src/rabbitMQ/eventTenant.js");

const B = "6acd6119b28a863c61361ae0"; // the migrated tenant
const A = "68cbf7806080b4621d469d34";
const RUN = "z9-20261031160000-a1b2c3";
const log = { warnings: [], warn(o, m) { this.warnings.push([m, o]); }, debug() {}, info() {}, error() {} };
beforeEach(() => { calls.length = 0; log.warnings.length = 0; });

const record = (o = {}) => ({
  tenantId: B, action: ROLE_MIGRATION_ACTION, actorId: ROLE_MIGRATION_ACTOR, fromRole: "SU", toRole: "ASU", outcome: "migrated",
  affectedUsers: 2, affectedConnections: 0, permissionsAdded: 7, suRolesRetired: 1, runId: RUN, ...o,
});
const send = (data, { tenantId = B, header = tenantId } = {}) =>
  runTenantGatedHandler({
    payload: { tenantId, eventId: `z9-${Math.random().toString(16).slice(2)}`, correlationId: RUN, timestamp: "2026-10-31T16:00:00.000Z", data, metadata: { service: "user-service", auditContext: { actorScope: "system", actorTenantId: null, targetTenantId: tenantId } } },
    messageContext: { headers: { "x-tenant-id": header } },
    handler: handleTenantLifecycleEvent,
    eventType: "tenant.lifecycle.changed.v1",
    exchange: "user.events",
    log,
  });
const inserted = () => calls.filter((c) => /INSERT INTO audit_logs/.test(c.text));

test("the role migration is NOT a platform copy action (its own allow-listed record)", () => {
  assert.ok(!(ROLE_MIGRATION_ACTION in TENANT_COPY_ACTIONS));
});

test("record: owned by the migrated tenant, system actor, resource role, counts / status / run id only", async () => {
  assert.strictEqual(await send(record({ email: "x@y.z", userIds: ["6a00000000000000000000c6"], permissions: ["payments:write"] })), true);
  const rows = inserted();
  assert.strictEqual(rows.length, 1);
  const p = rows[0].params;
  // tenant_id, action, resource_type, resource_id, actor_id, actor_scope, actor_tenant_id, target_tenant_id
  assert.deepStrictEqual([p[0], p[4], p[5], p[6], p[7], p[15], p[16], p[17]], [B, "TENANT_ROLE_MIGRATED", "role", B, ROLE_MIGRATION_ACTOR, "system", null, B]);
  const s = JSON.stringify(p);
  assert.ok(!/x@y\.z|6a00000000000000000000c6|payments:write/.test(s), "no email, user id or permission list");
  assert.deepStrictEqual(roleMigrationAfter(record()), { fromRole: "SU", toRole: "ASU", outcome: "migrated", runId: RUN, affectedUsers: 2, affectedConnections: 0, permissionsAdded: 7, suRolesRetired: 1 });
});

test("fails closed: wrong roles, actor, outcome, run id or counts; data tenant != owner; header mismatch", async () => {
  for (const bad of [
    { fromRole: "ASU" }, { toRole: "SU" }, { toRole: "PLATFORM" }, { actorId: "platform:principal-admin" }, { outcome: "noop" },
    { runId: "x" }, { affectedUsers: -1 }, { affectedUsers: 1.5 }, { permissionsAdded: "7" }, { suRolesRetired: undefined },
  ]) {
    assert.strictEqual(await send(record(bad)), true, JSON.stringify(bad)); // gate passes, listener drops (logged)
  }
  assert.strictEqual(await send(record({ tenantId: A })), false); // A1 gate: data tenant != envelope owner
  assert.strictEqual(await send(record(), { header: A }), false);
  assert.strictEqual(inserted().length, 0, "no row written");
  assert.ok(log.warnings.length >= 0);
});
