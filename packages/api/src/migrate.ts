import { loadDatabaseEnv } from "./config/env";
import { applySchema } from "./db/init";
import { createPool, resolveSsl } from "./db/pool";

async function main(): Promise<void> {
  const env = loadDatabaseEnv();
  const pool = createPool(env.DATABASE_URL, {
    ssl: resolveSsl(env.DATABASE_SSL, env.DATABASE_SSL_CA),
  });
  try {
    await applySchema(pool);
    console.log("ai-guard schema applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // Redact any connection string (with password) that a pg error may embed.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(msg.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]"));
  process.exit(1);
});
