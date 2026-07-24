# Auth and cross-service calls

## Auth

`src/middlewares/auth.js` (`ensureAuthenticated`) supports three identity sources, tried in
priority order: gateway-verified headers (`x-jwt-verified: true` + `x-auth-source`), a raw Bearer
JWT (local/dev), and Azure `x-ms-client-principal` (legacy/SWA). It only establishes identity
(`req.ctx`, `req.user`) — authorization is delegated per-route to
`defaultPolicyMiddleware.requirePermission(resource, action)` from `@membership/policy-middleware`
(`src/middlewares/policy.middleware.js`, configured via `POLICY_SERVICE_URL`).

The `/internal/*` routes (see the ingestion topic) bypass all of this — they're service-to-service
and secret-gated instead, not JWT/gateway-authenticated.

## Cross-service calls

This service calls out to other services over HTTP purely for *display enrichment* in the read
path, never to mutate anything: `USER_SERVICE_URL`, `PROFILE_SERVICE_URL`,
`SUBSCRIPTION_SERVICE_URL`, `ACCOUNT_SERVICE_URL` (see `.env.staging.example` and
`src/clients/*.js`). All outbound calls go through `buildServiceHeaders()`
(`src/clients/requestHeaders.js`), which forwards the inbound gateway/auth headers rather than
minting new credentials.

Do this over HTTP only, never by reaching into another service's database — this is additionally
hook-enforced when working from the full projectShell checkout
(`.claude/hooks/enforce-hard-rules.mjs` blocks `mongoose.createConnection(...)` and the literal
`x-api-key` header under `backend/`), but the rule itself holds regardless of checkout: forward
headers via `buildServiceHeaders()`, don't add a new API key env var for a downstream service
call. See the `cross-service-auth` and `no-cross-db-mongo` skills for the full convention.
