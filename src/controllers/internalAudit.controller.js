import { createAuditLog } from "../models/auditLog.model.js";
import logger from "../config/logger.js";
import { cleanTenant, isValidTenantId } from "../helpers/tenantValue.js";
import { resolveAuditContext } from "../helpers/auditContext.js";

const fail = (res, status, code, message) =>
  res.status(status).json({ status: "fail", code, message, timestamp: new Date().toISOString() });

const isInternalRequest = (req) => {
  const v = String(req.headers["x-internal-request"] || "").toLowerCase();
  return v === "true" || v === "1";
};

/**
 * Service-to-service audit insert (communication-service campaigns, etc.).
 *
 * Phase A / A1: the owning tenant comes ONLY from the calling service's trusted context, sent as
 * `x-internal-request: true` + `x-tenant-id` (in-network only; the gateway strips both). A body
 * `tenantId` can never decide ownership: if present it must equal the header, otherwise 403.
 * Body must include action.
 *
 * Phase B / Z4: an optional body `auditContext` ({ actorScope, actorTenantId, targetTenantId, loginTenantId })
 * is validated against the trusted header tenant (helpers/auditContext.js): it can describe the actor, never
 * move the row or point a tenant actor at another tenant. Without it the tenant mapping is derived.
 */
export async function postInternalAuditLog(req, res) {
  try {
    const secret = process.env.SERVICE_AUDIT_SECRET;
    if (!secret || req.headers["x-service-secret"] !== secret) {
      return res.status(403).json({
        status: "fail",
        message: "Forbidden",
        timestamp: new Date().toISOString(),
      });
    }

    if (!isInternalRequest(req)) {
      return fail(res, 403, "INTERNAL_CALLER_REQUIRED", "Internal caller required");
    }
    const headerTenant = cleanTenant(req.headers["x-tenant-id"]);
    if (!isValidTenantId(headerTenant)) {
      return fail(res, 400, "TENANT_REQUIRED", "Trusted tenant (x-tenant-id) is required");
    }
    const bodyTenant = cleanTenant(req.body?.tenantId);
    if (bodyTenant && bodyTenant !== headerTenant) {
      logger.warn({ reason: "body_tenant_mismatch" }, "AuditInternalTenantRejected");
      return fail(res, 403, "TENANT_MISMATCH", "Body tenant does not match trusted tenant");
    }
    const tenantId = headerTenant;

    const {
      action,
      resourceType = "campaign",
      resourceId = null,
      actorId = null,
      actorEmail = null,
      metadata = null,
      eventType = "communication.campaign",
      exchange = "communication-service",
      service = "communication-service",
    } = req.body || {};

    // A context nested in metadata is held to the same check (createAuditLog falls back to it).
    const auditContext = req.body?.auditContext ?? req.body?.metadata?.auditContext;
    if (auditContext !== undefined) {
      const ctx = resolveAuditContext({ tenantId, auditContext, actorId });
      if (!ctx.ok) {
        const crossTenant = ["actor_tenant_not_owner", "tenant_actor_cross_tenant", "target_not_owner"].includes(ctx.reason);
        logger.warn({ reason: ctx.reason }, "AuditInternalContextRejected");
        return crossTenant
          ? fail(res, 403, "TENANT_MISMATCH", "Audit context tenant does not match trusted tenant")
          : fail(res, 400, "AUDIT_CONTEXT_INVALID", "Invalid audit actor / target context");
      }
    }

    if (!action) {
      return res.status(400).json({
        status: "fail",
        message: "action is required",
        timestamp: new Date().toISOString(),
      });
    }

    const row = await createAuditLog({
      tenantId,
      eventType,
      exchange,
      service,
      action,
      resourceType,
      resourceId,
      actorId,
      actorEmail,
      metadata,
      auditContext,
    });

    return res.status(201).json({
      status: "success",
      data: { id: row?.id },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    logger.error({ err: e.message }, "internal audit insert failed");
    return res.status(500).json({
      status: "error",
      message: e.message,
      timestamp: new Date().toISOString(),
    });
  }
}
