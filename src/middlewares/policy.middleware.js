/**
 * Centralized RBAC Policy Middleware
 * Uses shared policy middleware package
 */

import { createDefaultPolicyMiddleware } from "@membership/policy-middleware";

const policyServiceUrl =
  process.env.POLICY_SERVICE_URL || "http://localhost:3000";

// Warn if using default localhost URL in non-development environments
if (!process.env.POLICY_SERVICE_URL && process.env.NODE_ENV !== "development") {
  console.warn(
    "WARNING: POLICY_SERVICE_URL not set. Using default localhost URL.",
    "This will cause policy evaluation to fail in staging/production.",
    "Please set POLICY_SERVICE_URL in environment variables."
  );
} else {
  console.log(`Policy service URL configured: ${policyServiceUrl}`);
}

const defaultPolicyMiddleware = createDefaultPolicyMiddleware(policyServiceUrl, {
  timeout: 15000,
  retries: 5,
  cacheTimeout: 300000,
  retryDelay: 2000,
});

export default defaultPolicyMiddleware;
export { defaultPolicyMiddleware };
