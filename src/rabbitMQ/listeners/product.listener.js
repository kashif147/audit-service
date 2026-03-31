import { createAuditLog } from "../../models/auditLog.model.js";
import logger from "../../config/logger.js";

const ACTION_MAP = {
  "product.type.created.v1": "PRODUCT_TYPE_CREATED",
  "product.type.updated.v1": "PRODUCT_TYPE_UPDATED",
  "product.type.deleted.v1": "PRODUCT_TYPE_DELETED",
  "product.created.v1":      "PRODUCT_CREATED",
  "product.updated.v1":      "PRODUCT_UPDATED",
  "product.deleted.v1":      "PRODUCT_DELETED",
  "pricing.created.v1":      "PRICING_CREATED",
  "pricing.updated.v1":      "PRICING_UPDATED",
  "pricing.deleted.v1":      "PRICING_DELETED",
};

const RESOURCE_MAP = {
  "product.type.created.v1": "productType",
  "product.type.updated.v1": "productType",
  "product.type.deleted.v1": "productType",
  "product.created.v1":      "product",
  "product.updated.v1":      "product",
  "product.deleted.v1":      "product",
  "pricing.created.v1":      "pricing",
  "pricing.updated.v1":      "pricing",
  "pricing.deleted.v1":      "pricing",
};

export async function handleProductEvent(payload, eventType, exchange) {
  const data = payload.data || payload;

  await createAuditLog({
    tenantId:      data.tenantId || payload.tenantId || "unknown",
    eventType,
    exchange,
    service:       payload.metadata?.service || "user-service",
    action:        ACTION_MAP[eventType] || "UNKNOWN",
    resourceType:  RESOURCE_MAP[eventType],
    resourceId:    data.id || data._id || data.productId || data.pricingId || data.productTypeId,
    actorId:       data.updatedBy || data.createdBy || data.deletedBy,
    correlationId: payload.correlationId,
    eventId:       payload.eventId,
    after:         data,
    metadata:      payload.metadata,
    occurredAt:    new Date(payload.timestamp || Date.now()),
  });

  logger.debug({ eventType }, "Product event audited");
}
