import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

export async function handleJournalEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  const action =
    data.action ||
    payload.metadata?.action ||
    "JOURNAL_POSTED";

  const profileId =
    data.profileId || data.financeSnapshot?.profileId || null;
  const memberId = data.memberId || data.financeSnapshot?.memberId || null;

  const resourceId =
    profileId != null && String(profileId).trim()
      ? String(profileId).trim()
      : memberId != null && String(memberId).trim()
        ? String(memberId).trim()
        : data.docNo || data.journalId;

  await createAuditLog({
    tenantId: data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service: payload.metadata?.service || "account-service",
    action,
    resourceType: "finance",
    resourceId,
    actorId: data.createdBy,
    correlationId: payload.correlationId,
    eventId: payload.eventId,
    after: data.financeSnapshot || {
      docNo: data.docNo,
      docType: data.docType,
      date: data.date,
      reference: data.reference,
      memo: data.memo,
      memberId: data.memberId,
      profileId: data.profileId,
      paymentMethod: data.paymentMethod,
      operation: data.operation,
      totalDebit: data.totalDebit,
      totalCredit: data.totalCredit,
    },
    metadata: {
      ...(payload.metadata || {}),
      memberId: memberId || undefined,
      profileId: profileId || undefined,
      journalId: data.journalId,
      dedupeKey: data.docNo ? `journal:${data.docNo}` : undefined,
    },
    occurredAt: new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType, docNo: data.docNo, action }, "Journal event audited");
}
