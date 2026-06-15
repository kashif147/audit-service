import { findAuditLogs, getResourceHistory, findMemberAuditLogs } from "../models/auditLog.model.js";
import { expandAuditRowsToChanges } from "../helpers/auditDiff.js";
import { enrichAuditActors } from "../helpers/auditActorEnrichment.js";
import { enrichAuditValues } from "../helpers/auditValueEnrichment.js";
import { query } from "../config/db.js";

function parseIdList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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
 * GET /api/audit-logs/member/:profileId
 * Query: subscriptionIds, applicationIds (comma-separated), resourceType, limit, offset, diffOnly (default true)
 */
export async function getMemberAuditHistory(req, res, next) {
  try {
    const tenantId = req.headers["x-tenant-id"] || req.query.tenantId;
    if (!tenantId) return res.fail("x-tenant-id header is required", 400);

    const { profileId } = req.params;
    if (!profileId) return res.fail("profileId is required", 400);

    const limit = Math.min(parseInt(req.query.limit || "500", 10), 1000);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
    const diffOnly = req.query.diffOnly !== "false";

    const result = await findMemberAuditLogs({
      tenantId,
      profileId: String(profileId),
      membershipNumber: req.query.membershipNumber || null,
      subscriptionIds: parseIdList(req.query.subscriptionIds),
      applicationIds: parseIdList(req.query.applicationIds),
      resourceType: req.query.resourceType || null,
      limit,
      offset,
    });

    if (diffOnly) {
      const changes = expandAuditRowsToChanges(result.items);
      await enrichAuditActors(changes, { tenantId, req });
      await enrichAuditValues(changes, { tenantId, req });
      return res.success({
        profileId: String(profileId),
        total: result.total,
        changeCount: changes.length,
        items: changes,
        limit,
        offset,
      });
    }

    res.success({ ...result, profileId: String(profileId), limit, offset });
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
