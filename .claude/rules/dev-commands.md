# Commands

```bash
npm run dev              # nodemon, watches src/ and bin/
npm start                # plain node start
npm run start:dev        # NODE_ENV=development
npm run start:staging    # NODE_ENV=staging
npm run start:prod       # NODE_ENV=production

npm run db:migrate           # create audit_logs table + indexes (idempotent, IF NOT EXISTS)
npm run db:migrate:staging   # same, NODE_ENV=staging
```

There is no test suite and no lint script configured in `package.json` — don't invent one.

Local Postgres is expected to already be running: `docker-compose.yml` shares
`reporting-postgres` from `reporting-service`'s compose stack on the `gateway_app-net` network —
this service has no Postgres container of its own. Start it with `cd ../reporting-service &&
docker compose up -d reporting-postgres` before running this service against a real DB.

Runs on port `4006`. ESM throughout (`"type": "module"`).
