import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * SQLite path for Better Auth.
 * - Local: ./data/auth.db
 * - Docker/Render disk: set AUTH_DB_PATH=/data/auth.db (persistent volume)
 */
export function getAuthDbPath(): string {
  const fromEnv = String(process.env.AUTH_DB_PATH || "").trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), "data", "auth.db");
}

let cached: Database.Database | null = null;

export function getAuthSqlite(): Database.Database {
  if (cached) return cached;
  const dbPath = getAuthDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  cached = new Database(dbPath);
  cached.pragma("journal_mode = WAL");
  cached.pragma("foreign_keys = ON");
  return cached;
}
