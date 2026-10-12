// Phase 2C — every audit read uses the trusted tenant, never the raw x-tenant-id header or ?tenantId=.
//
// getAuditLog (/:id) was fixed in e8c8756; list, summary, member and resource history still read
// `req.headers["x-tenant-id"] || req.query.tenantId`. On the Bearer path (ensureAuthenticated
// verifies the JWT itself) that header is caller-controlled, so a tenant-A token plus
// `x-tenant-id: B` (or no header and `?tenantId=B`) read tenant B's audit trail.
//
// Drives the real app (ensureAuthenticated -> tenantContextWarn -> routes) over HTTP. The model
// and db.js are replaced by recorders, the policy wrapper by an allow-all stub.
//
// Run: node --test --experimental-test-module-mocks tests/auditLogReads.tenantScope.test.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-reads-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = "audit-reads-test-secret";

const { test, mock } = await import("node:test");
const assert = (await import("node:assert")).default;
const jwt = (await import("jsonwebtoken")).default;

const TENANT_A = "68cbf7806080b4621d469d34";
const TENANT_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const calls = [];
const record = (fn) => async (...args) => {
  calls.push({ fn, tenantId: fn === "findAuditLogs" || fn === "findMemberAuditLogs" ? args[0].tenantId : args[0] });
  return fn === "findAuditLogs" || fn === "findMemberAuditLogs" ? { total: 0, items: [], rows: [] } : [];
};

mock.module(new URL("../src/models/auditLog.model.js", import.meta.url).href, {
  namedExports: {
    findAuditLogs: record("findAuditLogs"),
    findMemberAuditLogs: record("findMemberAuditLogs"),
    getResourceHistory: record("getResourceHistory"),
    createAuditLog: async () => {},
  },
});
const dbQuery = async (text, params = []) => {
  calls.push({ fn: "query", tenantId: params[0] });
  return { rows: [] };
};
mock.module(new URL("../src/config/db.js", import.meta.url).href, {
  namedExports: {
    query: dbQuery,
    getPool: () => ({ query: dbQuery }),
    connectDB: async () => {},
    disconnectDB: async () => {},
  },
});
const allow = () => (req, res, next) => next();
mock.module(new URL("../src/middlewares/policy.middleware.js", import.meta.url).href, {
  namedExports: { defaultPolicyMiddleware: { requirePermission: allow } },
  defaultExport: { requirePermission: allow },
});

const { default: app } = await import("../src/app.js");

async function get(url, headers = {}) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { headers });
    return { status: res.status };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const bearerA = () => ({
  authorization: `Bearer ${jwt.sign({ sub: "u-a", tenantId: TENANT_A }, process.env.JWT_SECRET, { expiresIn: "5m" })}`,
});
const gatewayA = {
  "x-jwt-verified": "true",
  "x-auth-source": "gateway",
  "x-user-id": "user-of-a",
  "x-tenant-id": TENANT_A,
  "x-user-roles": "[]",
  "x-user-permissions": '["audit:read"]',
};

const ROUTES = [
  ["list", "/api/audit-logs"],
  ["summary", "/api/audit-logs/summary"],
  ["member", "/api/audit-logs/member/p1"],
  ["resource", "/api/audit-logs/resource/application/r1"],
];

for (const [name, route] of ROUTES) {
  test(`${name}: Bearer tenant A + x-tenant-id B reads tenant A only`, async () => {
    calls.length = 0;
    const res = await get(route, { ...bearerA(), "x-tenant-id": TENANT_B });
    assert.strictEqual(res.status, 200);
    assert.ok(calls.length > 0, "handler reached the data layer");
    assert.deepStrictEqual([...new Set(calls.map((c) => c.tenantId))], [TENANT_A]);
  });

  test(`${name}: Bearer tenant A + ?tenantId=B reads tenant A only`, async () => {
    calls.length = 0;
    const sep = route.includes("?") ? "&" : "?";
    const res = await get(`${route}${sep}tenantId=${TENANT_B}`, bearerA());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([...new Set(calls.map((c) => c.tenantId))], [TENANT_A]);
  });

  test(`${name}: gateway tenant A + ?tenantId=B reads tenant A only`, async () => {
    calls.length = 0;
    const res = await get(`${route}?tenantId=${TENANT_B}`, gatewayA);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([...new Set(calls.map((c) => c.tenantId))], [TENANT_A]);
  });
}
