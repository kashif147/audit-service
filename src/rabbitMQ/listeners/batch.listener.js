import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const BATCH_ACTIONS = {
  "batch.process.completed.v1": "BATCH_PROCESS_COMPLETED",
  "batch.process.queued.v1": "BATCH_PROCESS_QUEUED",
  batch_completed: "BATCH_COMPLETED",
};

export async function handleBatchEvent(payload, eventType, exchange) {
  const data = payload.data || payload;
  const action = BATCH_ACTIONS[eventType] || "BATCH_COMPLETED";

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "account-service",
    action,
    resourceType: "finance",
    resourceId: data.batchDetailId || data.batchId || data.id,
    actorId: data.createdBy || data.userId || data.initiatedBy || data.queuedBy,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    after: {
      batchDetailId: data.batchDetailId,
      batchName: data.batchName || data.description,
      referenceNumber: data.referenceNumber,
      status: data.status || data.payload?.status,
      processedTransactions:
        data.processedTransactions ?? data.payload?.processedTransactions,
      failedTransactions:
        data.failedTransactions ?? data.payload?.failedTransactions,
      totalTransactions:
        data.totalTransactions ?? data.payload?.totalTransactions,
      ...data,
    },
    metadata: {
      ...(payload.metadata || {}),
      dedupeKey: data.batchDetailId
        ? `batch:${action}:${String(data.batchDetailId)}`
        : undefined,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, batchId: data.batchDetailId }, "Batch event audited");
}
