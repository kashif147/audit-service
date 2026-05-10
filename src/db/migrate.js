/**
 * Run once to create the audit_logs table and its indexes.
 * Usage: npm run db:migrate
 */
import "dotenv-flow/config";
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

  `CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin
     ON audit_logs USING GIN (metadata)`,
];

async function migrate() {
  await connectDB();
  console.log("Running migration...");

  await query(CREATE_TABLE);
  console.log("✓ Table audit_logs created");

  for (const idx of INDEXES) {
    await query(idx);
  }
  console.log("✓ Indexes created");

  await closeDB();
  console.log("Migration complete");
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
