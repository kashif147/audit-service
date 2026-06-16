/**
 * Flatten nested objects to dot-path keys for audit diff display.
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {Record<string, unknown>} [out]
 */
export function flattenForDiff(value, prefix = "", out = {}) {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = value;
    return out;
  }
  if (value instanceof Date) {
    if (prefix) out[prefix] = value.toISOString();
    return out;
  }
  if (Array.isArray(value)) {
    if (prefix) out[prefix] = value;
    return out;
  }
  if (typeof value !== "object") {
    if (prefix) out[prefix] = value;
    return out;
  }

  const keys = Object.keys(value);
  if (!keys.length) {
    if (prefix) out[prefix] = value;
    return out;
  }

  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    flattenForDiff(value[key], path, out);
  }
  return out;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 */
export function formatAuditValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      return s.length > 200 ? `${s.slice(0, 197)}…` : s;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Diff two audit snapshots; returns only changed leaf paths.
 * @param {object|null|undefined} before
 * @param {object|null|undefined} after
 * @param {{ changedPaths?: string[]|null, changedFields?: string[]|null }} [opts]
 */
export function diffAuditStates(before, after, opts = {}) {
  const restrict =
    Array.isArray(opts.changedPaths) && opts.changedPaths.length
      ? new Set(opts.changedPaths)
      : Array.isArray(opts.changedFields) && opts.changedFields.length
        ? new Set(opts.changedFields)
        : null;

  const beforeFlat = flattenForDiff(before || {});
  const afterFlat = flattenForDiff(after || {});
  const paths = new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]);
  const changes = [];

  for (const path of paths) {
    if (restrict && !restrict.has(path)) {
      const matched = [...restrict].some(
        (p) => path === p || path.startsWith(`${p}.`),
      );
      if (!matched) continue;
    }

    const oldValue = beforeFlat[path];
    const newValue = afterFlat[path];
    if (!valuesEqual(oldValue, newValue)) {
      const formattedOld = formatAuditValue(oldValue);
      const formattedNew = formatAuditValue(newValue);
      // Skip rows that display the same (e.g. null vs "" both render as "—").
      if (formattedOld === formattedNew) continue;
      changes.push({
        field: path,
        oldValue: formattedOld,
        newValue: formattedNew,
      });
    }
  }

  return dedupeFieldChanges(changes);
}

/** Collapse alias paths that represent the same CRM attribute (e.g. nested membershipCategory). */
function canonicalAuditField(field) {
  if (field == null || field === "") return "";
  const path = String(field);
  if (path === "previousMembershipCategory") return "membershipCategory";
  if (path === "membershipCategory" || path.endsWith(".membershipCategory")) {
    return "membershipCategory";
  }
  return path;
}

function changeQualityScore(change) {
  let score = 0;
  if (change.oldValue && change.oldValue !== "—") score += 100;
  const field = String(change.field || "");
  if (!field.includes("effective.")) score += 20;
  score += Math.max(0, 10 - field.split(".").length);
  return score;
}

function dedupeFieldChanges(changes) {
  const bestByCanonical = new Map();

  for (const change of changes) {
    const canon = canonicalAuditField(change.field);
    const normalized = {
      ...change,
      field: canon || change.field,
    };
    const prev = bestByCanonical.get(normalized.field);
    if (!prev || changeQualityScore(normalized) > changeQualityScore(prev)) {
      bestByCanonical.set(normalized.field, normalized);
    }
  }

  return [...bestByCanonical.values()];
}

function expandedItemQualityScore(item) {
  let score = 0;
  if (item.oldValue && item.oldValue !== "—") score += 100;
  if (item.action === "SUBSCRIPTION_FIELDS_UPDATED") score += 30;
  if (item.action === "MEMBERSHIP_CATEGORY_CHANGED") score += 10;
  if (item.action === "SUBSCRIPTION_UPDATED") score += 5;
  const field = String(item.field || "");
  if (!field.includes("effective.")) score += 20;
  return score;
}

function dedupeExpandedItems(items) {
  const DEDUPE_MS = 60_000;
  const eventOnly = [];
  const bestByKey = new Map();
  const bestEventOnly = new Map();

  for (const item of items) {
    const canon = canonicalAuditField(item.field);
    if (!canon) {
      const t = new Date(item.occurredAt).getTime();
      const bucket = Number.isFinite(t) ? Math.floor(t / DEDUPE_MS) : 0;
      const docNo = extractFinanceDocNo(item);
      const eventKey = `${item.auditLogId}|${item.action}|${item.resourceType}|${item.resourceId}|${docNo}|${bucket}`;
      const prev = bestEventOnly.get(eventKey);
      if (
        !prev ||
        expandedItemQualityScore(item) > expandedItemQualityScore(prev)
      ) {
        bestEventOnly.set(eventKey, item);
      }
      continue;
    }

    const t = new Date(item.occurredAt).getTime();
    const bucket = Number.isFinite(t) ? Math.floor(t / DEDUPE_MS) : 0;
    const key = `${item.resourceType}|${item.resourceId}|${canon}|${item.newValue}|${bucket}`;
    const prev = bestByKey.get(key);
    if (!prev || expandedItemQualityScore(item) > expandedItemQualityScore(prev)) {
      bestByKey.set(key, { ...item, field: canon });
    }
  }

  return [...bestEventOnly.values(), ...bestByKey.values()];
}

function extractFinanceDocNo(item) {
  const raw = item?.newValue;
  if (typeof raw === "string" && raw.includes("Doc ")) {
    const match = raw.match(/Doc\s+([^\s·]+)/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function isEmptyAuditSnapshot(value) {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  return Object.keys(value).length === 0;
}

function formatFinanceEventSummary(after, action) {
  if (!after || typeof after !== "object") {
    return ACTION_LABELS[action] || action?.replace(/_/g, " ").toLowerCase() || "—";
  }
  const parts = [];
  if (after.docNo) parts.push(`Doc ${after.docNo}`);
  if (after.docType) parts.push(String(after.docType));
  if (after.paymentMethod) {
    parts.push(String(after.paymentMethod).replace(/_/g, " "));
  }
  if (after.amountCents != null) parts.push(`${after.amountCents} cents`);
  else if (after.totalDebit != null) parts.push(`Debit ${after.totalDebit}`);
  if (after.status) parts.push(String(after.status));
  if (after.memo && parts.length < 3) {
    const memo = String(after.memo);
    parts.push(memo.length > 80 ? `${memo.slice(0, 77)}…` : memo);
  }
  return parts.length
    ? parts.join(" · ")
    : ACTION_LABELS[action] || action?.replace(/_/g, " ").toLowerCase() || "—";
}

function shouldRenderFinanceAsSingleRow(row, before, after, changedFields) {
  if (row.resource_type !== "finance") return false;
  if (changedFields?.length) return false;
  if (!isEmptyAuditSnapshot(before)) return false;
  return Boolean(after && typeof after === "object");
}

const ACTION_LABELS = {
  PROFILE_CREATED: "Profile created",
  PROFILE_UPDATED: "Profile updated",
  PROFILE_DELETED: "Profile deleted",
  PROFILE_DUPLICATE_DETECTION_RUN: "Profile duplicate scan",
  PROFILE_DUPLICATE_MERGED: "Profile duplicate merged",
  DUPLICATE_DETECTION_RUN: "Application duplicate scan",
  DUPLICATE_REVIEW_DECIDED: "Duplicate review decision",
  DUPLICATE_PROFILE_LINKED: "Duplicate profile linked",
  DUPLICATE_PROFILE_MERGED: "Duplicate profile merged",
  DUPLICATE_MATCH_IGNORED: "Duplicate match ignored",
  DUPLICATE_MARKED_NEW: "Marked as new member",
  SUBSCRIPTION_FIELDS_UPDATED: "Subscription updated",
  REMINDER_DATES_CHANGED: "Reminder dates changed",
  CANCELLATION_DATES_CHANGED: "Cancellation dates changed",
  UNDERGRADUATE_GRADUATION_CANCELLED: "Undergraduate graduation cancellation",
  REMINDER_BATCH_CANCELLATION: "Reminder batch cancellation",
  SUBSCRIPTION_CANCEL_REQUESTED: "Subscription cancelled",
  CANCELLATION_UNDONE: "Cancellation undone",
  MEMBERSHIP_CATEGORY_CHANGED: "Membership category changed",
  APPLICATION_APPROVED: "Application approved",
  APPLICATION_PROCESSED: "Application processed",
  APPLICATION_REJECTED: "Application rejected",
  APPLICATION_SUBMITTED: "Application submitted",
  EXECUTIVE_COUNCIL_APPROVED: "Executive Council approved",
  EXECUTIVE_COUNCIL_REJECTED: "Executive Council rejected",
  JOURNAL_POSTED: "General ledger posting",
  RECEIPT_POSTED: "Receipt posted",
  ONLINE_PAYMENT_RECEIPT_POSTED: "Online payment receipt posted",
  CHEQUE_RECEIPT_POSTED: "Cheque receipt posted",
  CASH_RECEIPT_POSTED: "Cash receipt posted",
  SALARY_DEDUCTION_RECEIPT_POSTED: "Salary deduction receipt posted",
  STANDING_ORDER_RECEIPT_POSTED: "Standing order receipt posted",
  DIRECT_DEBIT_RECEIPT_POSTED: "Direct debit receipt posted",
  BATCH_RECEIPT_POSTED: "Batch receipt posted",
  INVOICE_POSTED: "Invoice posted",
  CREDIT_NOTE_POSTED: "Credit note posted",
  CREDIT_NOTE_DRAFT_CREATED: "Credit note draft created",
  CREDIT_NOTE_APPROVED: "Credit note approved",
  CREDIT_NOTE_CANCELLED: "Credit note cancelled",
  REFUND_POSTED: "Refund posted",
  WRITE_OFF_POSTED: "Write-off posted",
  ADJUSTMENT_POSTED: "Adjustment posted",
  FEE_ADJUSTMENT_POSTED: "Fee adjustment posted",
  FEE_INCREASE_POSTED: "Fee increase posted",
  FEE_DECREASE_POSTED: "Fee decrease posted",
  SETTLEMENT_POSTED: "Settlement posted",
  CLAIM_POSTED: "Claim posted",
  RECEIPT_REVERSED: "Receipt reversed",
  CLAIM_REVERSED: "Claim reversed",
  MEMBER_CREDIT_APPLIED: "Member credit applied",
  PAYMENT_REASSIGNED: "Payment reassigned",
  JOURNAL_ADJUSTMENT_DRAFT_CREATED: "Journal adjustment draft created",
  JOURNAL_ADJUSTMENT_APPROVED: "Journal adjustment approved",
  JOURNAL_ADJUSTMENT_POSTED: "Journal adjustment posted",
  BATCH_PROCESS_COMPLETED: "Batch import processed",
  BATCH_PROCESS_QUEUED: "Batch import queued",
  RECONCILIATION_MANUAL_MATCHED: "Reconciliation matched",
  RECONCILIATION_MOVED_TO_SUSPENSE: "Reconciliation moved to suspense",
  RECONCILIATION_SETTLED: "Reconciliation settled",
};

/**
 * @param {string} action
 * @param {string} [field]
 */
export function describeAuditChange(action, field) {
  const label = ACTION_LABELS[action] || action?.replace(/_/g, " ").toLowerCase();
  if (!field) return label;
  const fieldLabel = field
    .replace(/\./g, " › ")
    .replace(/([A-Z])/g, " $1")
    .trim();
  return `${label}: ${fieldLabel}`;
}

/**
 * Expand audit log rows into one UI row per changed field.
 * @param {object[]} rows - raw DB rows (snake_case)
 */
export function expandAuditRowsToChanges(rows) {
  const items = [];

  for (const row of rows) {
    const metadata =
      row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const before = row.before_state ?? null;
    const after = row.after_state ?? null;
    const changedFields = metadata.changedFields || metadata.changedPaths || null;

    const changes = diffAuditStates(before, after, {
      changedFields,
      changedPaths: changedFields,
    });

    if (shouldRenderFinanceAsSingleRow(row, before, after, changedFields)) {
      items.push({
        auditLogId: row.id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        service: row.service,
        field: null,
        changeDescription: describeAuditChange(row.action),
        oldValue: "—",
        newValue: formatFinanceEventSummary(after, row.action),
        occurredAt: row.occurred_at,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
      });
      continue;
    }

    if (changes.length === 0) {
      items.push({
        auditLogId: row.id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        service: row.service,
        field: null,
        changeDescription: describeAuditChange(row.action),
        oldValue: "—",
        newValue: metadata.duplicateAction
          ? String(metadata.duplicateAction)
          : row.action,
        occurredAt: row.occurred_at,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
      });
      continue;
    }

    for (const change of changes) {
      items.push({
        auditLogId: row.id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        action: row.action,
        service: row.service,
        field: change.field,
        changeDescription: describeAuditChange(row.action, change.field),
        oldValue: change.oldValue,
        newValue: change.newValue,
        occurredAt: row.occurred_at,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
      });
    }
  }

  const deduped = dedupeExpandedItems(items);

  deduped.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return deduped;
}
