import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

/**
 * Handle issues.issue.audit.v1 events published by issue-service.
 *
 * Thin reshape into createAuditLog()'s argument shape - no business logic, no
 * cross-service calls, no validation beyond picking sensible fallback fields.
 * Mirrors finance.listener.js's handleFinanceEvent shape exactly.
 */
export async function handleIssueAuditEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "issue-service",
    action: data.action,
    resourceType: "issue",
    resourceId: data.resourceId,
    actorId: data.actorId,
    actorEmail: data.actorEmail,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: data.before || null,
    after: data.after || null,
    metadata: {
      ...(payload.metadata || {}),
      ...(data.metadata || {}),
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, action: data.action, resourceId: data.resourceId }, "Issue event audited");
}
