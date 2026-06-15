import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

/**
 * Handle finance.audit.v1 and enriched journal.created.v1 events.
 */
export async function handleFinanceEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const action = data.action || payload.metadata?.action || "FINANCE_EVENT";

  const profileId =
    data.profileId ||
    data.after?.profileId ||
    data.financeSnapshot?.profileId ||
    null;
  const memberId =
    data.memberId ||
    data.after?.memberId ||
    data.financeSnapshot?.memberId ||
    null;

  const resourceId =
    profileId != null && String(profileId).trim()
      ? String(profileId).trim()
      : memberId != null && String(memberId).trim()
        ? String(memberId).trim()
        : data.resourceId || data.batchDetailId || data.docNo || null;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "account-service",
    action,
    resourceType: "finance",
    resourceId,
    actorId: data.actorId || data.createdBy,
    actorEmail: data.actorEmail,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: data.before || null,
    after: data.after || data.financeSnapshot || data,
    metadata: {
      ...(payload.metadata || {}),
      ...(data.metadata || {}),
      memberId: memberId || undefined,
      profileId: profileId || undefined,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, action, resourceId }, "Finance event audited");
}
