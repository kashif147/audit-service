import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "events.registration.created.v1": "EVENT_REGISTRATION_CREATED",
  "events.registration.confirmed.v1": "EVENT_REGISTRATION_CONFIRMED",
  "events.registration.cancelled.v1": "EVENT_REGISTRATION_CANCELLED",
  "events.certificate.issued.v1": "EVENT_CERTIFICATE_ISSUED",
  // P5 attendance audit - published from events-service's transactional outbox with a broker
  // confirm and a deterministic eventId; createAuditLog is idempotent on (tenant_id, event_id), so a
  // re-publish (lost confirm) or redelivery stores one row.
  "events.attendance.corrected.v1": "EVENT_ATTENDANCE_CORRECTED",
  "events.session.schedule_changed.v1": "EVENT_SCHEDULE_CHANGED",
  "events.certificate.review_flagged.v1": "EVENT_CERTIFICATE_REVIEW_FLAGGED",
};

/** Keys whose delivery must be durable (rethrown on write failure - see rabbitMQ/index.js). */
export const DURABLE_EVENTS_KEYS = Object.freeze([
  "events.attendance.corrected.v1",
  "events.session.schedule_changed.v1",
  "events.certificate.review_flagged.v1",
]);

function resourceFor(eventType, data) {
  if (eventType === "events.attendance.corrected.v1") return { resourceType: "registration", resourceId: data.registrationId };
  if (eventType === "events.session.schedule_changed.v1") {
    return data.sessionId ? { resourceType: "event_session", resourceId: data.sessionId } : { resourceType: "event", resourceId: data.eventId };
  }
  if (eventType.startsWith("events.certificate")) return { resourceType: "certificate", resourceId: data.certificateId || data.registrationId };
  return { resourceType: "registration", resourceId: data.registrationId };
}

export async function handleEventsEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const durable = DURABLE_EVENTS_KEYS.includes(eventType);
  if (durable && !payload.eventId) {
    // The outbox always sets one; without it the row could not be deduplicated. Permanent skip.
    logger.warn({ eventType }, "Durable events audit message without eventId skipped");
    return;
  }
  const { resourceType, resourceId } = resourceFor(eventType, data);

  await createAuditLog({
    tenantId: payload.tenantId,
    eventType,
    exchange,
    service: payload.metadata?.service || "events-service",
    action: ACTION_MAP[eventType] || "EVENT_REGISTRATION_UPDATED",
    resourceType,
    resourceId,
    actorId: durable ? data.actorUserId || null : data.registeredByUserId || payload.userId,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    before: durable && data.from !== undefined ? data.from : null,
    after: data,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      profileId: data.profileId,
      eventId: data.eventId,
      courseId: data.courseId,
    },
    occurredAt: new Date(data.occurredAt || payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, resourceType, resourceId }, "Events/courses event audited");
}
