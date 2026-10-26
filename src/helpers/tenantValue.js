// A tenant value that may own an audit row (Phase A / A1): a non-empty identifier that is not a
// placeholder. Audit history must never be attributed to "unknown"/"default"/"system".
const PLACEHOLDERS = new Set(["unknown", "default", "system", "null", "undefined"]);
const TENANT_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;

export const cleanTenant = (v) => (v == null ? "" : String(v).trim());

export function isValidTenantId(value) {
  const v = cleanTenant(value);
  return Boolean(v) && TENANT_FORMAT.test(v) && !PLACEHOLDERS.has(v.toLowerCase());
}
