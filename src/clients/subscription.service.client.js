import { buildServiceHeaders } from "./requestHeaders.js";

const SUBSCRIPTION_SERVICE_URL =
  process.env.SUBSCRIPTION_SERVICE_URL ||
  process.env.SUBSCRIPTION_SERVICE_BASE_URL ||
  "";

function subscriptionBase() {
  return SUBSCRIPTION_SERVICE_URL.replace(/\/$/, "");
}

/**
 * @param {string[]} subscriptionIds
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 * @returns {Promise<Map<string, { membershipCategory: string|null }>>}
 */
export async function fetchSubscriptionSummariesByIds(subscriptionIds, ctx) {
  const base = subscriptionBase();
  const ids = [...new Set((subscriptionIds || []).map(String).filter(Boolean))];
  const map = new Map();
  if (!base || !ids.length || !ctx.tenantId) return map;

  await Promise.all(
    ids.map(async (subscriptionId) => {
      try {
        const res = await fetch(
          `${base}/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
          { headers: buildServiceHeaders(ctx.req, ctx.tenantId) },
        );
        if (!res.ok) return;
        const body = await res.json();
        const rows = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
        const sub = rows[0] || body?.data || null;
        const category = sub?.membershipCategory ?? sub?.professionalDetails?.membershipCategory;
        if (category != null && String(category).trim()) {
          map.set(subscriptionId, {
            membershipCategory: String(category).trim(),
          });
        }
      } catch {
        /* ignore */
      }
    }),
  );

  return map;
}
