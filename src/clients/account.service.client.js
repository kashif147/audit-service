import { buildServiceHeaders } from "./requestHeaders.js";

const ACCOUNT_SERVICE_URL =
  process.env.ACCOUNT_SERVICE_URL ||
  process.env.ACCOUNT_SERVICE_BASE_URL ||
  "";

function accountBase() {
  return ACCOUNT_SERVICE_URL.replace(/\/$/, "");
}

function formatEuroCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return `€${(n / 100).toLocaleString("en-IE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * @param {string[]} paymentIntentIds
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 * @returns {Promise<Map<string, { amountLabel: string|null }>>}
 */
export async function fetchPaymentSummariesByIntentIds(paymentIntentIds, ctx) {
  const base = accountBase();
  const ids = [...new Set((paymentIntentIds || []).map(String).filter(Boolean))];
  const map = new Map();
  if (!base || !ids.length || !ctx.tenantId) return map;

  await Promise.all(
    ids.map(async (paymentIntentId) => {
      try {
        const res = await fetch(
          `${base}/payments/by-stripe/${encodeURIComponent(paymentIntentId)}`,
          { headers: buildServiceHeaders(ctx.req, ctx.tenantId) },
        );
        if (!res.ok) return;
        const body = await res.json();
        const payment = body?.data ?? body;
        const amountLabel = formatEuroCents(payment?.amount);
        if (amountLabel) map.set(paymentIntentId, { amountLabel });
      } catch {
        /* ignore */
      }
    }),
  );

  return map;
}
