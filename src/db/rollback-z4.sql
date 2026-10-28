-- Phase B / Z4 rollback (manual; run only with owner approval, after rolling the audit-service image back
-- to a build without the actor / target context - otherwise the next boot re-adds the columns).
-- Drops ONLY what Z4 added. Rows written while Z4 ran keep their tenant_id (A1 owner) and every other field.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_scope_check;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS target_tenant_id;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS actor_tenant_id;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS actor_scope;
