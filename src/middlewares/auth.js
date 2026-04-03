import jwt from "jsonwebtoken";
import * as gatewaySecurity from "@membership/policy-middleware/security";

const { validateGatewayRequest } = gatewaySecurity;

function decodeBase64Json(value) {
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractFromClientPrincipal(clientPrincipal) {
  if (!clientPrincipal || typeof clientPrincipal !== "object") return null;

  const claims = Array.isArray(clientPrincipal.claims)
    ? clientPrincipal.claims
    : [];

  const claimMap = new Map();
  for (const c of claims) {
    if (c && c.typ) claimMap.set(c.typ, c.val);
  }

  const roleTypes = new Set(
    [
      clientPrincipal.role_typ,
      "roles",
      "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
    ].filter(Boolean)
  );

  const roles = claims
    .filter((c) => c && roleTypes.has(c.typ))
    .map((c) => c.val)
    .filter(Boolean);

  const tenantId =
    claimMap.get("http://schemas.microsoft.com/identity/claims/tenantid") ||
    claimMap.get("tid") ||
    claimMap.get("tenantId") ||
    null;

  const userId =
    claimMap.get(
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"
    ) ||
    claimMap.get("oid") ||
    claimMap.get("sub") ||
    claimMap.get(
      "http://schemas.microsoft.com/identity/claims/objectidentifier"
    ) ||
    null;

  return {
    tenantId,
    userId,
    roles,
    permissions: [],
    raw: clientPrincipal,
  };
}

/**
 * Authentication only (identity + req.ctx). Authorization is policy-middleware on routes.
 */
export async function ensureAuthenticated(req, res, next) {
  const jwtVerified = req.headers["x-jwt-verified"];
  const authSource = req.headers["x-auth-source"];
  const gatewayVerified =
    jwtVerified === "true" &&
    (authSource === "gateway" || authSource === "azuread");

  if (gatewayVerified) {
    const validation = validateGatewayRequest(req);
    if (!validation.valid) {
      console.warn("Gateway header validation failed:", validation.reason);
      return res.fail("Invalid gateway request", 401);
    }

    const userId = req.headers["x-user-id"];
    const tenantId = req.headers["x-tenant-id"];
    const userEmail = req.headers["x-user-email"];
    const userType = req.headers["x-user-type"];
    const userRolesStr = req.headers["x-user-roles"] || "[]";
    const userPermissionsStr = req.headers["x-user-permissions"] || "[]";

    if (!userId || !tenantId) {
      return res.fail("Missing required authentication headers", 400);
    }

    let normalizedRoles = [];
    let permissions = [];

    try {
      const rolesArray = JSON.parse(userRolesStr);
      normalizedRoles = Array.isArray(rolesArray)
        ? rolesArray
            .map((role) => (typeof role === "string" ? role : role?.code))
            .filter(Boolean)
        : [];
    } catch (e) {
      console.warn("Failed to parse x-user-roles header:", e.message);
    }

    try {
      permissions = JSON.parse(userPermissionsStr);
      if (!Array.isArray(permissions)) {
        permissions = [];
      }
    } catch (e) {
      console.warn("Failed to parse x-user-permissions header:", e.message);
    }

    req.ctx = {
      tenantId,
      userId,
      roles: normalizedRoles,
      permissions,
    };

    const idempotencyKey = req.header("x-idempotency-key");
    if (idempotencyKey) {
      req.ctx.idempotencyKey = idempotencyKey;
    }

    req.user = {
      sub: userId,
      id: userId,
      tenantId,
      email: userEmail,
      userType,
      roles: normalizedRoles,
      permissions,
    };

    req.userId = userId;
    req.tenantId = tenantId;
    req.roles = normalizedRoles;
    req.permissions = permissions;

    return next();
  }

  const header = req.headers.authorization || req.headers.Authorization;
  const bearerMatch =
    typeof header === "string" && header.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    const token = bearerMatch[1].trim();
    try {
      const secret =
        process.env.JWT_SECRET ||
        process.env.ACCESS_TOKEN_SECRET ||
        process.env.ACCESS_TOEKN_SECRET;
      const decoded = jwt.verify(token, secret);

      const tokenTenantId =
        decoded.tid ||
        decoded.tenantId ||
        decoded.tenantID ||
        decoded.tenant_id ||
        null;

      if (!tokenTenantId) {
        return res.fail("Invalid token: missing tenantId", 400);
      }

      const normalizedRoles = Array.isArray(decoded.roles)
        ? decoded.roles
            .map((role) => (typeof role === "string" ? role : role?.code))
            .filter(Boolean)
        : [];

      req.ctx = {
        tenantId: tokenTenantId,
        userId: decoded.sub || decoded.oid || decoded.id,
        roles: normalizedRoles,
        permissions: decoded.permissions || [],
      };

      const idempotencyKey = req.header("x-idempotency-key");
      if (idempotencyKey) {
        req.ctx.idempotencyKey = idempotencyKey;
      }
      req.user = decoded;
      req.userId = decoded.sub || decoded.oid || decoded.id;
      req.tenantId = tokenTenantId;
      req.roles = normalizedRoles;
      req.permissions = decoded.permissions || [];
      return next();
    } catch (e) {
      console.error("JWT failed:", e.message);
      return res.fail("Invalid token", 400);
    }
  }

  const clientPrincipalB64 =
    req.headers["x-ms-client-principal"] ||
    req.headers["X-MS-CLIENT-PRINCIPAL"];
  const aadAccessToken =
    req.headers["x-ms-token-aad-access-token"] ||
    req.headers["X-MS-TOKEN-AAD-ACCESS-TOKEN"];

  if (clientPrincipalB64) {
    const principal = decodeBase64Json(clientPrincipalB64);
    const extracted = extractFromClientPrincipal(principal);
    if (extracted && extracted.tenantId) {
      req.ctx = {
        tenantId: extracted.tenantId,
        userId: extracted.userId,
        roles: extracted.roles,
        permissions: extracted.permissions,
      };

      const idempotencyKey = req.header("x-idempotency-key");
      if (idempotencyKey) {
        req.ctx.idempotencyKey = idempotencyKey;
      }
      req.user = principal;
      req.userId = extracted.userId;
      req.tenantId = extracted.tenantId;
      req.roles = extracted.roles;
      req.permissions = extracted.permissions;

      if (!header && aadAccessToken) {
        req.headers.authorization = `Bearer ${aadAccessToken}`;
      }
      return next();
    }
  }

  if (aadAccessToken) {
    req.headers.authorization = `Bearer ${aadAccessToken}`;
    return next();
  }

  return res.fail("Authorization header required", 401);
}

export function requireTenant(req, res, next) {
  if (!req.ctx || !req.ctx.tenantId) {
    return res.fail("Tenant context required", 400);
  }
  return next();
}

export const authenticate = ensureAuthenticated;
