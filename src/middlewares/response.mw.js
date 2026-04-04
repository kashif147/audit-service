import { AppError } from "../errors/AppError.js";

export default function responseMiddleware(req, res, next) {
  res.success = (data, message = "Success") =>
    res.status(200).json({
      status: "success",
      message,
      data,
      timestamp: new Date().toISOString(),
    });

  res.created = (data, message = "Created successfully") =>
    res.status(201).json({
      status: "success",
      message,
      data,
      timestamp: new Date().toISOString(),
    });

  res.accepted = (data, message = "Accepted") =>
    res.status(202).json({
      status: "success",
      message,
      data,
      timestamp: new Date().toISOString(),
    });

  res.fail = (message = "Bad request", status = 400, details = {}) =>
    res.status(status).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.notFound = (message = "Not found", details = {}) =>
    res.status(404).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.unauthorized = (message = "Unauthorized", details = {}) =>
    res.status(401).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.forbidden = (message = "Forbidden", details = {}) =>
    res.status(403).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.conflict = (message = "Conflict", details = {}) =>
    res.status(409).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.validationError = (message = "Validation failed", details = {}) =>
    res.status(422).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.serverError = (message = "Internal server error", details = {}) =>
    res.status(500).json({
      status: "fail",
      message,
      details,
      timestamp: new Date().toISOString(),
    });

  res.appError = (error) => {
    if (error instanceof AppError) {
      return res.status(error.status).json({
        status: "fail",
        message: error.message,
        code: error.code,
        details: error,
        timestamp: new Date().toISOString(),
      });
    }
    return res.serverError(error?.message || "Internal server error", {
      originalError: String(error),
    });
  };

  next();
}
