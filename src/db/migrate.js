/**
 * Run once to create the audit_logs / platform_audit_logs tables and their indexes.
 * Usage: npm run db:migrate
 */
import "dotenv-flow/config";
import { fileURLToPath } from "url";
import { connectDB, query, closeDB } from "../config/db.js";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id              BIGSERIAL PRIMARY KEY,

  -- Identity
  tenant_id       TEXT        NOT NULL,

  -- Event origin
  event_type      TEXT        NOT NULL,
  exchange        TEXT        NOT NULL,
  service         TEXT        NOT NULL,

  -- What happened
  action          TEXT        NOT NULL,

  -- What was affected
  resource_type   TEXT,
  resource_id     TEXT,

  -- Who did it
  actor_id        TEXT,
  actor_email     TEXT,

  -- Tracing
  correlation_id  TEXT,
  event_id        TEXT,

  -- Payload (JSONB = queryable, indexed)
  before_state    JSONB,
  after_state     JSONB,
  metadata        JSONB,

  -- Timing
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Phase B / Z4: actor / target-tenant context (src/helpers/auditContext.js). Additive and nullable:
// existing rows keep NULL (no historical rewrite), existing columns, constraints and indexes are unchanged,
// and tenant_id keeps its A1 meaning (the row's trusted owner tenant). Idempotent - runs at every boot.
// No new index: Z4 adds no read path on these columns (Z5/Z6 platform audit queries will justify one).
// Reverse (manual, only with owner approval): src/db/rollback-z4.sql.
const ACTOR_CONTEXT_COLUMNS = [
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_scope      TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_tenant_id  TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_tenant_id TEXT`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_scope_check') THEN
       ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_scope_check
         CHECK (actor_scope IS NULL OR actor_scope IN ('tenant', 'platform', 'system'));
     END IF;
   END $$`,
];

// Phase B / Z5: platform_audit_logs - the authoritative store for platform / system security events
// (src/rabbitMQ/platformAudit.js). Deliberately NO tenant_id: these rows belong to no customer tenant and
// are never read by a tenant API (no route / controller queries this table; DB / ops access only in Z5).
//   actor_scope      platform | system | tenant - "tenant" only for a TENANT actor denied a platform
//                    operation (recorded truthfully, never relabelled platform); actor_tenant_id is set
//                    exactly for that scope (who the tenant actor was - context, not ownership).
//   target_tenant_id NULL for platform-wide actions; a real ProjectShell tenant id otherwise.
// One index only: UNIQUE(event_id) - idempotent delivery (a redelivered / retried event can never create a
// second row). No read path exists yet, so no query index. Reverse (manual, owner approval): rollback-z5.sql.
const PLATFORM_AUDIT_TABLE = [
  `CREATE TABLE IF NOT EXISTS platform_audit_logs (
     id               BIGSERIAL   PRIMARY KEY,
     event_id         TEXT        NOT NULL,
     event_type       TEXT        NOT NULL,
     service          TEXT        NOT NULL,
     action           TEXT        NOT NULL,
     actor_scope      TEXT        NOT NULL,
     actor_id         TEXT        NOT NULL,
     actor_tenant_id  TEXT,
     target_tenant_id TEXT,
     permission       TEXT,
     allowed          BOOLEAN,
     result           TEXT        NOT NULL,
     reason           TEXT,
     operation        TEXT,
     correlation_id   TEXT,
     metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
     occurred_at      TIMESTAMPTZ NOT NULL,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT platform_audit_actor_scope_check  CHECK (actor_scope IN ('platform', 'system', 'tenant')),
     CONSTRAINT platform_audit_actor_tenant_check CHECK ((actor_scope = 'tenant') = (actor_tenant_id IS NOT NULL)),
     CONSTRAINT platform_audit_tenant_ids_check   CHECK (
       (actor_tenant_id  IS NULL OR actor_tenant_id  ~ '^[0-9a-f]{24}$') AND
       (target_tenant_id IS NULL OR target_tenant_id ~ '^[0-9a-f]{24}$')),
     CONSTRAINT platform_audit_result_check       CHECK (result IN ('allowed', 'denied', 'success', 'failure'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_audit_event_id ON platform_audit_logs (event_id)`,
];

const DEDUPE_EVENT_ROWS = `
WITH duplicates AS (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY tenant_id, event_id
        ORDER BY occurred_at ASC, created_at ASC, id ASC
      ) AS row_num
    FROM audit_logs
    WHERE event_id IS NOT NULL
  ) ranked
  WHERE row_num > 1
)
DELETE FROM audit_logs
WHERE id IN (SELECT id FROM duplicates);
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_audit_tenant_occurred
     ON audit_logs (tenant_id, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_resource
     ON audit_logs (tenant_id, resource_type, resource_id, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_actor
     ON audit_logs (tenant_id, actor_id, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_action
     ON audit_logs (tenant_id, action, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_service
     ON audit_logs (tenant_id, service, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_event_type
     ON audit_logs (event_type, occurred_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_correlation
     ON audit_logs (correlation_id)`,

  // GIN index on JSONB columns for deep querying (e.g. after_state->>'memberId')
  `CREATE INDEX IF NOT EXISTS idx_audit_after_gin
     ON audit_logs USING GIN (after_state)`,

  `CREATE INDEX IF NOT EXISTS idx_audit_metadata_dedupe_key
     ON audit_logs ((metadata->>'dedupeKey'))
     WHERE metadata->>'dedupeKey' IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin
     ON audit_logs USING GIN (metadata)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_tenant_event_id
     ON audit_logs (tenant_id, event_id)
     WHERE event_id IS NOT NULL`,
];

export async function runMigrations() {
  await connectDB();
  console.log("Running audit migration...");

  await query(CREATE_TABLE);
  console.log("✓ Table audit_logs created");

  for (const stmt of ACTOR_CONTEXT_COLUMNS) {
    await query(stmt);
  }
  console.log("✓ Actor / target context columns present");

  for (const stmt of PLATFORM_AUDIT_TABLE) {
    await query(stmt);
  }
  console.log("✓ Table platform_audit_logs present");

  const dedupeResult = await query(DEDUPE_EVENT_ROWS);
  if (dedupeResult.rowCount) {
    console.log(`✓ Removed ${dedupeResult.rowCount} duplicate audit event rows`);
  }

  for (const idx of INDEXES) {
    await query(idx);
  }
  console.log("✓ Indexes created");
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  runMigrations()
    .then(async () => {
      await closeDB();
      console.log("Migration complete");
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Migration failed:", err.message);
      await closeDB().catch(() => {});
      process.exit(1);
    });
}
