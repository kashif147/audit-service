// Phase B / Z5 — platform_audit_logs: the authoritative store for platform / system security events.
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/platformAudit.z5.test.js
//   - record builder: platform-wide target NULL, real target tenant validated, tenant actors only as denials
//     (truthful scope), reserved system actor for principal admin, placeholders / unknown fields / wrong
//     scope / malformed system actor fail closed; Z4-shaped events are stored here, never owned by a tenant.
//   - handler: writes platform_audit_logs only (never audit_logs), idempotent on event_id, never throws.
//   - tenant lifecycle copy: owned by the NEW tenant, platform / null / new, no platform detail.
//   - schema / source guards: no tenant_id ownership column, UNIQUE(event_id), no API reads the table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-z5-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { test, mock, beforeEach } = await import("node:test");
const assert = (await import("node:assert")).default;

const calls = [];
const storedEventIds = new Set();
const dbQuery = async (text, params = []) => {
  calls.push({ text, params });
  if (/^\s*INSERT INTO platform_audit_logs/.test(text)) {
    if (storedEventIds.has(params[0])) return { rows: [] }; // ON CONFLICT (event_id) DO NOTHING
    storedEventIds.add(params[0]);
    return { rows: [{ id: storedEventIds.size }] };
  }
  if (/^\s*INSERT INTO audit_logs/.test(text)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: { query: dbQuery, getPool: () => ({ query: dbQuery }), connectDB: async () => {}, closeDB: async () => {} },
});

const { buildPlatformAuditRecord, runPlatformAuditHandler, PLATFORM_EVENT_TYPES, PRINCIPAL_ADMIN_ACTOR } = await import("../src/rabbitMQ/platformAudit.js");
const { handleTenantLifecycleEvent, TENANT_LIFECYCLE_EVENT_TYPES } = await import("../src/rabbitMQ/listeners/tenant.listener.js");
const { runTenantGatedHandler } = await import("../src/rabbitMQ/eventTenant.js");
const { SYSTEM_ACTORS } = await import("../src/helpers/auditContext.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");
const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const NEW = "6b0000000000000000000e01";
const PID = "6a0000000000000000000a05";
const USER = "6a00000000000000000000c5";
const log = { warnings: [], warn(o, m) { this.warnings.push([m, o]); }, debug() {}, info() {}, error() {} };
beforeEach(() => { calls.length = 0; log.warnings.length = 0; });

const ev = (eventType, data, auditContext, extra = {}) => ({
  payload: { eventId: `ev-${Math.random().toString(16).slice(2)}`, correlationId: "corr-z5", timestamp: "2026-10-29T10:00:00.000Z", data, metadata: { service: "user-service", auditContext }, ...extra },
  eventType,
});
const build = ({ payload, eventType }, opts) => buildPlatformAuditRecord(payload, eventType, opts);
const platformCtx = (o = {}) => ({ actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A, ...o });
const authz = (o = {}) => ({ allowed: true, reason: "allowed", permission: "platform:cache:admin", mode: "shadow", principalId: PID, actorUserId: USER, tokenRev: 3, currentRev: 3, revMatch: true, route: "POST /api/cache/clear", status: 200, ...o });
const principalChange = (o = {}) => ({ actorId: PRINCIPAL_ADMIN_ACTOR, action: "set-permissions", result: "success", principalId: PID, status: "active", revision: 4, permissionsAdded: ["platform:cache:admin"], permissionsRemoved: ["platform:tenant:create"], operatorLabel: "claude-z5-dev", approvalRef: "owner-Z5-brief", ...o });

// ── record builder ────────────────────────────────────────────────────────────
test("event types: the Z4 platform-auth types plus tenant create / failure and principal changes", () => {
  assert.deepStrictEqual([...PLATFORM_EVENT_TYPES].sort(), [
    "platform.authz.decision.v1", "platform.claim.decision.v1", "platform.principal.changed.v1",
    "platform.provisioning.run.changed.v1", "platform.provisioning.step.changed.v1", "platform.provisioning.template.published.v1",
    "platform.tenant.admin.changed.v1", "platform.tenant.create.failed.v1", "platform.tenant.created.v1",
  ]); // + Z6 tenant-admin outcome (tests/platformAudit.z6.test.js), P1 provisioning (tests/platformAudit.p1.test.js)
  assert.ok(SYSTEM_ACTORS.includes("platform:principal-admin"));
});

test("platform-wide action: platform actor = principal id, actor tenant NULL, target NULL; sign-in tenant only as context", () => {
  const r = build(ev("platform.authz.decision.v1", authz(), platformCtx()));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    [r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.result, r.record.allowed, r.record.permission],
    ["platform", PID, null, null, "allowed", true, "platform:cache:admin"],
  );
  assert.strictEqual(r.record.metadata.loginTenantId, A);
  assert.ok(!("tenantId" in r.record), "no ownership tenant on a platform record");
});

test("no login-tenant ownership: a Z4-shaped event (envelope tenant A) is stored with no owner tenant", () => {
  const r = build(ev("platform.claim.decision.v1", { decision: "issued", mode: "shadow", principalId: PID, actorUserId: USER }, { actorScope: "platform", actorTenantId: null, targetTenantId: null, loginTenantId: A }, { tenantId: A }), { headerTenantId: A });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.record.action, r.record.actorScope, r.record.targetTenantId, r.record.actorTenantId], ["PLATFORM_CLAIM_ISSUED", "platform", null, null]);
  assert.ok(!Object.values(r.record).includes(A), "A appears only inside metadata.loginTenantId");
});

test("tenant actor (legacy SU '*', ASU, ordinary user) denied a platform action: recorded truthfully as a TENANT actor", () => {
  const r = build(ev("platform.authz.decision.v1", authz({ allowed: false, reason: "no_plat", principalId: null, status: 403 }), { actorScope: "tenant", actorTenantId: A, targetTenantId: null }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.record.actorScope, r.record.actorId, r.record.actorTenantId, r.record.targetTenantId, r.record.result], ["tenant", USER, A, null, "denied"]);
  // a tenant actor can never be recorded as allowed platform authority, nor relabelled platform
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz({ principalId: null }), { actorScope: "tenant", actorTenantId: A })), { ok: false, reason: "tenant_actor_allowed" });
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz({ allowed: false, reason: "no_plat", principalId: null }), platformCtx())), { ok: false, reason: "principal_id_required" });
  // a tenant actor cannot point at another tenant
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz({ allowed: false, principalId: null }), { actorScope: "tenant", actorTenantId: A, targetTenantId: B })), { ok: false, reason: "tenant_actor_cross_tenant" });
});

test("target tenant validation: a real ProjectShell tenant id or NULL - never default / unknown / org code / Entra tid", () => {
  for (const bad of ["default", "unknown", "INMO", "39866a06-30bc-4a89-80c6-9dd9357dd453", "system", A.toUpperCase()]) {
    assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx({ targetTenantId: bad }))), { ok: false, reason: "invalid_tenant_value" }, bad);
    assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx({ loginTenantId: bad }))), { ok: false, reason: "invalid_tenant_value" }, bad);
  }
  assert.strictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx({ targetTenantId: B }))).record.targetTenantId, B);
  // a placeholder envelope tenant is rejected, not stored
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx(), { tenantId: "unknown" })), { ok: false, reason: "invalid_envelope_tenant" });
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx(), { tenantId: A }), { headerTenantId: B }), { ok: false, reason: "envelope_header_mismatch" });
});

test("successful tenant create: platform record with target = the NEW tenant, exact permission, success", () => {
  const r = build(ev("platform.tenant.created.v1", { principalId: PID, actorUserId: USER, tenantId: NEW, permission: "platform:tenant:create", route: "POST /api/tenants" }, platformCtx({ targetTenantId: NEW })));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.record.action, r.record.actorScope, r.record.actorId, r.record.targetTenantId, r.record.permission, r.record.result], ["TENANT_CREATED", "platform", PID, NEW, "platform:tenant:create", "success"]);
  assert.deepStrictEqual(build(ev("platform.tenant.created.v1", { principalId: PID, tenantId: NEW, permission: "platform:tenant:create" }, platformCtx())), { ok: false, reason: "target_tenant_required" });
  assert.deepStrictEqual(build(ev("platform.tenant.created.v1", { principalId: PID, tenantId: B, permission: "platform:tenant:create" }, platformCtx({ targetTenantId: NEW }))), { ok: false, reason: "target_tenant_mismatch" });
});

test("failed tenant create (after authorization): platform record only, target NULL (no tenant exists)", () => {
  const r = build(ev("platform.tenant.create.failed.v1", { principalId: PID, permission: "platform:tenant:create", reason: "conflict", status: 400 }, platformCtx()));
  assert.deepStrictEqual([r.record.action, r.record.targetTenantId, r.record.result, r.record.reason], ["TENANT_CREATE_FAILED", null, "failure", "conflict"]);
  assert.deepStrictEqual(build(ev("platform.tenant.create.failed.v1", { principalId: PID, permission: "platform:tenant:create" }, platformCtx({ targetTenantId: NEW }))), { ok: false, reason: "failed_create_has_no_target" });
});

test("principal admin: reserved system actor platform:principal-admin; operator label + approval kept as supplied metadata", () => {
  const r = build(ev("platform.principal.changed.v1", principalChange(), { actorScope: "system", actorTenantId: null, targetTenantId: null }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.record.actorScope, r.record.actorId, r.record.action, r.record.result, r.record.targetTenantId], ["system", "platform:principal-admin", "PLATFORM_PRINCIPAL_SET_PERMISSIONS", "success", null]);
  assert.deepStrictEqual(r.record.metadata, { principalId: PID, status: "active", revision: 4, permissionsAdded: ["platform:cache:admin"], permissionsRemoved: ["platform:tenant:create"], operatorLabel: "claude-z5-dev", approvalRef: "owner-Z5-brief" });
  for (const action of ["create", "disable", "enable"]) {
    assert.strictEqual(build(ev("platform.principal.changed.v1", principalChange({ action }), { actorScope: "system" })).ok, true, action);
  }
  // a failed write (e.g. concurrent change) is recorded as a failure outcome
  assert.strictEqual(build(ev("platform.principal.changed.v1", principalChange({ result: "failure", reason: "concurrent_change" }), { actorScope: "system" })).record.result, "failure");
});

test("malformed / unknown system actor rejected; system actors carry no tenant context", () => {
  for (const actorId of ["platform:migration", "admin", "root", "", undefined, PID]) {
    assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange({ actorId }), { actorScope: "system" })), { ok: false, reason: "unknown_system_actor" }, String(actorId));
  }
  assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange(), { actorScope: "system", loginTenantId: A })), { ok: false, reason: "system_actor_tenant_context" });
  assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange(), { actorScope: "system", actorTenantId: A })), { ok: false, reason: "non_tenant_actor_has_actor_tenant" });
  assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange(), { actorScope: "platform" })), { ok: false, reason: "scope_not_allowed_for_event" });
  assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange({ action: "delete-all" }), { actorScope: "system" })), { ok: false, reason: "unknown_principal_action" });
  assert.deepStrictEqual(build(ev("platform.principal.changed.v1", principalChange({ operatorLabel: "a@b.c" }), { actorScope: "system" })), { ok: false, reason: "operator_metadata_required" });
});

test("fail closed: missing context, unknown context field, wrong scope for the event, missing event id, bad permission", () => {
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), undefined)), { ok: false, reason: "context_required" });
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), platformCtx({ ownerTenantId: A }))), { ok: false, reason: "unknown_context_field" });
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz(), { actorScope: "superuser" })), { ok: false, reason: "scope_not_allowed_for_event" });
  assert.deepStrictEqual(build(ev("platform.claim.decision.v1", { decision: "issued", principalId: PID }, { actorScope: "system" })), { ok: false, reason: "scope_not_allowed_for_event" });
  const noId = ev("platform.authz.decision.v1", authz(), platformCtx()); delete noId.payload.eventId;
  assert.deepStrictEqual(build(noId), { ok: false, reason: "event_id_required" });
  assert.deepStrictEqual(build(ev("platform.authz.decision.v1", authz({ permission: "*" }), platformCtx())), { ok: false, reason: "permission_required" });
  assert.deepStrictEqual(build(ev("platform.unknown.v1", authz(), platformCtx())), { ok: false, reason: "unknown_event_type" });
});

test("allow-list: never an oid, issuer, email, token or name - unknown data fields are dropped", () => {
  const r = build(ev("platform.authz.decision.v1", authz({ oid: "aaaa1111-bbbb", issuer: "https://login.example/x", email: "p@example.org", token: "eyJhbGciOiJIUzI1NiJ9xxxx", name: "Platform Person" }), platformCtx()));
  assert.ok(!/aaaa1111|https:\/\/login|p@example|eyJhbGci|Platform Person/.test(JSON.stringify(r.record)));
});

// ── handler ──────────────────────────────────────────────────────────────────
test("handler writes platform_audit_logs only (never audit_logs) and is idempotent on event_id", async () => {
  const e = ev("platform.authz.decision.v1", authz({ allowed: false, reason: "permission_missing", status: 403 }), platformCtx());
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true);
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), true); // redelivery
  const inserts = calls.filter((c) => /INSERT INTO/.test(c.text));
  assert.strictEqual(inserts.length, 2);
  assert.ok(inserts.every((c) => /INSERT INTO platform_audit_logs/.test(c.text) && /ON CONFLICT \(event_id\) DO NOTHING/.test(c.text)));
  assert.ok(!calls.some((c) => /audit_logs\b/.test(c.text.replace(/platform_audit_logs/g, ""))), "nothing touches audit_logs");
  assert.strictEqual([...storedEventIds].filter((id) => id === e.payload.eventId).length, 1, "one row per event id");
});

test("handler: a rejected event is logged and skipped - no write, no throw", async () => {
  const e = ev("platform.authz.decision.v1", authz(), platformCtx({ targetTenantId: "unknown" }));
  assert.strictEqual(await runPlatformAuditHandler({ ...e, log }), false);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(log.warnings.map(([m, o]) => [m, o.reason]), [["PlatformAuditEventRejected", "invalid_tenant_value"]]);
});

// ── tenant lifecycle copy ────────────────────────────────────────────────────
test("tenant-visible TENANT_CREATED copy: owned by the new tenant, platform / null / new, no platform detail", async () => {
  assert.deepStrictEqual([...TENANT_LIFECYCLE_EVENT_TYPES], ["tenant.lifecycle.created.v1", "tenant.lifecycle.changed.v1"]); // + Z6
  const payload = { tenantId: NEW, eventId: "ev-copy-1", correlationId: "corr-z5", timestamp: "2026-10-29T10:00:00.000Z", data: { tenantId: NEW }, metadata: { service: "user-service", auditContext: { actorScope: "platform", actorTenantId: null, targetTenantId: NEW } } };
  assert.strictEqual(await runTenantGatedHandler({ payload, messageContext: { headers: { "x-tenant-id": NEW } }, handler: handleTenantLifecycleEvent, eventType: "tenant.lifecycle.created.v1", exchange: "user.events", log }), true);
  const ins = calls.find((c) => /INSERT INTO audit_logs/.test(c.text));
  const p = ins.params;
  // INSERT order: tenant_id, event_type, exchange, service, action, resource_type, resource_id, actor_id, ...
  assert.deepStrictEqual([p[0], p[4], p[5], p[6], p[7], p[15], p[16], p[17]], [NEW, "TENANT_CREATED", "tenant", NEW, null, "platform", null, NEW]);
  assert.ok(!JSON.stringify(p).includes(PID) && !JSON.stringify(p).includes(A), "no principal id, no sign-in tenant");
  assert.strictEqual(p[9], "corr-z5");
});

test("tenant copy stays A1-gated: placeholder / mismatched owner skipped; a platform-scope copy cannot target another tenant", async () => {
  const mk = (tenantId, auditContext, header = tenantId) => runTenantGatedHandler({ payload: { tenantId, eventId: "x", data: {}, metadata: { auditContext } }, messageContext: { headers: { "x-tenant-id": header } }, handler: handleTenantLifecycleEvent, eventType: "tenant.lifecycle.created.v1", exchange: "user.events", log });
  assert.strictEqual(await mk("unknown", { actorScope: "platform", targetTenantId: NEW }), false);
  assert.strictEqual(await mk(NEW, { actorScope: "platform", targetTenantId: NEW }, B), false);
  assert.strictEqual(await mk(NEW, { actorScope: "platform", targetTenantId: B }), false);
  assert.ok(!calls.some((c) => /INSERT/.test(c.text)));
});

// ── schema / source guards ───────────────────────────────────────────────────
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|--|\*).*$/gm, "");
const migrate = fs.readFileSync(path.join(SRC, "db", "migrate.js"), "utf8");
const table = /CREATE TABLE IF NOT EXISTS platform_audit_logs \(([\s\S]*?)\n\s*\)`/.exec(migrate)?.[1] || "";
test("schema: platform_audit_logs has no tenant_id ownership column; scope / tenant-id / result CHECKs; UNIQUE(event_id)", () => {
  assert.ok(table, "table definition present");
  assert.ok(!/^\s*tenant_id\b/m.test(table), "no tenant_id column");
  for (const col of ["event_id", "event_type", "action", "actor_scope", "actor_id", "target_tenant_id", "permission", "allowed", "result", "reason", "operation", "correlation_id", "metadata", "occurred_at", "created_at"]) {
    assert.match(table, new RegExp(`^\\s*${col}\\s`, "m"), col);
  }
  assert.match(table, /actor_scope IN \('platform', 'system', 'tenant'\)/);
  assert.match(table, /\(actor_scope = 'tenant'\) = \(actor_tenant_id IS NOT NULL\)/);
  assert.match(table, /target_tenant_id ~ '\^\[0-9a-f\]\{24\}\$'/);
  assert.match(migrate, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_audit_event_id ON platform_audit_logs \(event_id\)/);
  assert.match(migrate, /tenant_id\s+TEXT\s+NOT NULL/, "audit_logs.tenant_id stays NOT NULL");
  const rb = fs.readFileSync(path.join(SRC, "db", "rollback-z5.sql"), "utf8").replace(/^--.*$/gm, "");
  assert.ok(/DROP TABLE IF EXISTS platform_audit_logs/.test(rb) && !/audit_logs\b/.test(rb.replace(/platform_audit_logs/g, "")), "rollback touches only the platform table");
});

test("historical rows untouched: no migration statement updates or rewrites audit_logs rows", () => {
  assert.ok(!/UPDATE\s+audit_logs|ALTER COLUMN|DROP/i.test(migrate.replace(/DELETE FROM audit_logs[\s\S]*?;/, "")));
});

test("tenant APIs cannot read platform_audit_logs: only the migration, rollback and the write-only model reference it", () => {
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs|sql)$/.test(f.name) && stripComments(fs.readFileSync(p, "utf8")).includes("platform_audit_logs")) hits.push(path.relative(SRC, p)); } };
  walk(SRC);
  assert.deepStrictEqual(hits.sort(), ["db/migrate.js", "db/rollback-z5.sql", "models/platformAuditLog.model.js"]);
  assert.ok(!/SELECT/i.test(fs.readFileSync(path.join(SRC, "models", "platformAuditLog.model.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")), "the model has no read query");
});

test("consumer wiring: platform queue -> platform gate (no tenant handler); every other queue stays tenant-gated", () => {
  const src = fs.readFileSync(path.join(SRC, "rabbitMQ", "index.js"), "utf8");
  assert.match(src, /setupQueue\(QUEUES\.platform, \[[\s\S]*?\], null, \{ platform: true \}\)/);
  assert.match(src, /runPlatformAuditHandler\(\{ payload, messageContext, eventType: key, log: logger \}\)/);
  assert.match(src, /runTenantGatedHandler\(\{/);
  assert.strictEqual((stripComments(src).match(/platform: true/g) || []).length, 1);
  assert.ok(!fs.existsSync(path.join(SRC, "rabbitMQ", "listeners", "platform.listener.js")), "no tenant-owned platform listener left");
});
