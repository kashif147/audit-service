import { buildServiceHeaders } from "./requestHeaders.js";

const PROFILE_SERVICE_URL =
  process.env.PROFILE_SERVICE_URL ||
  process.env.PROFILE_SERVICE_BASE_URL ||
  "";

function profileBase() {
  return PROFILE_SERVICE_URL.replace(/\/$/, "");
}

/**
 * @param {string[]} profileIds
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 * @returns {Promise<Map<string, { fullName: string|null, membershipNumber: string|null }>>}
 */
export async function fetchProfileSummariesByIds(profileIds, ctx) {
  const base = profileBase();
  const ids = [...new Set((profileIds || []).map(String).filter(Boolean))];
  const map = new Map();
  if (!base || !ids.length || !ctx.tenantId) return map;

  const res = await fetch(`${base}/profile/batch`, {
    method: "POST",
    headers: buildServiceHeaders(ctx.req, ctx.tenantId),
    body: JSON.stringify({ profileIds: ids }),
  });
  if (!res.ok) return map;

  const body = await res.json();
  const profiles = Array.isArray(body?.data) ? body.data : [];
  for (const profile of profiles) {
    const id = profile?._id ? String(profile._id) : profile?.id ? String(profile.id) : "";
    if (!id) continue;
    const pi = profile.personalInfo || {};
    const fullName =
      (pi.fullName && String(pi.fullName).trim()) ||
      [pi.forename, pi.surname]
        .map((p) => (p ? String(p).trim() : ""))
        .filter(Boolean)
        .join(" ") ||
      profile.fullName ||
      null;
    map.set(id, {
      fullName: fullName ? String(fullName).trim() : null,
      membershipNumber: profile.membershipNumber
        ? String(profile.membershipNumber).trim()
        : null,
    });
  }
  return map;
}

/**
 * @param {string[]} applicationIds
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 * @returns {Promise<Map<string, { label: string|null }>>}
 */
export async function fetchApplicationSummariesByIds(applicationIds, ctx) {
  const base = profileBase();
  const ids = [...new Set((applicationIds || []).map(String).filter(Boolean))];
  const map = new Map();
  if (!base || !ids.length || !ctx.tenantId) return map;

  await Promise.all(
    ids.map(async (applicationId) => {
      try {
        const res = await fetch(`${base}/applications/${encodeURIComponent(applicationId)}`, {
          headers: buildServiceHeaders(ctx.req, ctx.tenantId),
        });
        if (!res.ok) return;
        const body = await res.json();
        const payload = body?.data ?? body;
        const pd = payload?.personalDetails?.personalInfo || payload?.personalInfo || {};
        const name =
          (pd.fullName && String(pd.fullName).trim()) ||
          [pd.forename, pd.surname]
            .map((p) => (p ? String(p).trim() : ""))
            .filter(Boolean)
            .join(" ");
        const category =
          payload?.subscriptionDetails?.membershipCategory ||
          payload?.professionalDetails?.membershipCategory ||
          "";
        const categoryStr = category ? String(category).trim() : "";
        const nameStr = name ? String(name).trim() : "";
        let label = null;
        if (nameStr && categoryStr) label = `${nameStr} · ${categoryStr}`;
        else label = nameStr || categoryStr || null;
        if (label) map.set(applicationId, { label });
      } catch {
        /* ignore single fetch failure */
      }
    }),
  );

  return map;
}
