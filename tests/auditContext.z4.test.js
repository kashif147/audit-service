// Phase B / Z4 — actor / target-tenant audit context (src/helpers/auditContext.js).
// Native node:test (ESM). Run: node --test --experimental-test-module-mocks tests/auditContext.z4.test.js
//   - resolver matrix: tenant / legacy SU / platform / system / platform-wide; invalid scope, placeholders,
//     cross-tenant and unknown fields fail closed.
//   - createAuditLog: old producers (no context) keep tenant_id and get the derived tenant mapping;
//     the three new columns are written; an invalid context is refused BEFORE any DB access.
//   - RabbitMQ gate and POST /internal/audit-logs: a context can never move a row or point a tenant actor
//     at another tenant; body-controlled tenants are ignored / refused.
//   - platform listener stores only allow-listed fields; migration is additive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOG_ROOT = process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-z4-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SERVICE_AUDIT_SECRET = "test-only-audit-secret";

const { test, mock } = await import("node:test");
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

const { resolveAuditContext, SYSTEM_ACTORS, isInternalTenantId } = await import("../src/helpers/auditContext.js");
const { createAuditLog } = await import("../src/models/auditLog.model.js");
const { runTenantGatedHandler } = await import("../src/rabbitMQ/eventTenant.js");
const { postInternalAuditLog } = await import("../src/controllers/internalAudit.controller.js");
const { handlePlatformEvent, PLATFORM_EVENT_TYPES } = await import("../src/rabbitMQ/listeners/platform.listener.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const A = "68cbf7806080b4621d469d34";
const B = "6acd6119b28a863c61361ae0";
const ok = (actorScope, actorTenantId, targetTenantId, loginTenantId = null) => ({ ok: true, actorScope, actorTenantId, targetTenantId, loginTenantId });
const lastInsert = () => {
  const c = [...calls].reverse().find((x) => /INSERT INTO audit_logs/.test(x.text));
  const p = c.params;
  return { tenantId: p[0], actorId: p[7], metadata: p[13] && JSON.parse(p[13]), after: p[12] && JSON.parse(p[12]), actorScope: p[15], actorTenantId: p[16], targetTenantId: p[17] };
};
const base = { eventType: "x.v1", exchange: "x.events", service: "svc", action: "X" };

// ── resolver: the §9 examples ─────────────────────────────────────────────────
test("normal tenant user (no context, every existing producer): tenant / A / A", () => {
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A }), ok("tenant", A, A));
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant" } }), ok("tenant", A, A));
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", actorTenantId: A, targetTenantId: A } }), ok("tenant", A, A));
});
test("legacy SU is a tenant actor: tenant / A / A, and can never target B", () => {
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", actorTenantId: A } }), ok("tenant", A, A));
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", actorTenantId: A, targetTenantId: B } }), { ok: false, reason: "tenant_actor_cross_tenant" });
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", actorTenantId: B } }), { ok: false, reason: "actor_tenant_not_owner" });
});
test("platform principal: platform / null / null; login tenant kept only as context", () => {
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform" } }), ok("platform", null, null));
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform", loginTenantId: A } }), ok("platform", null, null, A));
  // authority never from a tenant: a platform actor carrying actorTenantId is refused
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform", actorTenantId: A } }), { ok: false, reason: "non_tenant_actor_has_actor_tenant" });
});
test("platform target: only an explicit target equal to the owner tenant in Z4 (no cross-tenant before Z5/Z6)", () => {
  assert.deepStrictEqual(resolveAuditContext({ tenantId: B, auditContext: { actorScope: "platform", targetTenantId: B } }), ok("platform", null, B));
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform", targetTenantId: B } }), { ok: false, reason: "target_not_owner" });
});
test("platform-wide catalogue action: platform actor, target null", () => {
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform", targetTenantId: null } }), ok("platform", null, null));
});
test("system migration / provisioning: system / null / B when operating on B; no fake tenant", () => {
  for (const actorId of SYSTEM_ACTORS) {
    assert.deepStrictEqual(resolveAuditContext({ tenantId: B, actorId, auditContext: { actorScope: "system", targetTenantId: B } }), ok("system", null, B));
  }
  assert.deepStrictEqual(resolveAuditContext({ tenantId: B, actorId: "platform:migration", auditContext: { actorScope: "system" } }), { ok: false, reason: "system_actor_requires_target" });
  assert.deepStrictEqual(resolveAuditContext({ tenantId: B, actorId: "someone", auditContext: { actorScope: "system", targetTenantId: B } }), { ok: false, reason: "unknown_system_actor" });
  assert.deepStrictEqual(resolveAuditContext({ tenantId: B, actorId: "platform:migration", auditContext: { actorScope: "system", actorTenantId: B, targetTenantId: B } }), { ok: false, reason: "non_tenant_actor_has_actor_tenant" });
});
test("malformed actor scope fails closed", () => {
  for (const s of ["", "TENANT", "admin", "su", "platform:*", null, 1, undefined]) {
    assert.strictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: s } }).ok, false, String(s));
  }
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: "tenant" }), { ok: false, reason: "malformed_context" });
  assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", tenantId: B } }), { ok: false, reason: "unknown_context_field" });
});
test("no placeholder / non-internal tenant values are accepted in the new fields", () => {
  for (const v of ["unknown", "default", "system", "null", "undefined", "MULTIAUTH", "68CBF7806080B4621D469D34", "x".repeat(24), `${A} `]) {
    assert.strictEqual(isInternalTenantId(v), false, v);
    assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "platform", targetTenantId: v } }), { ok: false, reason: "invalid_tenant_value" }, v);
    assert.deepStrictEqual(resolveAuditContext({ tenantId: A, auditContext: { actorScope: "tenant", actorTenantId: v } }), { ok: false, reason: "invalid_tenant_value" }, v);
  }
});

// ── createAuditLog ────────────────────────────────────────────────────────────
test("old producer compatibility: no context -> tenant_id unchanged, derived tenant / A / A columns", async () => {
  await createAuditLog({ tenantId: A, ...base, actorId: "u1", metadata: { service: "profile-service" } });
  const r = lastInsert();
  assert.deepStrictEqual([r.tenantId, r.actorScope, r.actorTenantId, r.targetTenantId], [A, "tenant", A, A]);
});
test("existing A1 tenant contract unchanged: placeholder / missing tenant still refused first", async () => {
  for (const t of ["unknown", "", undefined, "default"]) {
    await assert.rejects(() => createAuditLog({ tenantId: t, ...base, auditContext: { actorScope: "platform" } }), (e) => e.code === "AUDIT_TENANT_REQUIRED");
  }
});
test("platform context from metadata.auditContext is stored; tenant_id stays the owner", async () => {
  await createAuditLog({ tenantId: A, ...base, metadata: { auditContext: { actorScope: "platform", loginTenantId: A } } });
  const r = lastInsert();
  assert.deepStrictEqual([r.tenantId, r.actorScope, r.actorTenantId, r.targetTenantId], [A, "platform", null, null]);
});
test("an invalid context is refused before any DB access (AUDIT_CONTEXT_INVALID)", async () => {
  const before = calls.length;
  for (const auditContext of [{ actorScope: "root" }, { actorScope: "tenant", targetTenantId: B }, { actorScope: "platform", targetTenantId: "unknown" }]) {
    await assert.rejects(() => createAuditLog({ tenantId: A, ...base, auditContext }), (e) => e.code === "AUDIT_CONTEXT_INVALID");
  }
  assert.strictEqual(calls.length, before);
});

// ── RabbitMQ gate ─────────────────────────────────────────────────────────────
const fakeLog = () => {
  const c = [];
  return { c, warn: (o, m) => c.push({ o, m }) };
};
test("gate: a payload context pointing a tenant actor at another tenant is skipped, not written", async () => {
  const log = fakeLog();
  let called = 0;
  const ran = await runTenantGatedHandler({
    payload: { tenantId: A, data: {}, metadata: { auditContext: { actorScope: "tenant", targetTenantId: B } } },
    handler: async () => { called++; }, eventType: "x", exchange: "y", log,
  });
  assert.deepStrictEqual([ran, called, log.c[0].m, log.c[0].o.reason], [false, 0, "AuditEventContextRejected", "tenant_actor_cross_tenant"]);
});
test("gate: invalid scope skipped; no context or a valid platform context passes; tenant still A1-gated first", async () => {
  assert.strictEqual(await runTenantGatedHandler({ payload: { tenantId: A, metadata: { auditContext: { actorScope: "god" } } }, handler: async () => {}, eventType: "x", exchange: "y", log: fakeLog() }), false);
  assert.strictEqual(await runTenantGatedHandler({ payload: { tenantId: A, metadata: {} }, handler: async () => {}, eventType: "x", exchange: "y", log: fakeLog() }), true);
  assert.strictEqual(await runTenantGatedHandler({ payload: { tenantId: A, metadata: { auditContext: { actorScope: "platform", loginTenantId: A } } }, handler: async () => {}, eventType: "x", exchange: "y", log: fakeLog() }), true);
  const log = fakeLog();
  assert.strictEqual(await runTenantGatedHandler({ payload: { metadata: { auditContext: { actorScope: "platform" } } }, handler: async () => {}, eventType: "x", exchange: "y", log }), false);
  assert.strictEqual(log.c[0].m, "AuditEventTenantRejected"); // a platform event still needs a trusted owner tenant
});

// ── internal HTTP ─────────────────────────────────────────────────────────────
const mkRes = () => {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};
const internal = (body, headers = {}) => ({ headers: { "x-service-secret": "test-only-audit-secret", "x-internal-request": "true", "x-tenant-id": A, ...headers }, body: { action: "CAMPAIGN_SENT", ...body } });
test("internal: no context -> 201 with the derived tenant mapping (old producers unchanged)", async () => {
  const res = mkRes();
  await postInternalAuditLog(internal({}), res);
  assert.strictEqual(res.statusCode, 201);
  const r = lastInsert();
  assert.deepStrictEqual([r.tenantId, r.actorScope, r.actorTenantId, r.targetTenantId], [A, "tenant", A, A]);
});
test("internal: body cannot override the tenant - top-level actor/target fields are ignored", async () => {
  const res = mkRes();
  await postInternalAuditLog(internal({ actorScope: "platform", actorTenantId: B, targetTenantId: B }), res);
  assert.strictEqual(res.statusCode, 201);
  const r = lastInsert();
  assert.deepStrictEqual([r.tenantId, r.actorScope, r.actorTenantId, r.targetTenantId], [A, "tenant", A, A]);
});
test("internal: a body / metadata context targeting another tenant -> 403; malformed -> 400", async () => {
  for (const body of [{ auditContext: { actorScope: "tenant", targetTenantId: B } }, { metadata: { auditContext: { actorScope: "tenant", actorTenantId: B } } }, { auditContext: { actorScope: "platform", targetTenantId: B } }]) {
    const res = mkRes();
    await postInternalAuditLog(internal(body), res);
    assert.deepStrictEqual([res.statusCode, res.body.code], [403, "TENANT_MISMATCH"]);
  }
  const res = mkRes();
  await postInternalAuditLog(internal({ auditContext: { actorScope: "superuser" } }), res);
  assert.deepStrictEqual([res.statusCode, res.body.code], [400, "AUDIT_CONTEXT_INVALID"]);
});

// ── platform listener ─────────────────────────────────────────────────────────
test("platform listener: platform / null / null row, allow-listed fields only (no oid, issuer, email, token)", async () => {
  assert.deepStrictEqual([...PLATFORM_EVENT_TYPES].sort(), ["platform.authz.decision.v1", "platform.claim.decision.v1"]);
  await handlePlatformEvent({
    tenantId: A, eventId: "ev-z4-1", correlationId: "c1",
    data: { allowed: false, reason: "permission_missing", permission: "platform:cache:admin", principalId: "6a0000000000000000000a03", actorUserId: "u9", mode: "shadow", tokenRev: 2, currentRev: 2, oid: "aaaa", issuer: "https://x", email: "x@y", token: "eyJ" },
    metadata: { service: "user-service", auditContext: { actorScope: "platform", loginTenantId: A } },
  }, "platform.authz.decision.v1", "user.events");
  const r = lastInsert();
  assert.deepStrictEqual([r.tenantId, r.actorScope, r.actorTenantId, r.targetTenantId, r.actorId], [A, "platform", null, null, "u9"]);
  assert.deepStrictEqual(Object.keys(r.after).sort(), ["allowed", "currentRev", "mode", "permission", "reason", "tokenRev"]);
  assert.ok(!/aaaa|https:\/\/x|x@y|eyJ/.test(JSON.stringify(r)));
});

// ── migration is additive ─────────────────────────────────────────────────────
test("migration: only ADD COLUMN IF NOT EXISTS (nullable) + a scope CHECK; tenant_id stays NOT NULL; no new index", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "db", "migrate.js"), "utf8");
  assert.match(src, /ADD COLUMN IF NOT EXISTS actor_scope\s+TEXT`/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS actor_tenant_id\s+TEXT`/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS target_tenant_id TEXT`/);
  assert.match(src, /tenant_id\s+TEXT\s+NOT NULL/);
  assert.ok(!/DROP|ALTER COLUMN|UPDATE audit_logs/i.test(src.replace(/DELETE FROM audit_logs[\s\S]*?;/, "")));
  assert.ok(!/INDEX[^\n]*(actor_scope|actor_tenant_id|target_tenant_id)/.test(src));
});
