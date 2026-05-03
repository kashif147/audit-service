"use strict";

const path = require("path");
const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const { v4: uuidv4 } = require("uuid");

function normalizeServiceName(name) {
  const raw = String(
    name || process.env.SERVICE_NAME || "unknown-service"
  ).trim();
  return raw.replace(/[^\w.-]/g, "_") || "unknown-service";
}

function headerValue(req, key) {
  if (!req?.headers) return null;
  const v = req.headers[key];
  if (v === undefined || v === null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  const t = String(s).trim();
  return t || null;
}

function requestContext(req) {
  if (!req || typeof req !== "object") return {};
  return {
    correlationId: req.correlationId || headerValue(req, "x-correlation-id"),
    userId:
      headerValue(req, "x-user-id") ||
      (req.user && (req.user.id || req.user._id)) ||
      null,
    tenantId: req.tenantId || headerValue(req, "x-tenant-id") || null,
  };
}

function finalizeRecord(level, message, serviceName, meta = {}) {
  const timestamp = new Date().toISOString();
  const {
    correlationId = null,
    userId = null,
    tenantId = null,
    profileId = null,
    applicationId = null,
    membershipId = null,
    eventType = null,
    ...rest
  } = meta || {};

  const row = {
    timestamp,
    level,
    service: serviceName,
    message: message == null ? "" : String(message),
    correlationId: correlationId ?? null,
    userId: userId ?? null,
    tenantId: tenantId ?? null,
    profileId: profileId ?? null,
    applicationId: applicationId ?? null,
    membershipId: membershipId ?? null,
    eventType: eventType ?? null,
  };

  for (const [k, v] of Object.entries(rest)) {
    if (
      v !== undefined &&
      !Object.prototype.hasOwnProperty.call(row, k)
    ) {
      row[k] = v;
    }
  }
  return row;
}

function jsonPrintf(info) {
  return typeof info.message === "string"
    ? info.message
    : JSON.stringify(info.message);
}

function createLogger(serviceNameArg) {
  const serviceName = normalizeServiceName(serviceNameArg);
  const baseDir = path.join(process.cwd(), "logs", serviceName);

  const appRotate = new DailyRotateFile({
    dirname: baseDir,
    filename: "app-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    zippedArchive: false,
    maxFiles: "14d",
    format: winston.format.printf(jsonPrintf),
  });

  const errorRotate = new DailyRotateFile({
    dirname: baseDir,
    filename: "error-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    zippedArchive: false,
    maxFiles: "30d",
    format: winston.format.printf(jsonPrintf),
    level: "error",
  });

  const consoleTransport = new winston.transports.Console({
    format: winston.format.printf(jsonPrintf),
  });

  const appLogger = winston.createLogger({
    transports: [appRotate, consoleTransport],
  });

  const errorLogger = winston.createLogger({
    level: "error",
    transports: [errorRotate, consoleTransport],
  });

  function emitBusiness(message, meta, req) {
    const ctx = req ? requestContext(req) : {};
    const merged = { ...ctx, ...meta };
    const row = finalizeRecord("business", message, serviceName, merged);
    appLogger.info(JSON.stringify(row));
  }

  function emitError(message, meta, req) {
    const ctx = req ? requestContext(req) : {};
    const merged = { ...ctx, ...meta };
    const row = finalizeRecord("error", message, serviceName, merged);
    errorLogger.error(JSON.stringify(row));
  }

  function enrichRabbit(meta) {
    return finalizeRecord("business", meta.message || "rabbitmq", serviceName, {
      correlationId: meta.correlationId ?? null,
      eventType: meta.eventType ?? null,
      profileId: meta.profileId ?? null,
      applicationId: meta.applicationId ?? null,
      membershipId: meta.membershipId ?? null,
      ...meta,
    });
  }

  return {
    serviceName,
    business(message, meta = {}, req = null) {
      emitBusiness(message, meta, req);
    },
    error(message, meta = {}, req = null) {
      emitError(message, meta, req);
    },
    rabbitPublished(meta = {}) {
      const row = enrichRabbit({
        ...meta,
        message: meta.message || "RabbitMQ event published",
        rabbitOperation: "published",
      });
      appLogger.info(JSON.stringify(row));
    },
    rabbitConsumed(meta = {}) {
      const row = enrichRabbit({
        ...meta,
        message: meta.message || "RabbitMQ event consumed",
        rabbitOperation: "consumed",
      });
      appLogger.info(JSON.stringify(row));
    },
    rabbitFailed(meta = {}) {
      const row = finalizeRecord(
        "error",
        meta.message || "RabbitMQ handler failed",
        serviceName,
        {
          correlationId: meta.correlationId ?? null,
          eventType: meta.eventType ?? null,
          profileId: meta.profileId ?? null,
          applicationId: meta.applicationId ?? null,
          membershipId: meta.membershipId ?? null,
          ...meta,
          rabbitOperation: "handler_failed",
        }
      );
      errorLogger.error(JSON.stringify(row));
    },
    rabbitDlq(meta = {}) {
      const row = finalizeRecord(
        "error",
        meta.message || "RabbitMQ message moved to DLQ",
        serviceName,
        {
          correlationId: meta.correlationId ?? null,
          eventType: meta.eventType ?? null,
          profileId: meta.profileId ?? null,
          applicationId: meta.applicationId ?? null,
          membershipId: meta.membershipId ?? null,
          ...meta,
          rabbitOperation: "dlq",
        }
      );
      errorLogger.error(JSON.stringify(row));
    },
  };
}

function correlationIdMiddleware(req, res, next) {
  const incoming = req.headers["x-correlation-id"];
  const trimmed =
    incoming != null ? String(Array.isArray(incoming) ? incoming[0] : incoming).trim() : "";
  const id = trimmed || uuidv4();
  req.correlationId = id;
  res.setHeader("x-correlation-id", id);
  next();
}

function logErrorMiddleware(bizLogger) {
  return function logError(err, req, res, next) {
    try {
      const ctx = requestContext(req);
      bizLogger.error(err.message || "Unhandled error", {
        ...ctx,
        correlationId:
          ctx.correlationId || headerValue(req, "x-correlation-id"),
        eventType: "express.unhandled_error",
        stack: err.stack,
        errorName: err.name,
        path: req.originalUrl,
        route:
          req.route?.path ||
          (req.baseUrl != null && req.path != null
            ? `${req.baseUrl}${req.path}`
            : null),
        method: req.method,
      });
    } catch (_) {
      /* ignore secondary failures */
    }
    next(err);
  };
}

function createSystemLogsRouter(bizLogger, options = {}) {
  const express = require("express");
  const router = express.Router();
  const apiKey = options.apiKey || process.env.SYSTEM_LOG_API_KEY || "";

  router.post("/system-logs", express.json({ limit: "256kb" }), (req, res) => {
    if (apiKey) {
      const key =
        req.headers["x-system-log-key"] ||
        req.headers["x-api-key"] ||
        "";
      if (String(key) !== String(apiKey)) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }
    }

    const raw = req.body;
    const body =
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      raw !== null
        ? raw
        : null;
    if (!body) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: "Expected a JSON object body",
      });
    }

    const nonempty = (v) =>
      v != null && String(v).trim() !== "";
    if (
      !nonempty(body.eventType) &&
      !nonempty(body.workflowName) &&
      !nonempty(body.executionId) &&
      !nonempty(body.correlationId)
    ) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details:
          "Provide at least one of: eventType, workflowName, executionId, correlationId",
      });
    }

    const wf = nonempty(body.workflowName)
      ? String(body.workflowName).trim()
      : "workflow";
    try {
      bizLogger.business(`n8n workflow: ${wf}`, {
        correlationId: body.correlationId || req.correlationId || null,
        eventType: nonempty(body.eventType)
          ? String(body.eventType).trim()
          : "n8n.workflow.callback",
        profileId: body.profileId ?? null,
        membershipId: body.membershipId ?? null,
        applicationId: body.applicationId ?? null,
        source: body.source || "n8n",
        workflowName: body.workflowName ?? null,
        executionId: body.executionId ?? null,
        status: body.status ?? null,
        tenantId: body.tenantId ?? null,
        userId: body.userId ?? null,
      });
    } catch (_err) {
      return res.status(500).json({
        success: false,
        error: "Logging failed",
      });
    }

    return res.status(204).send();
  });

  return router;
}

function createRabbitStructuredLogHandlers(bizLogger) {
  return {
    onPublish(meta) {
      bizLogger.rabbitPublished(meta);
    },
    onConsume(meta) {
      bizLogger.rabbitConsumed(meta);
    },
    onFail(meta) {
      bizLogger.rabbitFailed(meta);
    },
    onDlq(meta) {
      bizLogger.rabbitDlq(meta);
    },
  };
}

function extractPayloadBusinessIds(payload) {
  const merged = {};
  if (payload && typeof payload === "object") {
    const nested = payload.data;
    if (
      nested != null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      Object.assign(merged, nested);
    }
    Object.assign(merged, payload);
  }
  const profileId =
    merged.profileId ??
    merged.profile?.id ??
    merged.profile?._id ??
    null;
  const applicationId =
    merged.applicationId ??
    merged.application?.id ??
    merged.application?._id ??
    null;
  const membershipId =
    merged.membershipId ??
    merged.memberId ??
    merged.membership?.id ??
    merged.membershipNumber ??
    null;
  return {
    profileId: profileId != null ? String(profileId) : null,
    applicationId: applicationId != null ? String(applicationId) : null,
    membershipId: membershipId != null ? String(membershipId) : null,
  };
}

module.exports = {
  createLogger,
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
  createRabbitStructuredLogHandlers,
  requestContext,
  extractPayloadBusinessIds,
};
