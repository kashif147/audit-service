import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "members.subscription.current.updated.v1": "SUBSCRIPTION_UPDATED",
  "members.subscription.changed.v1": "SUBSCRIPTION_FIELDS_UPDATED",
  "members.subscription.category.changed.v1": "MEMBERSHIP_CATEGORY_CHANGED",
  "members.subscription.resigned.v1": "SUBSCRIPTION_RESIGNED",
  "members.subscription.resignation.undone.v1": "RESIGNATION_UNDONE",
  "members.subscription.cancelled.v1": "SUBSCRIPTION_CANCEL_REQUESTED",
  "members.subscription.cancellation.undone.v1": "CANCELLATION_UNDONE",
  "members.subscription.cancel.grace.ended.v1": "SUBSCRIPTION_CANCEL_GRACE_ENDED",
};

function resolveMembershipAction(eventType, data, metadata = {}) {
  if (eventType === "members.subscription.cancelled.v1") {
    if (metadata.job === "undergraduateGraduationCancellation") {
      return "UNDERGRADUATE_GRADUATION_CANCELLED";
    }
    if (metadata.source === "reminderBatch") {
      return "REMINDER_BATCH_CANCELLATION";
    }
    return ACTION_MAP[eventType];
  }

  if (eventType === "members.subscription.changed.v1") {
    const fields = Array.isArray(data.changedFields) ? data.changedFields : [];
    if (fields.some((f) => String(f).includes("reminder"))) {
      return "REMINDER_DATES_CHANGED";
    }
    if (fields.some((f) => String(f).includes("cancellation"))) {
      return "CANCELLATION_DATES_CHANGED";
    }
    if (metadata.job === "undergraduateGraduationCancellation") {
      return "UNDERGRADUATE_GRADUATION_CANCELLED";
    }
    return ACTION_MAP[eventType];
  }

  return ACTION_MAP[eventType] || "SUBSCRIPTION_MEMBERSHIP_EVENT";
}

export async function handleMembershipEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const metadata =
    payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata
      : {};

  const hasExplicitAfter = data.after != null;
  const afterState = hasExplicitAfter ? data.after : data;
  const beforeState = data.before != null ? data.before : null;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: metadata.service || "subscription-service",
    action: resolveMembershipAction(eventType, data, metadata),
    resourceType: "subscription",
    resourceId:
      data.subscriptionId != null
        ? String(data.subscriptionId)
        : data.memberId != null
          ? String(data.memberId)
          : null,
    actorId:
      data.actorUserId ||
      data.crmUserId ||
      data.userId ||
      data.resignedBy ||
      data.cancelledBy ||
      null,
    actorEmail: data.actorEmail || data.userEmail || null,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: beforeState,
    after: afterState,
    metadata: {
      ...metadata,
      changedFields: data.changedFields || null,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug(
    { eventType, subscriptionId: data.subscriptionId, memberId: data.memberId },
    "Membership event audited"
  );
}
