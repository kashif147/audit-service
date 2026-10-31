import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

// Phase B / Z5-Z6: tenant-visible lifecycle / configuration copies of platform tenant administration.
// The authoritative security record (principal, permission, outcome) is the platform_audit_logs row
// (../platformAudit.js); these rows are only the affected tenant's own history: owned by that tenant (A1
// envelope tenant, gated like every tenant listener), actor_scope platform, actor_tenant_id NULL, target = that
// tenant. They deliberately carry no principal id, operator, sign-in tenant, permission or other platform
// detail. Both rows share correlation_id; metadata.platformEventType names the authoritative event.
//
//   tenant.lifecycle.created.v1  (Z5) a platform tenant creation, owned by the NEW tenant.
//   tenant.lifecycle.changed.v1  (Z6) an approved cross-tenant change: data.action must be one of
//                                TENANT_COPY_ACTIONS and data.tenantId the envelope tenant; anything else is
//                                logged and skipped (never thrown - a throw republishes the message).
//                                (Z9) action TENANT_ROLE_MIGRATED: the tenant's legacy SU -> ASU role migration
//                                by the reserved SYSTEM actor (scripts/migrate-su-to-asu.js) - actor_scope
//                                "system", counts / status / run id only (roleMigrationAfter).
export const TENANT_LIFECYCLE_EVENT_TYPES = Object.freeze(["tenant.lifecycle.created.v1", "tenant.lifecycle.changed.v1"]);

// action -> resource type. Reads, denials, connect-start, test and tenant delete are platform-only (no copy).
export const TENANT_COPY_ACTIONS = Object.freeze({
  TENANT_UPDATED: "tenant",
  TENANT_SUSPENDED: "tenant",
  TENANT_REACTIVATED: "tenant",
  TENANT_STATUS_CHANGED: "tenant",
  AUTH_CONNECTION_ADDED: "auth_connection",
  AUTH_CONNECTION_UPDATED: "auth_connection",
  AUTH_CONNECTION_REMOVED: "auth_connection",
  AUTH_CONNECTION_CONNECTED: "auth_connection",
  AUTH_CONNECTION_DISCONNECTED: "auth_connection",
});
const SECTIONS = new Set(["profile", "status", "organisation-profile", "branding", "branding-asset", "regional-settings", "auth-connections"]);
const STATUSES = new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "PENDING"]);
const OBJECT_ID = /^[0-9a-f]{24}$/;

// Phase B / Z9: the tenant role migration record. Exactly SU -> ASU; counts are small non-negative integers.
export const ROLE_MIGRATION_ACTION = "TENANT_ROLE_MIGRATED";
export const ROLE_MIGRATION_ACTOR = "platform:migration";
const ROLE_MIGRATION_OUTCOMES = new Set(["migrated", "partial", "blocked", "error"]);
const RUN_ID = /^z9-[0-9]{14}-[0-9a-f]{6}$/;
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 1000000 ? v : null);

/** null when the record is not an exact, well-formed SU -> ASU migration (then it is rejected). */
export function roleMigrationAfter(data) {
  if (data.actorId !== ROLE_MIGRATION_ACTOR || data.fromRole !== "SU" || data.toRole !== "ASU") return null;
  if (!ROLE_MIGRATION_OUTCOMES.has(data.outcome) || typeof data.runId !== "string" || !RUN_ID.test(data.runId)) return null;
  const after = { fromRole: "SU", toRole: "ASU", outcome: data.outcome, runId: data.runId };
  for (const k of ["affectedUsers", "affectedConnections", "permissionsAdded", "suRolesRetired"]) {
    const c = count(data[k]);
    if (c === null) return null;
    after[k] = c;
  }
  return after;
}

// The allow-listed, safe "after" of a change copy: section, status values, connection id. Never a body field.
function changeAfter(data) {
  const after = {};
  if (SECTIONS.has(data.section)) after.section = data.section;
  if (STATUSES.has(data.fromStatus)) after.fromStatus = data.fromStatus;
  if (STATUSES.has(data.toStatus)) after.toStatus = data.toStatus;
  if (typeof data.connectionId === "string" && OBJECT_ID.test(data.connectionId)) after.connectionId = data.connectionId;
  return after;
}

export async function handleTenantLifecycleEvent(payload, eventType, exchange) {
  if (eventType === "tenant.lifecycle.created.v1") {
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
    return;
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  if (data.action === ROLE_MIGRATION_ACTION) {
    const after = roleMigrationAfter(data);
    if (!after || data.tenantId !== payload.tenantId) {
      logger.warn({ eventType, eventId: payload.eventId, reason: after ? "tenant_mismatch" : "malformed_role_migration" }, "TenantLifecycleCopyRejected");
      return;
    }
    await createAuditLog({
      tenantId:      payload.tenantId,
      eventType,
      exchange,
      service:       "user-service",
      action:        ROLE_MIGRATION_ACTION,
      resourceType:  "role",
      resourceId:    payload.tenantId,
      actorId:       ROLE_MIGRATION_ACTOR,
      actorEmail:    null,
      correlationId: payload.correlationId,
      eventId:       payload.eventId,
      after,
      auditContext:  { actorScope: "system", actorTenantId: null, targetTenantId: payload.tenantId },
      metadata:      { service: "user-service", migration: "z9-su-to-asu" },
      occurredAt:    new Date(payload.timestamp || Date.now()),
    });
    logger.debug({ eventType }, "Tenant role migration audited");
    return;
  }
  const resourceType = typeof data.action === "string" && Object.prototype.hasOwnProperty.call(TENANT_COPY_ACTIONS, data.action)
    ? TENANT_COPY_ACTIONS[data.action] : null;
  if (!resourceType || data.tenantId !== payload.tenantId) {
    logger.warn({ eventType, eventId: payload.eventId, reason: resourceType ? "tenant_mismatch" : "unknown_action" }, "TenantLifecycleCopyRejected");
    return;
  }
  const after = changeAfter(data);
  await createAuditLog({
    tenantId:      payload.tenantId,
    eventType,
    exchange,
    service:       "user-service",
    action:        data.action,
    resourceType,
    resourceId:    resourceType === "auth_connection" && after.connectionId ? after.connectionId : payload.tenantId,
    actorId:       null,
    actorEmail:    null,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after,
    auditContext:  { actorScope: "platform", actorTenantId: null, targetTenantId: payload.tenantId },
    metadata:      { service: "user-service", platformEventType: "platform.tenant.admin.changed.v1" },
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });
  logger.debug({ eventType }, "Tenant lifecycle change audited");
}
