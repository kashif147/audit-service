// import pg from "pg";
// import logger from "./logger.js";

// const { Pool } = pg;

// let pool;

// export function getPool() {
//   if (!pool) throw new Error("DB pool not initialised — call connectDB() first");
//   return pool;
// }

// export async function connectDB() {
//   const connectionString = process.env.POSTGRES_URI || process.env.DATABASE_URL;

//   if (!connectionString) {
//     throw new Error("POSTGRES_URI is not set");
//   }

//   pool = new Pool({
//     connectionString,
//     max: parseInt(process.env.PG_MAX_POOL || "10"),
//     idleTimeoutMillis: 30_000,
//     connectionTimeoutMillis: 5_000,
//     ssl:
//       process.env.NODE_ENV === "production"
//         ? { rejectUnauthorized: false }
//         : false,
//   });

//   // Verify connectivity
//   const client = await pool.connect();
//   client.release();

//   logger.info("PostgreSQL connected");

//   pool.on("error", (err) => {
//     logger.error({ err }, "PostgreSQL pool error");
//   });
// }

// export async function query(text, params) {
//   const start = Date.now();
//   const res = await getPool().query(text, params);
//   logger.debug({ query: text, duration: Date.now() - start, rows: res.rowCount }, "DB query");
//   return res;
// }

// export async function closeDB() {
//   if (pool) await pool.end();
// }
import pg from "pg";
import logger from "./logger.js";

const { Pool, Client } = pg;

let pool;

export function getPool() {
  if (!pool)
    throw new Error("DB pool not initialised — call connectDB() first");
  return pool;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDatabaseExists(connectionString) {
  const dbName = connectionString.split("/").pop();

  const adminConnectionString = connectionString.replace(
    /\/[^/]+$/,
    "/postgres",
  );

  const client = new Client({
    connectionString: adminConnectionString,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    await client.connect();

    const res = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );

    if (res.rowCount === 0) {
      logger.warn(`Database "${dbName}" not found. Creating...`);
      await client.query(`CREATE DATABASE "${dbName}"`);
      logger.info(`Database "${dbName}" created`);
    } else {
      logger.info(`Database "${dbName}" already exists`);
    }
  } catch (err) {
    logger.error({ err }, "Error ensuring database exists");
    throw err;
  } finally {
    await client.end();
  }
}

export async function connectDB() {
  const connectionString = process.env.POSTGRES_URI || process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("POSTGRES_URI is not set");
  }

  const maxRetries = parseInt(process.env.DB_RETRIES || "10");
  const delay = parseInt(process.env.DB_RETRY_DELAY || "5000");

  // Step 1: Ensure DB exists (safe to call every time)
  await ensureDatabaseExists(connectionString);

  // Step 2: Retry connection
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
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

      const client = await pool.connect();
      client.release();

      logger.info(`PostgreSQL connected (attempt ${attempt})`);

      pool.on("error", (err) => {
        logger.error({ err }, "PostgreSQL pool error");
      });

      return;
    } catch (err) {
      logger.error(
        { err, attempt },
        `DB connection failed (attempt ${attempt})`,
      );

      if (attempt === maxRetries) {
        throw err;
      }

      await sleep(delay);
    }
  }
}

export async function query(text, params) {
  const start = Date.now();
  const res = await getPool().query(text, params);
  logger.debug(
    { query: text, duration: Date.now() - start, rows: res.rowCount },
    "DB query",
  );
  return res;
}

export async function closeDB() {
  if (pool) await pool.end();
}
