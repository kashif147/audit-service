import { fetchUserActorLookup, fetchTenantName } from "../clients/user.service.client.js";
import {
  fetchProfileSummariesByIds,
  fetchApplicationSummariesByIds,
} from "../clients/profile.service.client.js";
import { fetchSubscriptionSummariesByIds } from "../clients/subscription.service.client.js";
import { fetchPaymentSummariesByIntentIds } from "../clients/account.service.client.js";

const USER_FIELD_KEYS = new Set([
  "actorUserId",
  "actorId",
  "crmUserId",
  "userId",
  "reviewerId",
  "reviewedBy",
  "approvedBy",
  "runBy",
  "submittedBy",
  "cancelledBy",
  "resignedBy",
  "createdBy",
  "updatedBy",
]);

const PROFILE_FIELD_KEYS = new Set([
  "profileId",
  "matchedProfileId",
  "masterProfileId",
  "absorbedProfileId",
]);

const APPLICATION_FIELD_KEYS = new Set(["applicationId"]);

const SUBSCRIPTION_FIELD_KEYS = new Set([
  "subscriptionId",
  "currentSubscriptionId",
]);

const TENANT_FIELD_KEYS = new Set(["tenantId"]);

const PAYMENT_INTENT_FIELD_KEYS = new Set([
  "paymentIntentId",
]);

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_PI_RE = /^pi_[a-zA-Z0-9]+$/;

function fieldLeaf(fieldPath) {
  if (!fieldPath) return "";
  const path = String(fieldPath);
  return path.includes(".") ? path.split(".").pop() : path;
}

/**
 * @param {string|null|undefined} field
 * @param {string|null|undefined} resourceType
 */
function resolveEnrichmentKind(field, resourceType) {
  const leaf = fieldLeaf(field);
  if (!leaf) return null;

  if (USER_FIELD_KEYS.has(leaf)) return "user";
  if (PROFILE_FIELD_KEYS.has(leaf)) return "profile";
  if (APPLICATION_FIELD_KEYS.has(leaf)) return "application";
  if (SUBSCRIPTION_FIELD_KEYS.has(leaf)) return "subscription";
  if (TENANT_FIELD_KEYS.has(leaf)) return "tenant";
  if (
    PAYMENT_INTENT_FIELD_KEYS.has(leaf) ||
    String(field || "").toLowerCase().includes("paymentintentid")
  ) {
    return "paymentIntent";
  }

  if (leaf === "id" || leaf === "_id") {
    if (resourceType === "profile") return "profile";
    if (resourceType === "application") return "application";
    if (resourceType === "subscription") return "subscription";
  }

  return null;
}

function isAlreadyEnriched(value) {
  const s = String(value || "").trim();
  return s.includes("(") && s.endsWith(")");
}

function isResolvableIdValue(value, kind) {
  if (value == null || value === "" || value === "—") return false;
  if (isAlreadyEnriched(value)) return false;
  const s = String(value).trim();
  if (kind === "paymentIntent") return STRIPE_PI_RE.test(s) || s.length > 8;
  return OBJECT_ID_RE.test(s) || UUID_RE.test(s);
}

function collectIdsByKind(items) {
  const buckets = {
    user: new Set(),
    profile: new Set(),
    application: new Set(),
    subscription: new Set(),
    tenant: new Set(),
    paymentIntent: new Set(),
  };

  for (const item of items) {
    const kind = resolveEnrichmentKind(item.field, item.resourceType);
    if (!kind) continue;
    for (const raw of [item.oldValue, item.newValue]) {
      if (!isResolvableIdValue(raw, kind)) continue;
      buckets[kind].add(String(raw).trim());
    }
  }

  return buckets;
}

function formatUserLabel(entry, id) {
  const name = entry?.name ? String(entry.name).trim() : "";
  const email = entry?.email ? String(entry.email).trim() : "";
  const label = name || email;
  return label ? `${label} (${id})` : null;
}

function formatProfileLabel(entry, id) {
  const name = entry?.fullName ? String(entry.fullName).trim() : "";
  if (name) return `${name} (${id})`;
  if (entry?.membershipNumber) {
    return `${entry.membershipNumber} (${id})`;
  }
  return null;
}

function formatApplicationLabel(entry, id) {
  if (entry?.label) return `${entry.label} (${id})`;
  return null;
}

function formatSubscriptionLabel(entry, id) {
  const category = entry?.membershipCategory
    ? String(entry.membershipCategory).trim()
    : "";
  if (category) return `${category} (${id})`;
  return null;
}

function formatTenantLabel(name, id) {
  if (name) return `${name} (${id})`;
  return null;
}

function formatPaymentLabel(entry, id) {
  if (entry?.amountLabel) return `${entry.amountLabel} (${id})`;
  return null;
}

/**
 * @param {object[]} items
 * @param {{ tenantId: string, req?: import("express").Request }} ctx
 */
export async function enrichAuditValues(items, ctx) {
  if (!Array.isArray(items) || !items.length || !ctx.tenantId) return items;

  const buckets = collectIdsByKind(items);

  const [
    userLookup,
    profiles,
    applications,
    subscriptions,
    paymentIntents,
  ] = await Promise.all([
    buckets.user.size
      ? fetchUserActorLookup(ctx)
      : Promise.resolve(new Map()),
    buckets.profile.size
      ? fetchProfileSummariesByIds([...buckets.profile], ctx)
      : Promise.resolve(new Map()),
    buckets.application.size
      ? fetchApplicationSummariesByIds([...buckets.application], ctx)
      : Promise.resolve(new Map()),
    buckets.subscription.size
      ? fetchSubscriptionSummariesByIds([...buckets.subscription], ctx)
      : Promise.resolve(new Map()),
    buckets.paymentIntent.size
      ? fetchPaymentSummariesByIntentIds([...buckets.paymentIntent], ctx)
      : Promise.resolve(new Map()),
  ]);

  const tenantNames = new Map();
  if (buckets.tenant.size) {
    await Promise.all(
      [...buckets.tenant].map(async (tenantId) => {
        const name = await fetchTenantName(tenantId, ctx);
        if (name) tenantNames.set(tenantId, name);
      }),
    );
  }

  for (const item of items) {
    const kind = resolveEnrichmentKind(item.field, item.resourceType);
    if (!kind) continue;

    item.oldValue = enrichSingleValue(
      item.oldValue,
      kind,
      userLookup,
      profiles,
      applications,
      subscriptions,
      tenantNames,
      paymentIntents,
    );
    item.newValue = enrichSingleValue(
      item.newValue,
      kind,
      userLookup,
      profiles,
      applications,
      subscriptions,
      tenantNames,
      paymentIntents,
    );
  }

  return items;
}

function enrichSingleValue(
  rawValue,
  kind,
  userLookup,
  profiles,
  applications,
  subscriptions,
  tenantNames,
  paymentIntents,
) {
  if (!isResolvableIdValue(rawValue, kind)) return rawValue;
  const id = String(rawValue).trim();

  switch (kind) {
    case "user": {
      const entry = userLookup.get(id.toLowerCase());
      return formatUserLabel(entry, id) || rawValue;
    }
    case "profile": {
      return formatProfileLabel(profiles.get(id), id) || rawValue;
    }
    case "application": {
      return formatApplicationLabel(applications.get(id), id) || rawValue;
    }
    case "subscription": {
      return formatSubscriptionLabel(subscriptions.get(id), id) || rawValue;
    }
    case "tenant": {
      return formatTenantLabel(tenantNames.get(id), id) || rawValue;
    }
    case "paymentIntent": {
      return formatPaymentLabel(paymentIntents.get(id), id) || rawValue;
    }
    default:
      return rawValue;
  }
}
