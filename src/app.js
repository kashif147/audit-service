import express from "express";
import helmet from "helmet";
import compression from "compression";
import pinoHttp from "pino-http";
import logger from "./config/logger.js";
import bizLogger from "./config/bizLogger.js";
import {
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
} from "@projectShell/logging-lib";
import responseMiddleware from "./middlewares/response.mw.js";
import errorHandler from "./middlewares/errorHandler.js";
import notFound from "./middlewares/notFound.js";
import { ensureAuthenticated } from "./middlewares/auth.js";
import routes from "./routes/index.js";
import internalAuditRoutes from "./routes/internalAudit.routes.js";
import {
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
} from "./rabbitMQ/index.js";

const app = express();

// ── Security & basics ─────────────────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "512kb" }));
app.use(correlationIdMiddleware);
app.use("/api", createSystemLogsRouter(bizLogger));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));
app.use(responseMiddleware);

// ── Internal (service key) — no JWT ──────────────────────────────────────────
app.use("/internal", internalAuditRoutes);

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.status(200).json({ status: "UP" }));
app.get("/ready",  (req, res) => res.success({ ok: true }));

// ── API (auth identity → policy per route) ───────────────────────────────────
app.use("/api", ensureAuthenticated, routes);

app.use(notFound);
app.use(logErrorMiddleware(bizLogger));
app.use(errorHandler);

// ── RabbitMQ ──────────────────────────────────────────────────────────────────
async function initRabbitMQ() {
  if (!process.env.RABBIT_URL) {
    logger.warn("RABBIT_URL not set — audit consumers will not start");
    return;
  }
  try {
    await initEventSystem();
    await setupConsumers();
  } catch (err) {
    logger.error({ err }, "RabbitMQ init failed — audit consumers offline");
  }
}

initRabbitMQ();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  await shutdownEventSystem();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

export default app;
