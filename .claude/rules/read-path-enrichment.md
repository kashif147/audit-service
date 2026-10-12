# Read path (row → API)

`src/controllers/auditLog.controller.js` exposes list/get/summary endpoints under
`/api/audit-logs*`. Every handler reads the tenant from the trusted context only
(`req.ctx.tenantId` / `req.tenantId`, set by `ensureAuthenticated` + `tenantContextWarn`), never
the raw `x-tenant-id` header or `?tenantId=` — on the Bearer path that header is caller-controlled.
Guarded by `tests/auditLogReads.tenantScope.test.js` and `tests/auditLogGetById.tenantScope.test.js`.

The interesting one is `getMemberAuditHistory` (`GET /api/audit-logs/member/:profileId`): by
default (`diffOnly=true`) it doesn't return raw rows — it runs them through a three-stage
transform pipeline:

1. **`expandAuditRowsToChanges`** (`src/helpers/auditDiff.js`) — flattens `before_state`/
   `after_state` into one row per changed leaf field (dot-path diffing), formats values for
   display, dedupes near-duplicate field changes (e.g. `previousMembershipCategory` vs
   `membershipCategory` collapse to one canonical field), and special-cases single-row rendering
   for `finance` resources (a formatted summary line instead of a field diff).
2. **`enrichAuditActors`** (`src/helpers/auditActorEnrichment.js`) — resolves `actorId`/
   `actorEmail` into a human display name via `user.service.client.js`, with hardcoded labels for
   known system actors (reminder batch, graduation job).
3. **`enrichAuditValues`** (`src/helpers/auditValueEnrichment.js`) — for diffed field *values*
   that look like IDs (Mongo ObjectId / UUID / Stripe `pi_...`), resolves them to human-readable
   labels by calling profile/subscription/account/user services in parallel, keyed off a
   field-name allowlist (`USER_FIELD_KEYS`, `PROFILE_FIELD_KEYS`, etc.). Extend these sets when
   adding a new FK-shaped field that should be enriched — don't add ad hoc resolution logic
   outside the allowlist.
