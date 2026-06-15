import { buildServiceHeaders } from "./requestHeaders.js";

const USER_SERVICE_URL =
  process.env.USER_SERVICE_URL ||
  process.env.POLICY_SERVICE_URL ||
  "";

function buildHeaders(req, tenantId) {
  return buildServiceHeaders(req, tenantId);
}

/**
 * Fetch tenant CRM users and index by id / Microsoft oid / subject for audit actor resolution.
 * @param {{ tenantId: string, req?: import("express").Request }} params
 * @returns {Promise<Map<string, { name: string|null, email: string|null }>>}
 */
export async function fetchUserActorLookup({ tenantId, req }) {
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  if (!base || !tenantId) return new Map();

  const url = `${base}/users`;
  const res = await fetch(url, { headers: buildHeaders(req, tenantId) });
  if (!res.ok) return new Map();

  const body = await res.json();
  const users = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];

  const map = new Map();
  for (const user of users) {
    const name =
      (user.userFullName && String(user.userFullName).trim()) ||
      [user.userFirstName, user.userLastName]
        .map((part) => (part ? String(part).trim() : ""))
        .filter(Boolean)
        .join(" ") ||
      null;
    const email =
      user.userEmail && String(user.userEmail).trim()
        ? String(user.userEmail).trim()
        : null;
    const entry = { name, email };
    const keys = [
      user._id,
      user.id,
      user.userMicrosoftId,
      user.userSubject,
    ].filter(Boolean);
    for (const key of keys) {
      map.set(String(key).toLowerCase(), entry);
    }
  }
  return map;
}

/**
 * @param {string} tenantId
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 * @returns {Promise<string|null>}
 */
export async function fetchTenantName(tenantId, ctx) {
  const base = USER_SERVICE_URL.replace(/\/$/, "");
  if (!base || !tenantId) return null;

  const res = await fetch(`${base}/tenants/${encodeURIComponent(tenantId)}`, {
    headers: buildHeaders(ctx.req, ctx.tenantId || tenantId),
  });
  if (!res.ok) return null;

  const body = await res.json();
  const tenant = body?.data ?? body;
  const name = tenant?.name || tenant?.code || null;
  return name ? String(name).trim() : null;
}
