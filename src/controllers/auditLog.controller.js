import { findAuditLogs, getResourceHistory } from "../models/auditLog.model.js";
import { query } from "../config/db.js";

/**
 * GET /api/audit-logs
 * Query params: tenantId, resourceType, resourceId, actorId, action,
 *               service, eventType, from, to, limit, offset
 */
export async function listAuditLogs(req, res, next) {
  try {
    const tenantId = req.headers["x-tenant-id"] || req.query.tenantId;
    if (!tenantId) return res.fail("x-tenant-id header is required", 400);

    const limit  = Math.min(parseInt(req.query.limit  || "500"),  1000);
    const offset = Math.max(parseInt(req.query.offset || "0"),   0);

    const result = await findAuditLogs({
      tenantId,
      resourceType: req.query.resourceType,
      resourceId:   req.query.resourceId,
      actorId:      req.query.actorId,
      action:       req.query.action,
      service:      req.query.service,
      eventType:    req.query.eventType,
      from:         req.query.from,
      to:           req.query.to,
      limit,
      offset,
    });

    res.success({ ...result, limit, offset });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit-logs/:id
 */
export async function getAuditLog(req, res, next) {
  try {
    const { rows } = await query("SELECT * FROM audit_logs WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.fail("Audit log not found", 404);
    res.success(rows[0]);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit-logs/resource/:resourceType/:resourceId
 * Full history for one resource (e.g. all events on applicationId abc123)
 */
export async function getResourceAuditHistory(req, res, next) {
  try {
    const tenantId = req.headers["x-tenant-id"] || req.query.tenantId;
    if (!tenantId) return res.fail("x-tenant-id header is required", 400);

    const { resourceType, resourceId } = req.params;
    const rows = await getResourceHistory(tenantId, resourceType, resourceId);
    res.success({ total: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit-logs/summary
 * Event counts grouped by action + service for a time range
 */
export async function getAuditSummary(req, res, next) {
  try {
    const tenantId = req.headers["x-tenant-id"] || req.query.tenantId;
    if (!tenantId) return res.fail("x-tenant-id header is required", 400);

    const from = req.query.from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to   = req.query.to   || new Date().toISOString();

    const { rows } = await query(
      `SELECT action, service, COUNT(*) as count
       FROM audit_logs
       WHERE tenant_id = $1 AND occurred_at BETWEEN $2 AND $3
       GROUP BY action, service
       ORDER BY count DESC`,
      [tenantId, new Date(from), new Date(to)]
    );

    res.success({ from, to, summary: rows });
  } catch (err) {
    next(err);
  }
}
