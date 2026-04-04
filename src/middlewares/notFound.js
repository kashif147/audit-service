import { AppError } from "../errors/AppError.js";

export default function notFound(req, res, next) {
  next(
    AppError.notFound(`Route ${req.method} ${req.originalUrl} not found`, {
      method: req.method,
      url: req.originalUrl,
      path: req.path,
    })
  );
}
