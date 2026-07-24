# CLAUDE.md

`audit-service` is a read-mostly audit trail for the projectShell membership platform. It has no
domain logic of its own — it listens to RabbitMQ events published by other services (account,
profile, subscription, user, communication, events, reporting-adjacent finance flows, etc.),
writes them as immutable rows to a single Postgres table (`audit_logs`), and exposes read APIs so
the frontend can render "what happened" timelines for a member, a resource, or the whole tenant.

The two things most worth knowing up front: there is no ORM (one model file owns hand-written
SQL), and this service shares its Postgres *container* with reporting-service while still owning
its own database on it — see the data-model and dev-commands topics respectively.

**No Save-View `Template` model exists here**, despite the root `TEMPLATE_IMPLEMENTATION_PLAYBOOK.md`
and the frontend's `gridTemplateRouting.js` both routing "audit history grids" template calls to
this service — that's the intended design for a feature that was never actually built (no model,
no `/templates` route, no controller), not something to go looking for. If asked to add Save View
for the audit-history grid, this is a net-new build, not a fix to something that's just missing a
wire-up — follow the `template-filters-columns` skill's pattern from an already-implemented service
(e.g. profile-service's `Template` model) as the starting point.

## Commands and dev environment
@.claude/rules/dev-commands.md

## Data model and dedup
@.claude/rules/data-model-and-dedup.md

## Ingestion paths (RabbitMQ + internal HTTP)
@.claude/rules/ingestion.md

## Read path and enrichment pipeline
@.claude/rules/read-path-enrichment.md

## Auth and cross-service calls
@.claude/rules/auth-and-cross-service.md

## Deployment
@.claude/rules/deployment.md
