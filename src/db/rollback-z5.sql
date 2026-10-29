-- Phase B / Z5 rollback (manual; run only with owner approval, after rolling the audit-service image back
-- to a build without the platform audit store - otherwise the next migration run re-creates the table).
-- Drops ONLY what Z5 added. WARNING: this deletes the authoritative platform / system security records
-- written since the Z5 cutover - export them first (e.g. COPY platform_audit_logs TO ...) if they must be kept.
-- audit_logs (tenant-owned, including the TENANT_CREATED lifecycle copies) is untouched.
DROP INDEX IF EXISTS uniq_platform_audit_event_id;
DROP TABLE IF EXISTS platform_audit_logs;
