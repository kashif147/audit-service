// Phase B / Z5: platform / system security events -> platform_audit_logs (the authoritative platform store).
//
// Queue audit.platform.events (user.events exchange). These events have NO owning tenant, so they never go
// through the A1 tenant gate (eventTenant.js) and are never written to audit_logs. Instead this gate builds
// one validated record per event and fails closed: an event that is malformed, carries a placeholder /
// non-internal tenant value, an unknown context field, a scope that does not fit the event type, or a
// non-reserved system actor is logged (`PlatformAuditEventRejected`) and skipped - never thrown (a throw
// makes rabbitmq-middleware republish the message) and never stored with a guessed actor or tenant.
//
// Rows (see src/db/migrate.js PLATFORM_AUDIT_TABLE):
//   platform actor  actor_id = PlatformPrincipal id, actor_tenant_id NULL, target NULL (platform-wide) or the
//                   real tenant operated on (tenant create: the NEW tenant). The tenant the caller signed in
//                   to is context only (metadata.loginTenantId) - never an owner, never visibility.
//   tenant actor    only a DENIED platform authorization (legacy SU "*", ASU, ordinary users have no platform
//                   authority): actor_id = the tenant user id, actor_tenant_id = its tenant (truthful
//                   classification - the actor is not relabelled platform).
//   system actor    reserved ids only (platform:principal-admin for the principal-admin script; P1:
//                   platform:provisioning for the platform-template publish script).
// P1: platform.provisioning.run.changed.v1 = a provisioning-run action by a platform principal holding
// platform:provisioning:admin (target = the run's tenant; a refusal may have none). Ids, statuses, counts only.
// Z6: platform.tenant.admin.changed.v1 = the outcome (success / failure) of a cross-tenant tenant-administration
// mutation by a platform principal; target = the tenant from the route, which must equal data.tenantId. Its
// tenant-visible copy (only for approved lifecycle / configuration changes) is a separate event
// (tenant.lifecycle.changed.v1, listeners/tenant.listener.js). Reads and denials are authz decisions only.
// Historical boundary: Z4 wrote platform-auth rows 173-178 (DEV) into audit_logs under the sign-in tenant.
// They stay exactly where they are; from the Z5 cutover every platform / system security event lands here.
// Z4-shaped events (envelope tenant + platform context) still in flight are accepted and stored here too.
//
// Only allow-listed fields are stored: never a token, oid, issuer, email or name.

import { isInternalTenantId, SYSTEM_ACTORS } from "../helpers/auditContext.js";
import { cleanTenant } from "../helpers/tenantValue.js";
import { insertPlatformAuditLog } from "../models/platformAuditLog.model.js";

export const PLATFORM_AUDIT_EVENTS = Object.freeze({
  CLAIM_DECISION: "platform.claim.decision.v1",
  AUTHZ_DECISION: "platform.authz.decision.v1",
  TENANT_CREATED: "platform.tenant.created.v1",
  TENANT_CREATE_FAILED: "platform.tenant.create.failed.v1",
  PRINCIPAL_CHANGED: "platform.principal.changed.v1",
  TENANT_ADMIN_CHANGED: "platform.tenant.admin.changed.v1",
  // Phase B / P1: provisioning control plane
  PROVISIONING_RUN_CHANGED: "platform.provisioning.run.changed.v1",
  PROVISIONING_TEMPLATE_PUBLISHED: "platform.provisioning.template.published.v1",
  // Phase B / P3 prerequisite: a provisioning STEP transition recorded by the orchestrator (system actor) for ONE
  // verified target tenant - the only system event allowed to carry a target tenant.
  PROVISIONING_STEP_CHANGED: "platform.provisioning.step.changed.v1",
});
export const PLATFORM_EVENT_TYPES = Object.freeze(Object.values(PLATFORM_AUDIT_EVENTS));
export const PRINCIPAL_ADMIN_ACTOR = "platform:principal-admin";

const E = PLATFORM_AUDIT_EVENTS;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const PLATFORM_PERMISSION = /^platform:[a-z0-9-]+(?::[a-z0-9-]+)*$/;
const CONTEXT_FIELDS = new Set(["actorScope", "actorTenantId", "targetTenantId", "loginTenantId"]);
const SCOPES_FOR = {
  [E.CLAIM_DECISION]: ["platform"],
  [E.AUTHZ_DECISION]: ["platform", "tenant"],
  [E.TENANT_CREATED]: ["platform"],
  [E.TENANT_CREATE_FAILED]: ["platform"],
  [E.PRINCIPAL_CHANGED]: ["system"],
  [E.TENANT_ADMIN_CHANGED]: ["platform"],
  [E.PROVISIONING_RUN_CHANGED]: ["platform"],
  [E.PROVISIONING_TEMPLATE_PUBLISHED]: ["system"],
  [E.PROVISIONING_STEP_CHANGED]: ["system"],
};
// The narrow exception to "a system actor carries no tenant context": these event types REQUIRE a target tenant
// (and only their reserved actor may emit them). Every other system event keeps refusing a target.
const SYSTEM_TARGET_EVENTS = Object.freeze({ [E.PROVISIONING_STEP_CHANGED]: "platform:provisioning" });
// Allow-listed data fields copied into metadata, per event type.
const META_FIELDS = {
  [E.CLAIM_DECISION]: ["mode", "currentRev", "permissionCount", "mfa", "actorUserId"],
  [E.AUTHZ_DECISION]: ["mode", "tokenRev", "currentRev", "revMatch", "status", "actorUserId"],
  [E.TENANT_CREATED]: ["actorUserId"],
  [E.TENANT_CREATE_FAILED]: ["status", "actorUserId"],
  [E.PRINCIPAL_CHANGED]: ["principalId", "status", "revision", "permissionsAdded", "permissionsRemoved", "operatorLabel", "approvalRef"],
  [E.TENANT_ADMIN_CHANGED]: ["status", "actorUserId", "section", "connectionId", "fromStatus", "toStatus"],
  [E.PROVISIONING_RUN_CHANGED]: ["actorUserId", "runId", "templateKey", "templateVersion", "runStatus", "attempt", "stepCount", "stepsSucceeded", "insertedCount", "skippedCount"],
  [E.PROVISIONING_TEMPLATE_PUBLISHED]: ["templateKey", "templateVersion", "contentHash", "componentCount", "operatorLabel", "approvalRef"],
  [E.PROVISIONING_STEP_CHANGED]: ["runId", "stepKey", "component", "manifestVersion", "attempt", "stepStatus", "runStatus", "insertedCount", "skippedCount", "failureCode"],
};
export const PROVISIONING_STEP_ACTIONS = Object.freeze(["PROVISIONING_STEP_REQUESTED", "PROVISIONING_STEP_SUCCEEDED", "PROVISIONING_STEP_FAILED", "PROVISIONING_STEP_RESULT_REFUSED"]);
const STEP_KEY_V2 = /^psk2:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/;
// Phase B / P1: provisioning-run actions by a platform principal (permission platform:provisioning:admin). A refusal
// may have no target (the request named no existing tenant); every other action targets the run's tenant.
export const PROVISIONING_RUN_ACTIONS = Object.freeze(["PROVISIONING_RUN_CREATED", "PROVISIONING_RUN_REQUESTED_EXISTING", "PROVISIONING_RUN_RESUMED", "PROVISIONING_RUN_REFUSED"]);
const PROVISIONING_PERMISSION = "platform:provisioning:admin";
export const PROVISIONING_ACTOR = "platform:provisioning";
const TEMPLATE_ACTIONS = ["PLATFORM_TEMPLATE_PUBLISHED", "PLATFORM_TEMPLATE_RETIRED"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Phase B / Z6: the outcome of a cross-tenant platform tenant-administration mutation. Each action names
// the exact platform permission that authorizes it (one permission never implies another).
export const TENANT_ADMIN_ACTIONS = Object.freeze({
  TENANT_UPDATED: "platform:tenant:update:any",
  TENANT_SUSPENDED: "platform:tenant:update:any",
  TENANT_REACTIVATED: "platform:tenant:update:any",
  TENANT_STATUS_CHANGED: "platform:tenant:update:any",
  TENANT_DELETED: "platform:tenant:delete:any",
  AUTH_CONNECTION_ADDED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_UPDATED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_REMOVED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_CONNECT_STARTED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_CONNECTED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_TESTED: "platform:tenant:auth-connections:manage:any",
  AUTH_CONNECTION_DISCONNECTED: "platform:tenant:auth-connections:manage:any",
});
const PRINCIPAL_ACTIONS = { create: "PLATFORM_PRINCIPAL_CREATE", disable: "PLATFORM_PRINCIPAL_DISABLE", enable: "PLATFORM_PRINCIPAL_ENABLE", "set-permissions": "PLATFORM_PRINCIPAL_SET_PERMISSIONS" };

const present = (v) => v !== undefined && v !== null && v !== "";
const fail = (reason) => ({ ok: false, reason });
const safeText = (v, max = 200) => (typeof v === "string" && v.length <= max && !v.includes("@") && !/eyJ[A-Za-z0-9_-]{10,}/.test(v) ? v : undefined);

function safeValue(v) {
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  if (typeof v === "string") return safeText(v);
  if (Array.isArray(v) && v.every((p) => typeof p === "string" && PLATFORM_PERMISSION.test(p))) return [...v];
  return undefined;
}

function pickMetadata(eventType, data) {
  const out = {};
  for (const k of META_FIELDS[eventType] || []) {
    if (data[k] === undefined || data[k] === null) continue;
    const v = safeValue(data[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function resolveContext(eventType, ctx) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return fail("context_required");
  if (Object.keys(ctx).some((k) => !CONTEXT_FIELDS.has(k))) return fail("unknown_context_field");
  const { actorScope, actorTenantId, targetTenantId, loginTenantId } = ctx;
  if (!(SCOPES_FOR[eventType] || []).includes(actorScope)) return fail("scope_not_allowed_for_event");
  for (const v of [actorTenantId, targetTenantId, loginTenantId]) {
    if (present(v) && !isInternalTenantId(v)) return fail("invalid_tenant_value");
  }
  if (actorScope === "tenant") {
    if (!present(actorTenantId)) return fail("tenant_actor_requires_actor_tenant");
    if (present(loginTenantId)) return fail("tenant_actor_login_context");
    if (present(targetTenantId) && targetTenantId !== actorTenantId) return fail("tenant_actor_cross_tenant");
    return { ok: true, actorScope, actorTenantId, targetTenantId: present(targetTenantId) ? targetTenantId : null, loginTenantId: null };
  }
  if (present(actorTenantId)) return fail("non_tenant_actor_has_actor_tenant");
  if (actorScope === "system") {
    if (present(loginTenantId)) return fail("system_actor_tenant_context");
    if (Object.prototype.hasOwnProperty.call(SYSTEM_TARGET_EVENTS, eventType)) {
      if (!present(targetTenantId)) return fail("system_actor_requires_target");
    } else if (present(targetTenantId)) {
      return fail("system_actor_tenant_context");
    }
  }
  return {
    ok: true,
    actorScope,
    actorTenantId: null,
    targetTenantId: present(targetTenantId) ? targetTenantId : null,
    loginTenantId: present(loginTenantId) ? loginTenantId : null,
  };
}

/**
 * Build the platform_audit_logs record for one event, or say why it is rejected.
 * @returns {{ ok: true, record: object } | { ok: false, reason: string }}
 */
export function buildPlatformAuditRecord(payload, eventType, { headerTenantId } = {}) {
  if (!PLATFORM_EVENT_TYPES.includes(eventType)) return fail("unknown_event_type");
  if (!payload || typeof payload !== "object") return fail("malformed");
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : null;
  if (!data) return fail("malformed");
  if (typeof payload.eventId !== "string" || !payload.eventId || payload.eventId.length > 128) return fail("event_id_required");

  // An envelope tenant is not an owner here. When present (Z4-shaped events) it must still be a real tenant
  // and agree with the AMQP header - a placeholder is rejected, never stored.
  const envelope = cleanTenant(payload.tenantId);
  const header = cleanTenant(headerTenantId);
  for (const v of [envelope, header]) if (v && !isInternalTenantId(v)) return fail("invalid_envelope_tenant");
  if (envelope && header && envelope !== header) return fail("envelope_header_mismatch");

  const ctx = resolveContext(eventType, payload.metadata?.auditContext);
  if (!ctx.ok) return ctx;

  const base = {
    eventId: payload.eventId,
    eventType,
    service: safeText(payload.metadata?.service, 64) || "user-service",
    actorScope: ctx.actorScope,
    actorTenantId: ctx.actorTenantId,
    targetTenantId: ctx.targetTenantId,
    correlationId: safeText(payload.correlationId, 128) ?? null,
    occurredAt: Number.isNaN(Date.parse(payload.timestamp)) ? new Date() : new Date(payload.timestamp),
  };
  const metadata = pickMetadata(eventType, data);
  if (ctx.loginTenantId) metadata.loginTenantId = ctx.loginTenantId;
  const pid = typeof data.principalId === "string" && OBJECT_ID.test(data.principalId) ? data.principalId : null;
  const permission = typeof data.permission === "string" && PLATFORM_PERMISSION.test(data.permission) ? data.permission : null;
  const reason = safeText(data.reason, 64) ?? null;
  const operation = safeText(data.route, 200) ?? null;

  if (eventType === E.CLAIM_DECISION) {
    if (!pid) return fail("principal_id_required");
    const decision = safeText(data.decision, 32);
    if (!decision) return fail("decision_required");
    const issued = decision === "issued";
    return { ok: true, record: { ...base, action: issued ? "PLATFORM_CLAIM_ISSUED" : "PLATFORM_CLAIM_REFUSED", actorId: pid, permission: null, allowed: issued, result: issued ? "allowed" : "denied", reason: issued ? null : decision, operation: "crm.sign-in", metadata } };
  }

  if (eventType === E.AUTHZ_DECISION) {
    if (!permission) return fail("permission_required");
    if (typeof data.allowed !== "boolean") return fail("allowed_required");
    let actorId;
    if (ctx.actorScope === "tenant") {
      // A tenant actor never holds platform authority: only a denial can be recorded for it.
      if (data.allowed !== false) return fail("tenant_actor_allowed");
      if (!(typeof data.actorUserId === "string" && OBJECT_ID.test(data.actorUserId))) return fail("actor_user_required");
      actorId = data.actorUserId;
    } else {
      if (!pid) return fail("principal_id_required");
      actorId = pid;
    }
    return { ok: true, record: { ...base, action: data.allowed ? "PLATFORM_AUTHZ_ALLOWED" : "PLATFORM_AUTHZ_DENIED", actorId, permission, allowed: data.allowed, result: data.allowed ? "allowed" : "denied", reason, operation, metadata } };
  }

  if (eventType === E.TENANT_CREATED) {
    if (!pid) return fail("principal_id_required");
    if (!ctx.targetTenantId) return fail("target_tenant_required");
    if (data.tenantId !== ctx.targetTenantId) return fail("target_tenant_mismatch");
    if (envelope && envelope !== ctx.targetTenantId) return fail("envelope_not_target");
    if (permission !== "platform:tenant:create") return fail("permission_required");
    return { ok: true, record: { ...base, action: "TENANT_CREATED", actorId: pid, permission, allowed: true, result: "success", reason: null, operation, metadata } };
  }

  if (eventType === E.TENANT_CREATE_FAILED) {
    if (!pid) return fail("principal_id_required");
    if (ctx.targetTenantId) return fail("failed_create_has_no_target");
    if (permission !== "platform:tenant:create") return fail("permission_required");
    return { ok: true, record: { ...base, action: "TENANT_CREATE_FAILED", actorId: pid, permission, allowed: true, result: "failure", reason, operation, metadata } };
  }

  if (eventType === E.TENANT_ADMIN_CHANGED) {
    if (!pid) return fail("principal_id_required");
    if (!ctx.targetTenantId) return fail("target_tenant_required");
    if (data.tenantId !== ctx.targetTenantId) return fail("target_tenant_mismatch");
    if (envelope) return fail("platform_record_has_no_owner");
    const action = typeof data.action === "string" && Object.prototype.hasOwnProperty.call(TENANT_ADMIN_ACTIONS, data.action) ? data.action : null;
    if (!action) return fail("unknown_tenant_admin_action");
    if (permission !== TENANT_ADMIN_ACTIONS[action]) return fail("permission_action_mismatch");
    if (data.result !== "success" && data.result !== "failure") return fail("result_required");
    if (present(data.connectionId) && !(typeof data.connectionId === "string" && OBJECT_ID.test(data.connectionId))) return fail("invalid_connection_id");
    return { ok: true, record: { ...base, action, actorId: pid, permission, allowed: true, result: data.result, reason, operation, metadata } };
  }

  if (eventType === E.PROVISIONING_RUN_CHANGED) {
    if (!pid) return fail("principal_id_required");
    if (envelope) return fail("platform_record_has_no_owner");
    if (permission !== PROVISIONING_PERMISSION) return fail("permission_required");
    const action = PROVISIONING_RUN_ACTIONS.includes(data.action) ? data.action : null;
    if (!action) return fail("unknown_provisioning_action");
    if (data.result !== "success" && data.result !== "failure") return fail("result_required");
    if (ctx.targetTenantId) {
      if (data.tenantId !== ctx.targetTenantId) return fail("target_tenant_mismatch");
    } else if (action !== "PROVISIONING_RUN_REFUSED" || present(data.tenantId)) {
      return fail("target_tenant_required");
    }
    if (present(data.runId) && !(typeof data.runId === "string" && UUID.test(data.runId))) return fail("invalid_run_id");
    return { ok: true, record: { ...base, action, actorId: pid, permission, allowed: true, result: data.result, reason, operation, metadata } };
  }

  if (eventType === E.PROVISIONING_STEP_CHANGED) {
    if (data.actorId !== SYSTEM_TARGET_EVENTS[eventType] || !SYSTEM_ACTORS.includes(data.actorId)) return fail("unknown_system_actor");
    if (envelope) return fail("platform_record_has_no_owner");
    if (data.tenantId !== ctx.targetTenantId) return fail("target_tenant_mismatch");
    if (!PROVISIONING_STEP_ACTIONS.includes(data.action)) return fail("unknown_provisioning_step_action");
    if (data.result !== "success" && data.result !== "failure") return fail("result_required");
    if (!(typeof data.runId === "string" && UUID.test(data.runId))) return fail("invalid_run_id");
    if (!(typeof data.stepKey === "string" && STEP_KEY_V2.test(data.stepKey) && data.stepKey.startsWith(`psk2:${data.runId}:`))) return fail("invalid_step_key");
    return { ok: true, record: { ...base, action: data.action, actorId: data.actorId, permission: null, allowed: null, result: data.result, reason, operation: "provisioning-orchestrator", metadata } };
  }

  if (eventType === E.PROVISIONING_TEMPLATE_PUBLISHED) {
    if (data.actorId !== PROVISIONING_ACTOR || !SYSTEM_ACTORS.includes(data.actorId)) return fail("unknown_system_actor");
    if (!TEMPLATE_ACTIONS.includes(data.action)) return fail("unknown_template_action");
    if (data.result !== "success" && data.result !== "failure") return fail("result_required");
    if (!safeText(data.templateKey, 64) || !Number.isInteger(data.templateVersion)) return fail("template_required");
    if (present(data.contentHash) && !(typeof data.contentHash === "string" && SHA256.test(data.contentHash))) return fail("invalid_content_hash");
    if (!safeText(data.operatorLabel, 120) || !safeText(data.approvalRef, 120)) return fail("operator_metadata_required");
    return { ok: true, record: { ...base, action: data.action, actorId: PROVISIONING_ACTOR, permission: null, allowed: null, result: data.result, reason, operation: `platform-template ${data.action === "PLATFORM_TEMPLATE_RETIRED" ? "retire" : "publish"}`, metadata } };
  }

  // E.PRINCIPAL_CHANGED - the principal-admin script (reserved system actor).
  if (data.actorId !== PRINCIPAL_ADMIN_ACTOR || !SYSTEM_ACTORS.includes(data.actorId)) return fail("unknown_system_actor");
  const action = PRINCIPAL_ACTIONS[data.action];
  if (!action) return fail("unknown_principal_action");
  if (data.result !== "success" && data.result !== "failure") return fail("result_required");
  if (data.result === "success" && !pid) return fail("principal_id_required");
  if (!safeText(data.operatorLabel, 120) || !safeText(data.approvalRef, 120)) return fail("operator_metadata_required");
  return { ok: true, record: { ...base, action, actorId: PRINCIPAL_ADMIN_ACTOR, permission: null, allowed: null, result: data.result, reason, operation: `principal-admin ${data.action}`, metadata } };
}

/**
 * Consumer wrapper for audit.platform.events. Returns true when a row was written (or already existed).
 * Rejected events are logged and skipped - never thrown (see header).
 */
export async function runPlatformAuditHandler({ payload, messageContext, eventType, log }) {
  const built = buildPlatformAuditRecord(payload, eventType, { headerTenantId: messageContext?.headers?.["x-tenant-id"] });
  if (!built.ok) {
    log.warn({ eventType, eventId: payload?.eventId, correlationId: payload?.correlationId, reason: built.reason }, "PlatformAuditEventRejected");
    return false;
  }
  const { inserted } = await insertPlatformAuditLog(built.record);
  log.debug({ eventType, inserted }, inserted ? "Platform audit event stored" : "Platform audit event already stored (idempotent)");
  return true;
}
