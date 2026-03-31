import "dotenv-flow/config";
import app from "../src/app.js";
import { connectDB } from "../src/config/db.js";
import logger from "../src/config/logger.js";

const PORT = process.env.PORT || 4006;
// deployment test
async function start() {
  await connectDB();

  app.listen(PORT, () => {
    logger.info(
      { port: PORT, env: process.env.NODE_ENV },
      "Audit service started",
    );
  });
}

start().catch((err) => {
  logger.error({ error: err.message }, "Failed to start audit service");
  process.exit(1);
});
