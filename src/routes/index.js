import express from "express";
import {
  listAuditLogs,
  getAuditLog,
  getResourceAuditHistory,
  getMemberAuditHistory,
  getAuditSummary,
} from "../controllers/auditLog.controller.js";
import { defaultPolicyMiddleware } from "../middlewares/policy.middleware.js";

const router = express.Router();

router.get(
  "/audit-logs",
  defaultPolicyMiddleware.requirePermission("audit", "read"),
  listAuditLogs
);
router.get(
  "/audit-logs/summary",
  defaultPolicyMiddleware.requirePermission("audit", "read"),
  getAuditSummary
);
router.get(
  "/audit-logs/member/:profileId",
  defaultPolicyMiddleware.requirePermission("audit", "read"),
  getMemberAuditHistory
);
router.get(
  "/audit-logs/resource/:resourceType/:resourceId",
  defaultPolicyMiddleware.requirePermission("audit", "read"),
  getResourceAuditHistory
);
router.get(
  "/audit-logs/:id",
  defaultPolicyMiddleware.requirePermission("audit", "read"),
  getAuditLog
);

export default router;
