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
      changes.push({
        field: path,
        oldValue: formatAuditValue(oldValue),
        newValue: formatAuditValue(newValue),
      });
    }
  }

  return changes;
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
  APPLICATION_REJECTED: "Application rejected",
  APPLICATION_SUBMITTED: "Application submitted",
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

  items.sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  return items;
}
