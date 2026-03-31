import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "user.crm.created.v1":    "USER_CREATED",
  "user.crm.updated.v1":    "USER_UPDATED",
  "user.portal.created.v1": "USER_CREATED",
  "user.portal.updated.v1": "USER_UPDATED",
};

export async function handleUserEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "user-service",
    action:        ACTION_MAP[eventType] || "USER_UPDATED",
    resourceType:  "user",
    resourceId:    data.userId || data.id,
    actorId:       data.updatedBy || data.createdBy || data.userId,
    actorEmail:    data.email,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, resourceId: data.userId }, "User event audited");
}
