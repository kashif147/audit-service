export default function responseMiddleware(req, res, next) {
  res.success = (data, message = "Success") =>
    res.status(200).json({ status: "success", message, data, timestamp: new Date().toISOString() });

  res.fail = (message = "Bad request", status = 400) =>
    res.status(status).json({ status: "fail", message, timestamp: new Date().toISOString() });

  next();
}
