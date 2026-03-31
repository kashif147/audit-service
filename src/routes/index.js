import express from "express";
import {
  listAuditLogs,
  getAuditLog,
  getResourceAuditHistory,
  getAuditSummary,
} from "../controllers/auditLog.controller.js";

const router = express.Router();

router.get("/audit-logs",                              listAuditLogs);
router.get("/audit-logs/summary",                      getAuditSummary);
router.get("/audit-logs/resource/:resourceType/:resourceId", getResourceAuditHistory);
router.get("/audit-logs/:id",                          getAuditLog);

export default router;
