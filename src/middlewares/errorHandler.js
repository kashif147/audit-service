import logger from "../config/logger.js";
import { AppError } from "../errors/AppError.js";

/**
 * Centralized error handler (aligned with account-service pattern).
 * Use next(err) with AppError or throw from async routes.
 */
export default function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof AppError) {
    logger.warn(
      { path: req.path, code: err.code, status: err.status, message: err.message },
      "AppError"
    );
    return res.appError(err);
  }

  // PostgreSQL errors (node-pg)
  if (err.code && typeof err.code === "string" && err.code.length === 5) {
    if (err.code === "23505") {
      return res.appError(AppError.conflict("Duplicate entry", { detail: err.detail }));
    }
    if (err.code === "23503") {
      return res.appError(
        AppError.badRequest("Referential integrity violation", { detail: err.detail })
      );
    }
    if (err.code === "22P02") {
      return res.appError(AppError.badRequest("Invalid input syntax", { detail: err.detail }));
    }
    logger.error(
      { path: req.path, pgCode: err.code, message: err.message },
      "PostgreSQL error"
    );
    return res.appError(
      AppError.internalServerError("Database error", { code: err.code })
    );
  }

  if (err.name === "JsonWebTokenError") {
    return res.appError(AppError.badRequest("Invalid token", { tokenError: true }));
  }

  if (err.name === "TokenExpiredError") {
    return res.appError(AppError.badRequest("Token expired", { tokenExpired: true }));
  }

  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  const message = err.message || "Internal server error";

  logger.error(
    { error: err.message, stack: err.stack, path: req.path },
    "Unhandled error"
  );

  if (status !== 500) {
    return res.status(status).json({
      status: "fail",
      message,
      code: err.code || "ERROR",
      details: {},
      timestamp: new Date().toISOString(),
    });
  }

  res.serverError("Internal server error", {
    ...(process.env.NODE_ENV === "development" && { originalMessage: message }),
  });
}
