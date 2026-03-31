import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

export async function handleJournalEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "account-service",
    action:        "JOURNAL_CREATED",
    resourceType:  "journal",
    resourceId:    data.docNo || data.journalId,
    actorId:       data.createdBy,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, docNo: data.docNo }, "Journal event audited");
}
