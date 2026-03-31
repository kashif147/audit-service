import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

export async function handleBatchEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "profile-service",
    action:        "BATCH_COMPLETED",
    resourceType:  "batch",
    resourceId:    data.batchId || data.id,
    actorId:       data.initiatedBy || data.userId,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, batchId: data.batchId }, "Batch event audited");
}
