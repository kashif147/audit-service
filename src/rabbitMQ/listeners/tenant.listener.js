import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

// Phase B / Z5: tenant-visible lifecycle copy of a successful platform tenant creation.
// The authoritative security record (principal, permission, outcome) is the platform_audit_logs row
// written from platform.tenant.created.v1 (../platformAudit.js); this row is only the NEW tenant's own
// history: owned by that tenant (A1 envelope tenant, gated like every tenant listener), actor_scope platform,
// actor_tenant_id NULL, target = the new tenant. It deliberately carries no principal id, operator, sign-in
// tenant, permission or other platform detail. Both rows share correlation_id; metadata.platformEventType
// names the authoritative event.
export const TENANT_LIFECYCLE_EVENT_TYPES = Object.freeze(["tenant.lifecycle.created.v1"]);

export async function handleTenantLifecycleEvent(payload, eventType, exchange) {
  await createAuditLog({
    tenantId:      payload.tenantId,
    eventType,
    exchange,
    service:       "user-service",
    action:        "TENANT_CREATED",
    resourceType:  "tenant",
    resourceId:    payload.tenantId,
    actorId:       null,
    actorEmail:    null,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         { lifecycle: "created" },
    auditContext:  { actorScope: "platform", actorTenantId: null, targetTenantId: payload.tenantId },
    metadata:      { service: "user-service", platformEventType: "platform.tenant.created.v1" },
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType }, "Tenant lifecycle event audited");
}
