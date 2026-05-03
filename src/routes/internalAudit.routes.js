import express from "express";
import { postInternalAuditLog } from "../controllers/internalAudit.controller.js";

const router = express.Router();

router.post("/audit-logs", postInternalAuditLog);

export default router;
