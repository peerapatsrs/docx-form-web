import { Pool } from "pg";

/**
 * PostgreSQL pool for Better Auth.
 * Set DATABASE_URL (e.g. postgres://user:pass@host:5432/dbname).
 * Cloud hosts (Render, etc.): add ?sslmode=require when required.
 */
export function getDatabaseUrl(): string {
  const fromEnv = String(process.env.DATABASE_URL || "").trim();
  if (fromEnv) return fromEnv;
  // Local default matching docker-compose.yml
  return "postgres://docx:docx@127.0.0.1:5432/docx_form";
}

let cached: Pool | null = null;

export function getAuthPool(): Pool {
  if (cached) return cached;
  cached = new Pool({
    connectionString: getDatabaseUrl(),
    max: 10,
  });
  return cached;
}
