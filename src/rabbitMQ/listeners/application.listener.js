import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "applications.review.approved.v1": "APPLICATION_APPROVED",
  "applications.review.rejected.v1": "APPLICATION_REJECTED",
  "application.status.submitted.v1": "APPLICATION_SUBMITTED",
  "application.status.submitted": "APPLICATION_SUBMITTED",
};

export async function handleApplicationEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "unknown-service",
    action:        ACTION_MAP[eventType] || "UNKNOWN",
    resourceType:  "application",
    resourceId:    data.applicationId,
    actorId:       data.reviewedBy || data.approvedBy || data.submittedBy || data.userId,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, applicationId: data.applicationId }, "Application event audited");
}
