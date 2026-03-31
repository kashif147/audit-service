import logger from "../config/logger.js";

export default function errorHandler(err, req, res, next) {
  logger.error({ error: err.message, stack: err.stack, path: req.path }, "Unhandled error");
  res.status(500).json({
    status: "fail",
    message: "Internal server error",
    timestamp: new Date().toISOString(),
  });
}
