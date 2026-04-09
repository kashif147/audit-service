import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "profile.created": "PROFILE_CREATED",
  "profile.updated": "PROFILE_UPDATED",
  "profile.deleted": "PROFILE_DELETED",
};

export async function handleProfileEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "profile-service",
    action: ACTION_MAP[eventType] || "PROFILE_UPDATED",
    resourceType: "profile",
    resourceId: data.profileId,
    actorId: data.actorId || payload.userId,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: data.before ?? null,
    after: data.after ?? null,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object"
        ? payload.metadata
        : {}),
      source: data.source,
      changedPaths: data.changedPaths,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug(
    { eventType, profileId: data.profileId },
    "Profile event audited",
  );
}
