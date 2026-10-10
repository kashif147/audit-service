// Phase 2B0 — GET /api/audit-logs/:id is tenant-scoped (IDOR fix).
//
// Before: `SELECT * FROM audit_logs WHERE id = $1` — any `audit:read` caller could enumerate the
// BIGSERIAL id and read another tenant's before/after state.
// After:  `... WHERE id = $1 AND tenant_id = $2`, tenant from the trusted context only
//         (ensureAuthenticated -> tenantContextWarn), never the raw x-tenant-id header or
//         ?tenantId=. Cross-tenant, unknown and non-numeric ids all return the same 404.
//
// Drives the real app (src/app.js: ensureAuthenticated -> tenantContextWarn -> routes) over
// HTTP. db.js is replaced by an in-memory table that honours the WHERE clause actually sent,
// and the policy wrapper by an allow-all stub (the PDP is not under test here).
//
// Run: node --test --experimental-test-module-mocks tests/auditLogGetById.tenantScope.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-getbyid-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "audit-getbyid-test-secret";

const { test, mock } = await import("node:test");
const assert = (await import("node:assert")).default;
const jwt = (await import("jsonwebtoken")).default;

const TENANT_A = "68cbf7806080b4621d469d34";
const TENANT_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

// id 101 belongs to A, id 102 belongs to B.
const ROWS = [
  { id: "101", tenant_id: TENANT_A, action: "UPDATE", after_state: { secret: "A-only" } },
  { id: "102", tenant_id: TENANT_B, action: "UPDATE", after_state: { secret: "B-only" } },
];
const seen = [];

function fakeQuery(text, params = []) {
  seen.push({ text, params });
  const sql = text.replace(/\s+/g, " ").trim();
  if (/^SELECT \* FROM audit_logs WHERE id = \$1 AND tenant_id = \$2$/.test(sql)) {
    return { rows: ROWS.filter((r) => r.id === String(params[0]) && r.tenant_id === params[1]) };
  }
  if (/^SELECT \* FROM audit_logs WHERE id = \$1$/.test(sql)) {
    return { rows: ROWS.filter((r) => r.id === String(params[0])) };
  }
  throw new Error(`unexpected SQL in test: ${sql}`);
}

const dbUrl = new URL("../src/config/db.js", import.meta.url).href;
mock.module(dbUrl, {
  namedExports: {
    query: async (text, params) => fakeQuery(text, params),
    getPool: () => ({ query: async (t, p) => fakeQuery(t, p) }),
    connectDB: async () => {},
    disconnectDB: async () => {},
  },
});
const allow = () => (req, res, next) => next();
const policyUrl = new URL("../src/middlewares/policy.middleware.js", import.meta.url).href;
mock.module(policyUrl, {
  namedExports: { defaultPolicyMiddleware: { requirePermission: allow } },
  defaultExport: { requirePermission: allow },
});

const { default: app } = await import("../src/app.js");

async function get(url, headers = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const gateway = (tenantId) => ({
  "x-jwt-verified": "true",
  "x-auth-source": "gateway",
  "x-user-id": `user-of-${tenantId}`,
  "x-tenant-id": tenantId,
  "x-user-roles": "[]",
  "x-user-permissions": '["audit:read"]',
});

test("A tenant A reads its own row", async () => {
  const res = await get("/api/audit-logs/101", gateway(TENANT_A));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.id, "101");
  assert.strictEqual(res.body.data.after_state.secret, "A-only");
});

test("B tenant B cannot read tenant A's row (404, no data)", async () => {
  const res = await get("/api/audit-logs/101", gateway(TENANT_B));
  assert.strictEqual(res.status, 404);
  assert.doesNotMatch(res.text, /A-only/);
});

test("C a guessed sequential id returns the same 404 as another tenant's id", async () => {
  const unknown = await get("/api/audit-logs/103", gateway(TENANT_B));
  const foreign = await get("/api/audit-logs/101", gateway(TENANT_B));
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(foreign.status, 404);
  assert.strictEqual(unknown.body.message, foreign.body.message);
});

test("D the DB query always carries id + the trusted tenant", async () => {
  seen.length = 0;
  await get("/api/audit-logs/102", gateway(TENANT_B));
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0].text, /WHERE id = \$1 AND tenant_id = \$2/);
  assert.deepStrictEqual(seen[0].params, ["102", TENANT_B]);
});

test("E ?tenantId= cannot widen access (trusted tenant B, query names A)", async () => {
  const res = await get(`/api/audit-logs/101?tenantId=${TENANT_A}`, gateway(TENANT_B));
  assert.strictEqual(res.status, 404);
  assert.doesNotMatch(res.text, /A-only/);
});

test("F raw x-tenant-id is ignored on the Bearer path (token tenant B, header names A)", async () => {
  const token = jwt.sign({ sub: "u-b", tenantId: TENANT_B }, process.env.JWT_SECRET, { expiresIn: "5m" });
  const res = await get("/api/audit-logs/101", {
    authorization: `Bearer ${token}`,
    "x-tenant-id": TENANT_A,
  });
  assert.strictEqual(res.status, 404);
  assert.doesNotMatch(res.text, /A-only/);
});

test("G non-numeric id returns 404 without reaching the database", async () => {
  seen.length = 0;
  const res = await get("/api/audit-logs/1%20OR%201=1", gateway(TENANT_A));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(seen.length, 0);
});
