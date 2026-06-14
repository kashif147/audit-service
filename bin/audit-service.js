import "dotenv-flow/config";
import app from "../src/app.js";
import { connectDB } from "../src/config/db.js";
import { runMigrations } from "../src/db/migrate.js";
import logger from "../src/config/logger.js";

const PORT = process.env.PORT || 4006;

async function start() {
  await connectDB();

  if (process.env.RUN_AUDIT_MIGRATIONS === "true") {
    await runMigrations();
  }

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(
      { port: PORT, env: process.env.NODE_ENV },
      "Audit service started",
    );
  });
}

start().catch((err) => {
  logger.error({ err }, "Failed to start audit service");
  process.exit(1);
});
