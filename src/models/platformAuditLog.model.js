import { query } from "../config/db.js";

// Phase B / Z5: platform_audit_logs writer (schema: src/db/migrate.js PLATFORM_AUDIT_TABLE).
// The record is built and validated by src/rabbitMQ/platformAudit.js; the invariants that decide where a
// row may live are checked again here (defence in depth - the table CHECKs are the last line).
// Idempotent: ON CONFLICT (event_id) DO NOTHING - a redelivered event never creates a second row.
// There is deliberately no read function: no API reads this table in Z5 (DB / ops access only).

const OBJECT_ID = /^[0-9a-f]{24}$/;
const SCOPES = new Set(["platform", "system", "tenant"]);
const RESULTS = new Set(["allowed", "denied", "success", "failure"]);

function invalid(reason) {
  const err = new Error("Platform audit record is invalid");
  err.code = "PLATFORM_AUDIT_INVALID";
  err.reason = reason;
  return err;
}

export async function insertPlatformAuditLog(r) {
  if (!r || typeof r.eventId !== "string" || !r.eventId) throw invalid("event_id_required");
  if (!SCOPES.has(r.actorScope)) throw invalid("actor_scope");
  if (typeof r.actorId !== "string" || !r.actorId) throw invalid("actor_id_required");
  if ((r.actorScope === "tenant") !== (r.actorTenantId != null)) throw invalid("actor_tenant_scope");
  for (const t of [r.actorTenantId, r.targetTenantId]) {
    if (t != null && !OBJECT_ID.test(String(t))) throw invalid("tenant_value");
  }
  if (!RESULTS.has(r.result)) throw invalid("result");

  const { rows } = await query(
    `INSERT INTO platform_audit_logs
       (event_id, event_type, service, action, actor_scope, actor_id, actor_tenant_id, target_tenant_id,
        permission, allowed, result, reason, operation, correlation_id, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [
      r.eventId,
      r.eventType,
      r.service,
      r.action,
      r.actorScope,
      r.actorId,
      r.actorTenantId ?? null,
      r.targetTenantId ?? null,
      r.permission ?? null,
      typeof r.allowed === "boolean" ? r.allowed : null,
      r.result,
      r.reason ?? null,
      r.operation ?? null,
      r.correlationId ?? null,
      JSON.stringify(r.metadata || {}),
      r.occurredAt instanceof Date ? r.occurredAt : new Date(),
    ],
  );
  return { inserted: rows.length === 1, id: rows[0]?.id ?? null };
}
