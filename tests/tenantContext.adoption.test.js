// Phase 1A adoption — audit-service tenant-context guard (WARN MODE).
// Native node:test (ESM).  Run: node --test tests/tenantContext.adoption.test.js
//
// audit-service establishes trusted identity/tenant in a GLOBAL `ensureAuthenticated`
// mounted on `/api`. The guard is mounted once, globally, right after it:
//   app.use("/api", ensureAuthenticated, tenantContextWarn, routes)
// Ordering: ensureAuthenticated -> tenantContextWarn -> requirePermission -> handler.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Must be set before importing anything that pulls in logging-lib.
process.env.LOG_ROOT =
  process.env.LOG_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "audit-tenantctx-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const test = (await import("node:test")).default;
const assert = (await import("node:assert")).default;

const policyMw = await import("@membership/policy-middleware");
const { tenantContextMiddleware, resolveTenantContext } = policyMw;
const mw = await import("../src/middlewares/tenantContext.mw.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

const TRUSTED = "68cbf7806080b4621d469d34";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaa";

function gatewayReq(o = {}) {
  return {
    method: "GET",
    url: "/api/audit-logs",
    originalUrl: "/api/audit-logs",
    headers: {
      "x-jwt-verified": "true",
      "x-auth-source": "gateway",
      "x-user-id": "U1",
      "x-tenant-id": TRUSTED,
      ...(o.headers || {}),
    },
    ctx: o.ctx !== undefined ? o.ctx : { tenantId: TRUSTED, userId: "U1" },
    tenantId: o.tenantId,
    body: o.body,
    query: o.query,
    params: o.params,
  };
}
function mkRes() {
  const r = { statusCode: null, _s: [] };
  r.status = (c) => ((r.statusCode = c), r._s.push(c), r);
  r.json = () => r;
  return r;
}
function run(req) {
  const res = mkRes();
  const orig = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (s) => (chunks.push(typeof s === "string" ? s : s.toString()), true);
  let n = 0;
  try {
    mw.tenantContextWarn(req, res, () => (n += 1));
  } finally {
    process.stdout.write = orig;
  }
  const rows = chunks
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { req, res, nextCount: n, rows };
}

const appSrc = () => read("src/app.js");

// ---- static structure ----
test("1 tenantContextWarn exists (exported, callable)", () => {
  assert.equal(typeof mw.tenantContextWarn, "function");
});
test("2 guard mode is warn; no enforce", () => {
  const src = read(path.join("src", "middlewares", "tenantContext.mw.js"));
  assert.match(src, /tenantContextMiddleware\(\{\s*mode:\s*"warn"\s*\}\)/);
  assert.ok(!/mode:\s*"enforce"/.test(src));
});
test("3 app.js imports tenantContextWarn", () => {
  assert.match(appSrc(), /import\s*\{\s*tenantContextWarn\s*\}\s*from\s*"\.\/middlewares\/tenantContext\.mw\.js"/);
});
test("4 authenticated mount order: ensureAuthenticated -> tenantContextWarn -> routes", () => {
  assert.match(
    appSrc(),
    /app\.use\(\s*"\/api",\s*ensureAuthenticated,\s*tenantContextWarn,\s*routes\s*\)/
  );
});
test("5 exactly one global tenantContextWarn mount (single app.use with the guard)", () => {
  const mounts = (appSrc().match(/app\.use\([^)]*tenantContextWarn[^)]*\)/g) || []).length;
  assert.equal(mounts, 1);
});
test("6 all 5 authenticated routes covered by the single global mount", () => {
  // The 5 routes live in routes/index.js and mount under the guarded /api.
  const routes = read(path.join("src", "routes", "index.js"));
  const defs = (routes.match(/router\.get\(/g) || []).length;
  assert.equal(defs, 5, "5 authenticated GET routes defined");
  // None are individually guarded (coverage is via the global mount only).
  assert.ok(!routes.includes("tenantContextWarn"), "routes must not reference the guard");
});
test("7 /internal/audit-logs mounted before/outside the guarded mount", () => {
  const src = appSrc();
  const iInternal = src.indexOf('app.use("/internal"');
  const iGuard = src.indexOf("tenantContextWarn, routes");
  assert.ok(iInternal > -1 && iGuard > -1 && iInternal < iGuard, "/internal mounted before guarded /api");
  const internalRoutes = read(path.join("src", "routes", "internalAudit.routes.js"));
  assert.ok(!internalRoutes.includes("tenantContextWarn"));
});
test("8 /health outside the guard", () => {
  const src = appSrc();
  assert.match(src, /app\.get\("\/health"/);
  const line = src.split("\n").find((l) => l.includes('app.get("/health"'));
  assert.ok(!line.includes("tenantContextWarn"));
});
test("9 /ready outside the guard", () => {
  const src = appSrc();
  assert.match(src, /app\.get\("\/ready"/);
  const line = src.split("\n").find((l) => l.includes('app.get("/ready"'));
  assert.ok(!line.includes("tenantContextWarn"));
});
test("10 /api/system-logs mounted before the guarded /api mount, no guard", () => {
  const src = appSrc();
  const iSys = src.indexOf("createSystemLogsRouter");
  const iGuard = src.indexOf("tenantContextWarn, routes");
  assert.ok(iSys > -1 && iSys < iGuard, "system-logs mounted before the guarded /api");
  const line = src.split("\n").find((l) => l.includes("createSystemLogsRouter"));
  assert.ok(!line.includes("tenantContextWarn"));
});
test("11 auth.js unchanged by adoption (no guard reference)", () => {
  assert.ok(!read(path.join("src", "middlewares", "auth.js")).includes("tenantContextWarn"));
});
test("12 routes unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("src", "routes", "index.js")).includes("tenantContextWarn"));
  assert.ok(!read(path.join("src", "routes", "internalAudit.routes.js")).includes("tenantContextWarn"));
});
test("13 controllers unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("src", "controllers", "auditLog.controller.js")).includes("tenantContextWarn"));
  assert.ok(!read(path.join("src", "controllers", "internalAudit.controller.js")).includes("tenantContextWarn"));
});
test("14 DB/query code unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("src", "models", "auditLog.model.js")).includes("tenantContextWarn"));
  assert.ok(!read(path.join("src", "config", "db.js")).includes("tenantContextWarn"));
});
test("15 consumers unchanged (no guard reference)", () => {
  assert.ok(!read(path.join("src", "rabbitMQ", "index.js")).includes("tenantContextWarn"));
});
test("16 package.json unchanged (shared-dep SHAs pinned; no guard ref)", () => {
  const pkg = read("package.json");
  assert.match(pkg, /policy-middleware\.git#1d4a3b991c6bb3374e424e220f745b48d41e3ee7/);
  assert.match(pkg, /logging-lib\.git#5fd251bde4ad08ba71cf9844656b5bc126e13b43/);
  assert.match(pkg, /rabbitmq-middleware\.git#db70fb8ae7a6e62f2a96df1f68b41ec4944d5123/);
  assert.ok(!pkg.includes("tenantContextWarn"));
});
test("17 package-lock.json unchanged (resolves the three pins)", () => {
  const lock = read("package-lock.json");
  assert.match(lock, /policy-middleware\.git#1d4a3b991c6bb3374e424e220f745b48d41e3ee7/);
  assert.match(lock, /logging-lib\.git#5fd251bde4ad08ba71cf9844656b5bc126e13b43/);
  assert.match(lock, /rabbitmq-middleware\.git#db70fb8ae7a6e62f2a96df1f68b41ec4944d5123/);
});

// ---- runtime behaviour (WARN, non-blocking) ----
test("18 trusted tenant cannot be replaced by query tenant", () => {
  const { req, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("19 trusted tenant cannot be replaced by body tenant", () => {
  const { req, nextCount } = run(gatewayReq({ body: { tenantId: OTHER } }));
  assert.equal(req.tenantId, TRUSTED);
  assert.equal(nextCount, 1);
});
test("20 mismatch emits TenantContextMismatch (mode=warn, outcome=ignored)", () => {
  const { rows, res } = run(gatewayReq({ query: { tenantId: OTHER } }));
  const row = rows.find((r) => r.eventType === "TenantContextMismatch");
  assert.ok(row, "a TenantContextMismatch row is emitted");
  assert.equal(row.mode, "warn");
  assert.equal(row.outcome, "ignored");
  assert.equal(row.trustedTenantId, TRUSTED);
  assert.ok(row.suppliedSources.includes("query"));
});
test("21 matching tenant emits no mismatch", () => {
  const { rows } = run(gatewayReq({ body: { tenantId: TRUSTED } }));
  assert.equal(rows.find((r) => r.eventType === "TenantContextMismatch"), undefined);
});
test("22 WARN mismatch is non-blocking: next() called, no 403", () => {
  const { res, nextCount } = run(gatewayReq({ query: { tenantId: OTHER } }));
  assert.equal(nextCount, 1);
  assert.equal(res.statusCode, null);
  assert.ok(!res._s.includes(403));
});
test("23 mode remains warn, not enforce", () => {
  const src = read(path.join("src", "middlewares", "tenantContext.mw.js"));
  assert.match(src, /mode:\s*"warn"/);
  assert.ok(!/mode:\s*"enforce"/.test(src));
  assert.equal(typeof tenantContextMiddleware, "function");
  assert.equal(typeof resolveTenantContext, "function");
});
