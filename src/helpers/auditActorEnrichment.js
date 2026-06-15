import { fetchUserActorLookup } from "../clients/user.service.client.js";

const SYSTEM_ACTOR_LABELS = {
  "system@reminder-batch": "Reminder batch (system)",
  "system@reminder-clear": "Reminder clear (system)",
  "system@undergraduate-graduation-job": "Undergraduate graduation job (system)",
};

function formatActorEntry({ name, email }) {
  if (name && email && name.toLowerCase() !== email.toLowerCase()) {
    return name;
  }
  return name || email || null;
}

/**
 * @param {{ actorId?: string|null, actorEmail?: string|null }} item
 * @param {Map<string, { name: string|null, email: string|null }>} [lookup]
 */
export function resolveAuditActorDisplay(item, lookup = new Map()) {
  const emailRaw = item?.actorEmail ? String(item.actorEmail).trim() : "";
  if (emailRaw) {
    const systemLabel = SYSTEM_ACTOR_LABELS[emailRaw.toLowerCase()];
    if (systemLabel) return systemLabel;
    if (emailRaw.includes("@") && !emailRaw.toLowerCase().startsWith("system@")) {
      return emailRaw;
    }
  }

  const idRaw = item?.actorId ? String(item.actorId).trim() : "";
  if (idRaw) {
    const match = lookup.get(idRaw.toLowerCase());
    const formatted = match ? formatActorEntry(match) : null;
    if (formatted) return formatted;
  }

  if (emailRaw) return emailRaw;
  return null;
}

/**
 * @param {object[]} items
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 */
export async function enrichAuditActors(items, ctx) {
  if (!Array.isArray(items) || !items.length) return items;

  let lookup = new Map();
  const hasActorIds = items.some((item) => item?.actorId);
  if (hasActorIds) {
    try {
      lookup = await fetchUserActorLookup(ctx);
    } catch {
      lookup = new Map();
    }
  }

  for (const item of items) {
    item.actorDisplayName =
      resolveAuditActorDisplay(item, lookup) || "—";
  }

  return items;
}
