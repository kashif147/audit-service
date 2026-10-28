// Event tenant authority for audit consumers (Phase A / A1).
//
// Every audit row is tenant-owned, so an event must carry a real tenant before anything is written.
// The envelope tenant (payload.tenantId, set by the publisher from its trusted context) is canonical;
// data.tenantId is only a fallback when the envelope has none; the AMQP `x-tenant-id` header (set by
// rabbitmq-middleware from the same publisher option) must agree when present. Any disagreement, a
// missing tenant or a placeholder value is REJECTED: the caller logs and skips the event.
//
// This returns a result instead of throwing on purpose: a throw makes rabbitmq-middleware republish the
// message to its original exchange/routing key (3x), which re-delivers it to every other bound queue.
// There is no "unknown"/"default" tenant.

import { cleanTenant as clean, isValidTenantId } from "../helpers/tenantValue.js";
import { resolveAuditContext } from "../helpers/auditContext.js";

export { isValidTenantId };

/**
 * @param {object} payload  rabbitmq-middleware envelope ({ tenantId, data, eventId, ... })
 * @param {{ headerTenantId?: string }} [opts]
 * @returns {{ ok: true, tenantId: string } | { ok: false, reason: "missing"|"mismatch"|"malformed" }}
 */
export function resolveAuditEventTenant(payload, { headerTenantId } = {}) {
  const envelope = clean(payload?.tenantId);
  const data =
    payload?.data && typeof payload.data === "object" ? clean(payload.data.tenantId) : "";
  const header = clean(headerTenantId);

  const present = [envelope, data, header].filter(Boolean);
  if (!present.length) return { ok: false, reason: "missing" };
  if (present.some((v) => !isValidTenantId(v))) return { ok: false, reason: "malformed" };
  if (new Set(present).size > 1) return { ok: false, reason: "mismatch" };
  return { ok: true, tenantId: envelope || data || header };
}

/**
 * Tenant gate around one audit handler invocation. Returns true when the handler ran.
 * Rejected events are logged (`AuditEventTenantRejected`) and skipped - never thrown (see header).
 */
export async function runTenantGatedHandler({ payload, messageContext, handler, eventType, exchange, log }) {
  const tenant = resolveAuditEventTenant(payload, {
    headerTenantId: messageContext?.headers?.["x-tenant-id"],
  });
  if (!tenant.ok) {
    log.warn(
      {
        eventType,
        eventId: payload?.eventId,
        correlationId: payload?.correlationId,
        reason: tenant.reason,
      },
      "AuditEventTenantRejected",
    );
    return false;
  }
  // Phase B / Z4: an actor / target context, when the producer sends one (metadata.auditContext), must be
  // valid for the resolved owner tenant - otherwise the event is skipped the same way (never stored with a
  // guessed scope or tenant). No context = the compatible tenant mapping (createAuditLog).
  const auditContext = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata.auditContext : undefined;
  if (auditContext !== undefined) {
    const ctx = resolveAuditContext({
      tenantId: tenant.tenantId,
      auditContext,
      actorId: payload?.data?.actorId ?? null,
    });
    if (!ctx.ok) {
      log.warn(
        { eventType, eventId: payload?.eventId, correlationId: payload?.correlationId, reason: ctx.reason },
        "AuditEventContextRejected",
      );
      return false;
    }
  }
  await handler({ ...payload, tenantId: tenant.tenantId }, eventType, exchange);
  return true;
}
