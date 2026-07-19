import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "events.registration.created.v1": "EVENT_REGISTRATION_CREATED",
  "events.registration.confirmed.v1": "EVENT_REGISTRATION_CONFIRMED",
  "events.registration.cancelled.v1": "EVENT_REGISTRATION_CANCELLED",
  "events.certificate.issued.v1": "EVENT_CERTIFICATE_ISSUED",
};

export async function handleEventsEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "events-service",
    action: ACTION_MAP[eventType] || "EVENT_REGISTRATION_UPDATED",
    resourceType: eventType.startsWith("events.certificate") ? "certificate" : "registration",
    resourceId: data.certificateId || data.registrationId,
    actorId: data.registeredByUserId || payload.userId,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: null,
    after: data,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      profileId: data.profileId,
      eventId: data.eventId,
      courseId: data.courseId,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, registrationId: data.registrationId }, "Events/courses event audited");
}
