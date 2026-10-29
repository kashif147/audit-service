// Phase B / Z4: actor / target-tenant audit context.
//
// Three additive, nullable columns on audit_logs describe WHO acted and ON WHICH tenant:
//   actor_scope       "tenant" | "platform" | "system"
//   actor_tenant_id   the interactive tenant-scoped actor's tenant (tenant scope only; NULL for platform/system)
//   target_tenant_id  the tenant whose data/configuration was operated on (NULL only when the operation has
//                     no tenant target)
//
// tenant_id is NOT repurposed. It stays exactly what Phase A / A1 made it: the trusted tenant that OWNS
// the row (the read APIs' visibility partition), resolved from trusted context only, never "unknown".
// During the transition:
//   - tenant actors (every existing producer, legacy SU included): tenant_id = actor_tenant_id = target_tenant_id.
//   - platform actors (Z4: user-service platform-auth events): tenant_id = the trusted request tenant the
//     event happened in (the caller's sign-in tenant); actor_tenant_id = NULL (a platform actor's authority
//     never comes from a tenant); target_tenant_id = NULL unless a route genuinely targets a tenant, and in
//     Z4 a target must equal tenant_id (no cross-tenant expression before Z5/Z6). The sign-in tenant may be
//     kept as context in metadata.actorContext.loginTenantId - never as an authority.
//   - system actors (reserved: platform:migration, platform:provisioning): actor_tenant_id = NULL,
//     target_tenant_id = tenant_id = the tenant operated on. No tenantless system row in Z4.
// A producer that sends no context gets the tenant mapping derived from the trusted tenant (compatibility).
// Anything else fails closed: the event is skipped / the insert refused - never stored with a guessed tenant.

export const ACTOR_SCOPES = Object.freeze(["tenant", "platform", "system"]);
// Reserved system actors. platform:principal-admin (Z5) = the operator principal-admin script; its rows live
// only in platform_audit_logs (no target tenant), so in audit_logs it is never seen in practice.
export const SYSTEM_ACTORS = Object.freeze(["platform:migration", "platform:provisioning", "platform:principal-admin"]);
const CONTEXT_FIELDS = new Set(["actorScope", "actorTenantId", "targetTenantId", "loginTenantId"]);
const INTERNAL_TENANT_ID = /^[0-9a-f]{24}$/;

/** A ProjectShell tenant id as stored by user-service (Mongo ObjectId hex). Placeholders never match. */
export const isInternalTenantId = (v) => typeof v === "string" && INTERNAL_TENANT_ID.test(v);

const present = (v) => v !== undefined && v !== null && v !== "";
const fail = (reason) => ({ ok: false, reason });

/**
 * @param {{ tenantId: string, auditContext?: object|null, actorId?: string|null }} input
 *   tenantId: the row's trusted owner tenant (already validated by the A1 rules).
 *   auditContext: optional { actorScope, actorTenantId, targetTenantId, loginTenantId } from a trusted producer.
 * @returns {{ ok: true, actorScope: string, actorTenantId: string|null, targetTenantId: string|null,
 *             loginTenantId: string|null } | { ok: false, reason: string }}
 */
export function resolveAuditContext({ tenantId, auditContext, actorId = null }) {
  const owner = tenantId == null ? "" : String(tenantId).trim();
  if (auditContext == null) {
    return { ok: true, actorScope: "tenant", actorTenantId: owner, targetTenantId: owner, loginTenantId: null };
  }
  if (typeof auditContext !== "object" || Array.isArray(auditContext)) return fail("malformed_context");
  if (Object.keys(auditContext).some((k) => !CONTEXT_FIELDS.has(k))) return fail("unknown_context_field");
  const { actorScope, actorTenantId, targetTenantId, loginTenantId } = auditContext;
  if (!ACTOR_SCOPES.includes(actorScope)) return fail("invalid_actor_scope");
  for (const v of [actorTenantId, targetTenantId, loginTenantId]) {
    if (present(v) && !isInternalTenantId(v)) return fail("invalid_tenant_value");
  }

  if (actorScope === "tenant") {
    if (present(loginTenantId)) return fail("tenant_actor_login_context");
    const actor = present(actorTenantId) ? actorTenantId : owner;
    const target = present(targetTenantId) ? targetTenantId : owner;
    if (actor !== owner) return fail("actor_tenant_not_owner");
    if (target !== owner) return fail("tenant_actor_cross_tenant"); // legacy SU included: never another tenant
    return { ok: true, actorScope, actorTenantId: actor, targetTenantId: target, loginTenantId: null };
  }

  // platform / system: authority never comes from a tenant.
  if (present(actorTenantId)) return fail("non_tenant_actor_has_actor_tenant");
  if (present(targetTenantId) && targetTenantId !== owner) return fail("target_not_owner"); // Z4: no cross-tenant
  if (actorScope === "platform") {
    return {
      ok: true,
      actorScope,
      actorTenantId: null,
      targetTenantId: present(targetTenantId) ? targetTenantId : null,
      loginTenantId: present(loginTenantId) ? loginTenantId : null,
    };
  }
  if (!SYSTEM_ACTORS.includes(actorId)) return fail("unknown_system_actor");
  if (present(loginTenantId)) return fail("system_actor_login_context");
  if (!present(targetTenantId)) return fail("system_actor_requires_target");
  return { ok: true, actorScope, actorTenantId: null, targetTenantId, loginTenantId: null };
}
