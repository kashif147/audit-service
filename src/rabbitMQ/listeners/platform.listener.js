import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

// Phase B / Z4: platform-auth security events published by user-service (services/platformAuditService.js).
// actor_scope = platform (metadata.auditContext, validated by the gate and again by createAuditLog);
// tenant_id = the trusted tenant the event happened in (A1 owner), target_tenant_id NULL unless the route
// genuinely targets a tenant. Only allow-listed fields are stored: never a token, oid, issuer or email.
export const PLATFORM_EVENT_TYPES = Object.freeze([
  "platform.claim.decision.v1",
  "platform.authz.decision.v1",
]);

const ACTION = {
  "platform.claim.decision.v1": (d) => (d.decision === "issued" ? "PLATFORM_CLAIM_ISSUED" : "PLATFORM_CLAIM_REFUSED"),
  "platform.authz.decision.v1": (d) => (d.allowed === true ? "PLATFORM_AUTHZ_ALLOWED" : "PLATFORM_AUTHZ_DENIED"),
};
const FIELDS = ["decision", "allowed", "reason", "permission", "mode", "tokenRev", "currentRev", "revMatch", "route", "principalStatus", "permissionCount", "mfa"];

export async function handlePlatformEvent(payload, eventType, exchange) {
  const data = payload.data || {};
  const after = Object.fromEntries(FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));

  await createAuditLog({
    tenantId:      payload.tenantId,
    eventType,
    exchange,
    service:       payload.metadata?.service || "user-service",
    action:        (ACTION[eventType] || (() => "PLATFORM_AUTH_EVENT"))(data),
    resourceType:  "platform_principal",
    resourceId:    data.principalId || null,
    actorId:       data.actorUserId || null,
    actorEmail:    null,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after,
    metadata:      { service: payload.metadata?.service || "user-service", auditContext: payload.metadata?.auditContext },
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType }, "Platform auth event audited");
}
