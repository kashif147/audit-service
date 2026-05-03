import { createAuditLog } from "../models/auditLog.model.js";
import logger from "../config/logger.js";

/**
 * Service-to-service audit insert (communication-service campaigns, etc.).
 * Body must include tenantId and action.
 */
export async function postInternalAuditLog(req, res) {
  try {
    const secret = process.env.SERVICE_AUDIT_SECRET;
    if (!secret || req.headers["x-service-secret"] !== secret) {
      return res.status(403).json({
        status: "fail",
        message: "Forbidden",
        timestamp: new Date().toISOString(),
      });
    }

    const {
      tenantId,
      action,
      resourceType = "campaign",
      resourceId = null,
      actorId = null,
      actorEmail = null,
      metadata = null,
      eventType = "communication.campaign",
      exchange = "communication-service",
      service = "communication-service",
    } = req.body || {};

    if (!tenantId || !action) {
      return res.status(400).json({
        status: "fail",
        message: "tenantId and action are required",
        timestamp: new Date().toISOString(),
      });
    }

    const row = await createAuditLog({
      tenantId,
      eventType,
      exchange,
      service,
      action,
      resourceType,
      resourceId,
      actorId,
      actorEmail,
      metadata,
    });

    return res.status(201).json({
      status: "success",
      data: { id: row?.id },
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    logger.error({ err: e.message }, "internal audit insert failed");
    return res.status(500).json({
      status: "error",
      message: e.message,
      timestamp: new Date().toISOString(),
    });
  }
}
