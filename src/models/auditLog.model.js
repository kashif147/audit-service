import { query } from "../config/db.js";

/**
 * Insert one audit log row.
 *
 * @param {object} log
 * @param {string}  log.tenantId
 * @param {string}  log.eventType      - RabbitMQ routing key
 * @param {string}  log.exchange       - RabbitMQ exchange name
 * @param {string}  log.service        - originating service
 * @param {string}  log.action         - e.g. APPLICATION_APPROVED
 * @param {string}  [log.resourceType] - e.g. "application"
 * @param {string}  [log.resourceId]
 * @param {string}  [log.actorId]
 * @param {string}  [log.actorEmail]
 * @param {string}  [log.correlationId]
 * @param {string}  [log.eventId]
 * @param {object}  [log.before]
 * @param {object}  [log.after]
 * @param {object}  [log.metadata]
 * @param {Date}    [log.occurredAt]
 * @returns {Promise<object>} inserted row
 */
export async function createAuditLog(log) {
  const {
    tenantId,
    eventType,
    exchange,
    service,
    action,
    resourceType = null,
    resourceId   = null,
    actorId      = null,
    actorEmail   = null,
    correlationId = null,
    eventId      = null,
    before       = null,
    after        = null,
    metadata     = null,
    occurredAt   = new Date(),
  } = log;

  const { rows } = await query(
    `INSERT INTO audit_logs
       (tenant_id, event_type, exchange, service, action,
        resource_type, resource_id, actor_id, actor_email,
        correlation_id, event_id,
        before_state, after_state, metadata,
        occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      tenantId, eventType, exchange, service, action,
      resourceType, resourceId, actorId, actorEmail,
      correlationId, eventId,
      before  ? JSON.stringify(before)   : null,
      after   ? JSON.stringify(after)    : null,
      metadata ? JSON.stringify(metadata) : null,
      occurredAt,
    ]
  );

  return rows[0];
}

/**
 * Query audit logs with filters and pagination.
 */
export async function findAuditLogs({
  tenantId,
  resourceType,
  resourceId,
  actorId,
  action,
  service,
  eventType,
  from,
  to,
  limit  = 500,
  offset = 0,
}) {
  const conditions = ["tenant_id = $1"];
  const params     = [tenantId];
  let   idx        = 2;

  if (resourceType) { conditions.push(`resource_type = $${idx++}`); params.push(resourceType); }
  if (resourceId)   { conditions.push(`resource_id = $${idx++}`);   params.push(resourceId);   }
  if (actorId)      { conditions.push(`actor_id = $${idx++}`);      params.push(actorId);       }
  if (action)       { conditions.push(`action = $${idx++}`);        params.push(action);        }
  if (service)      { conditions.push(`service = $${idx++}`);       params.push(service);       }
  if (eventType)    { conditions.push(`event_type = $${idx++}`);    params.push(eventType);     }
  if (from)         { conditions.push(`occurred_at >= $${idx++}`);  params.push(new Date(from)); }
  if (to)           { conditions.push(`occurred_at <= $${idx++}`);  params.push(new Date(to));   }

  const where = conditions.join(" AND ");

  const [dataRes, countRes] = await Promise.all([
    query(
      `SELECT * FROM audit_logs WHERE ${where}
       ORDER BY occurred_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) FROM audit_logs WHERE ${where}`, params),
  ]);

  return {
    total: parseInt(countRes.rows[0].count),
    items: dataRes.rows,
  };
}

/**
 * Get the full event history for a single resource.
 */
export async function getResourceHistory(tenantId, resourceType, resourceId) {
  const { rows } = await query(
    `SELECT * FROM audit_logs
     WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
     ORDER BY occurred_at ASC`,
    [tenantId, resourceType, resourceId]
  );
  return rows;
}
