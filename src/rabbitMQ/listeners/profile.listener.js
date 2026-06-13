import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "profile.created": "PROFILE_CREATED",
  "profile.updated": "PROFILE_UPDATED",
  "profile.deleted": "PROFILE_DELETED",
  "profile.duplicate.detection.run": "PROFILE_DUPLICATE_DETECTION_RUN",
  "profile.duplicate.merged": "PROFILE_DUPLICATE_MERGED",
};

export async function handleProfileEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const isProfileDuplicateEvent =
    eventType === "profile.duplicate.detection.run" ||
    eventType === "profile.duplicate.merged";

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "profile-service",
    action: ACTION_MAP[eventType] || "PROFILE_UPDATED",
    resourceType: "profile",
    resourceId: data.profileId || data.masterProfileId,
    actorId: data.actorId || data.reviewedBy || data.runBy || payload.userId,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: isProfileDuplicateEvent ? data.before ?? null : data.before ?? null,
    after: isProfileDuplicateEvent ? data.after ?? data : data.after ?? null,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {}),
      source: data.source,
      changedPaths: data.changedPaths,
      ...(isProfileDuplicateEvent
        ? {
            duplicateAction: data.action || null,
            absorbedProfileId: data.absorbedProfileId || null,
            mergeFieldSelections: data.mergeFieldSelections || [],
            mergeFieldChoices: data.mergeFieldChoices || null,
            matchCount: data.matchCount ?? null,
            hasPotentialDuplicate: data.hasPotentialDuplicate ?? null,
          }
        : {}),
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug(
    { eventType, profileId: data.profileId },
    "Profile event audited",
  );
}
