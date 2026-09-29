import { tenantContextMiddleware } from "@membership/policy-middleware";

/**
 * Phase 1A canonical tenant-context guard — WARN MODE ONLY (non-blocking).
 *
 * Mounted globally on the authenticated API right AFTER `ensureAuthenticated`
 * (the trusted identity/tenant-establishing middleware) and BEFORE the per-route
 * `requirePermission(...)` / controller chain:
 *   ensureAuthenticated -> tenantContextWarn -> requirePermission -> handler
 *
 * It observes the trusted tenant already on req.ctx/req.user/req.tenantId,
 * re-pins req.tenantId to it, and LOGS any caller-supplied (body/query/params)
 * tenantId that disagrees as a non-blocking TenantContextMismatch event. It
 * never returns 403.
 *
 * Note (AUD2 / Phase 1C): the audit read controllers currently read
 * `req.headers["x-tenant-id"] || req.query.tenantId` rather than the trusted
 * `req.tenantId`, so this WARN guard is observational here — it surfaces
 * mismatches without changing controller query behaviour. Switching controllers
 * to the trusted tenant is deferred to Phase 1C.
 */
export const tenantContextWarn = tenantContextMiddleware({ mode: "warn" });
