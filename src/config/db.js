import pg from "pg";
import logger from "./logger.js";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) throw new Error("DB pool not initialised — call connectDB() first");
  return pool;
}

export async function connectDB() {
  const connectionString = process.env.POSTGRES_URI || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("POSTGRES_URI is not set");
  }

  pool = new Pool({
    connectionString,
    max: parseInt(process.env.PG_MAX_POOL || "10"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

  // Verify connectivity
  const client = await pool.connect();
  client.release();

  logger.info("PostgreSQL connected");

  pool.on("error", (err) => {
    logger.error({ err }, "PostgreSQL pool error");
  });
}

export async function query(text, params) {
  const start = Date.now();
  const res = await getPool().query(text, params);
  logger.debug({ query: text, duration: Date.now() - start, rows: res.rowCount }, "DB query");
  return res;
}

export async function closeDB() {
  if (pool) await pool.end();
}
