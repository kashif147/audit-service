import { query } from "../config/db.js";

/**
 * Insert one audit log row.
 *
 * @param {object} log
 * @param {string}  log.tenantId
 * @param {string}  log.eventType      - RabbitMQ routing key
 * @param {string}  log.exchange       - RabbitMQ exchange name
 * @param {string}  log.service        - originating service
 * @param {string}  log.action         - e.g. APPLICATION_PROCESSED
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

  if (eventId) {
    const { rows: byEvent } = await query(
      `SELECT * FROM audit_logs WHERE tenant_id = $1 AND event_id = $2 LIMIT 1`,
      [tenantId, eventId],
    );
    if (byEvent.length) return byEvent[0];
  }

  const dedupeKey =
    metadata && typeof metadata === "object" ? metadata.dedupeKey : null;
  if (dedupeKey) {
    const { rows: byKey } = await query(
      `SELECT * FROM audit_logs
       WHERE tenant_id = $1 AND metadata->>'dedupeKey' = $2
       LIMIT 1`,
      [tenantId, String(dedupeKey)],
    );
    if (byKey.length) return byKey[0];
  }

  const journalDocNo =
    after && typeof after === "object" && after.docNo
      ? String(after.docNo)
      : null;
  if (
    resourceType === "finance" &&
    journalDocNo &&
    eventType === "journal.created.v1"
  ) {
    const { rows: byJournal } = await query(
      `SELECT * FROM audit_logs
       WHERE tenant_id = $1
         AND resource_type = 'finance'
         AND event_type = 'journal.created.v1'
         AND after_state->>'docNo' = $2
       LIMIT 1`,
      [tenantId, journalDocNo],
    );
    if (byJournal.length) return byJournal[0];
  }

  const { rows } = await query(
    `INSERT INTO audit_logs
       (tenant_id, event_type, exchange, service, action,
        resource_type, resource_id, actor_id, actor_email,
        correlation_id, event_id,
        before_state, after_state, metadata,
        occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tenant_id, event_id) WHERE event_id IS NOT NULL
     DO UPDATE SET event_id = EXCLUDED.event_id
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
     ORDER BY occurred_at DESC`,
    [tenantId, resourceType, resourceId]
  );
  return rows;
}

/**
 * Member-centric audit history: profile + related subscription/application resources.
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.profileId
 * @param {string[]} [params.subscriptionIds]
 * @param {string[]} [params.applicationIds]
 * @param {string} [params.membershipNumber] - match finance rows by GL member id
 * @param {string} [params.resourceType] - optional filter (profile | subscription | application | finance)
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 */
export async function findMemberAuditLogs({
  tenantId,
  profileId,
  membershipNumber = null,
  subscriptionIds = [],
  applicationIds = [],
  resourceType = null,
  limit = 500,
  offset = 0,
}) {
  const clauses = [];
  const params = [tenantId];
  let idx = 2;

  const profileClause = `(resource_type = 'profile' AND resource_id = $${idx++})`;
  params.push(String(profileId));

  const subIds = (subscriptionIds || []).map(String).filter(Boolean);
  const appIds = (applicationIds || []).map(String).filter(Boolean);
  const memberNo =
    membershipNumber != null && String(membershipNumber).trim()
      ? String(membershipNumber).trim()
      : null;

  const orParts = [profileClause];

  if (subIds.length) {
    orParts.push(
      `(resource_type = 'subscription' AND resource_id = ANY($${idx++}::text[]))`,
    );
    params.push(subIds);
  }
  if (appIds.length) {
    orParts.push(
      `(resource_type = 'application' AND resource_id = ANY($${idx++}::text[]))`,
    );
    params.push(appIds);
  }

  const financeParts = [
    `(resource_type = 'finance' AND resource_id = $${idx++})`,
  ];
  params.push(String(profileId));
  if (memberNo) {
    financeParts.push(
      `(resource_type = 'finance' AND after_state->>'memberId' = $${idx++})`,
    );
    params.push(memberNo);
    financeParts.push(
      `(resource_type = 'journal' AND after_state->>'memberId' = $${idx++})`,
    );
    params.push(memberNo);
  }
  orParts.push(`(${financeParts.join(" OR ")})`);

  clauses.push(`tenant_id = $1`);
  clauses.push(`(${orParts.join(" OR ")})`);

  if (resourceType) {
    clauses.push(`resource_type = $${idx++}`);
    params.push(resourceType);
  }

  const where = clauses.join(" AND ");

  const [dataRes, countRes] = await Promise.all([
    query(
      `SELECT * FROM audit_logs WHERE ${where}
       ORDER BY occurred_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset],
    ),
    query(`SELECT COUNT(*) FROM audit_logs WHERE ${where}`, params),
  ]);

  return {
    total: parseInt(countRes.rows[0].count, 10),
    items: dataRes.rows,
  };
}
