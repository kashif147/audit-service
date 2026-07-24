# Deployment

`.github/workflows/*.yml` deploys on push to `gateway` via rsync + SSH to a VM, then `docker
compose build/up` from `docker-compose.yml`.

`RUN_AUDIT_MIGRATIONS=true` is set in that compose file, so migrations run automatically on
container start in staging — `npm run db:migrate` is normally only needed manually for local dev,
not as a deploy step.
