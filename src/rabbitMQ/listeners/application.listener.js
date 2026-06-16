import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "applications.review.processed.v1": "APPLICATION_PROCESSED",
  "applications.review.rejected.v1": "APPLICATION_REJECTED",
  "applications.executive-council.approved.v1": "EXECUTIVE_COUNCIL_APPROVED",
  "applications.executive-council.rejected.v1": "EXECUTIVE_COUNCIL_REJECTED",
  "application.status.submitted.v1": "APPLICATION_SUBMITTED",
  "application.status.submitted": "APPLICATION_SUBMITTED",
  "applications.duplicate.review.decided.v1": "DUPLICATE_REVIEW_DECIDED",
  "applications.duplicate.detection.run.v1": "DUPLICATE_DETECTION_RUN",
};

const DUPLICATE_REVIEW_ACTION_LABELS = {
  LINK: "DUPLICATE_PROFILE_LINKED",
  MERGE: "DUPLICATE_PROFILE_MERGED",
  IGNORE_MATCH: "DUPLICATE_MATCH_IGNORED",
  MARKED_NEW: "DUPLICATE_MARKED_NEW",
};

export async function handleApplicationEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const isDuplicateReviewEvent =
    eventType === "applications.duplicate.review.decided.v1" ||
    eventType === "applications.duplicate.detection.run.v1";

  const action =
    eventType === "applications.duplicate.review.decided.v1"
      ? DUPLICATE_REVIEW_ACTION_LABELS[data.action] ||
        ACTION_MAP[eventType]
      : ACTION_MAP[eventType] || "UNKNOWN";

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "unknown-service",
    action,
    resourceType:  "application",
    resourceId:    data.applicationId,
    actorId:
      data.reviewedBy ||
      data.runBy ||
      data.approvedBy ||
      data.submittedBy ||
      data.userId ||
      payload.userId,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    before:        isDuplicateReviewEvent ? data.before ?? null : null,
    after:         isDuplicateReviewEvent ? data.after ?? data : data,
    metadata:      {
      ...(payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {}),
      ...(isDuplicateReviewEvent
        ? {
            duplicateAction: data.action || null,
            matchedProfileId: data.matchedProfileId || null,
            mergeFieldSelections: data.mergeFieldSelections || [],
            mergeFieldChoices: data.mergeFieldChoices || null,
            matchScore: data.matchScore ?? null,
            matchedFields: data.matchedFields || [],
            decisionReason: data.decisionReason || null,
          }
        : {}),
    },
    occurredAt:    new Date(
      data.reviewedAt || payload.timestamp || Date.now(),
    ),
  });

  logger.debug({ eventType, applicationId: data.applicationId }, "Application event audited");
}
