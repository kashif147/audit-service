import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "members.subscription.current.updated.v1":    "SUBSCRIPTION_UPDATED",
  "members.subscription.resigned.v1":           "SUBSCRIPTION_RESIGNED",
  "members.subscription.resignation.undone.v1": "RESIGNATION_UNDONE",
  "members.subscription.cancel.grace.ended.v1": "SUBSCRIPTION_CANCELLED",
};

export async function handleMembershipEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "subscription-service",
    action:        ACTION_MAP[eventType] || "SUBSCRIPTION_UPDATED",
    resourceType:  "subscription",
    resourceId:    data.memberId || data.subscriptionId,
    actorId:       data.userId || data.resignedBy || data.cancelledBy,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, memberId: data.memberId }, "Membership event audited");
}
