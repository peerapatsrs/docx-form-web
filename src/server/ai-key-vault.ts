/**
 * Per-user AI API key vault (optional server sync).
 * Keys are AES-256-GCM encrypted at rest.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getAuthPool } from "./auth-db";
import { ensureAdminSchema } from "./admin-store";

export type UserAiKeyRow = {
  id: string;
  provider: string;
  label: string;
  model: string;
  apiKey: string;
};

/** Client vault ids look like `k-<time>-<rand>`; reject empty / path-like junk. */
export function isValidUserAiKeyId(id: unknown): boolean {
  const s = String(id || "").trim();
  if (!s || s.length > 128) return false;
  return /^[a-zA-Z0-9._-]+$/.test(s);
}

function vaultSecret(): string {
  return (
    String(process.env.AI_VAULT_SECRET || "").trim() ||
    String(process.env.BETTER_AUTH_SECRET || "").trim() ||
    String(process.env.AUTH_SECRET || "").trim() ||
    "docx-form-ai-vault-dev-only"
  );
}

function deriveKey(): Buffer {
  return createHash("sha256").update(vaultSecret(), "utf8").digest();
}

/** Encrypt plaintext → `iv.base64:tag.base64:cipher.base64` */
export function encryptAiKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const enc = Buffer.concat([
    cipher.update(String(plain || ""), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptAiKey(payload: string): string {
  const parts = String(payload || "").split(":");
  if (parts.length !== 3) throw new Error("invalid encrypted key payload");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function ensureUserAiKeysTable(): Promise<void> {
  await ensureAdminSchema();
  const pool = getAuthPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_ai_keys (
      "userId" text NOT NULL,
      id text NOT NULL,
      provider text NOT NULL,
      label text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '',
      "apiKeyEnc" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT NOW(),
      "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("userId", id)
    )
  `);
}

export async function listUserAiKeys(userId: string): Promise<UserAiKeyRow[]> {
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    id: string;
    provider: string;
    label: string;
    model: string;
    apiKeyEnc: string;
  }>(
    `SELECT id, provider, label, model, "apiKeyEnc" AS "apiKeyEnc"
     FROM user_ai_keys
     WHERE "userId" = $1
     ORDER BY "updatedAt" DESC`,
    [userId],
  );
  const out: UserAiKeyRow[] = [];
  for (const r of rows) {
    try {
      out.push({
        id: r.id,
        provider: r.provider,
        label: r.label || "",
        model: r.model || "",
        apiKey: decryptAiKey(r.apiKeyEnc),
      });
    } catch {
      // Skip undecryptable rows (secret rotated) — client can re-save.
    }
  }
  return out;
}

export async function upsertUserAiKey(
  userId: string,
  entry: UserAiKeyRow,
): Promise<UserAiKeyRow> {
  await ensureUserAiKeysTable();
  const id = String(entry.id || "").trim();
  const apiKey = String(entry.apiKey || "").trim();
  if (!id || !apiKey) throw new Error("ต้องมี id และ apiKey");
  const provider = String(entry.provider || "google").trim() || "google";
  const label = String(entry.label || provider).trim() || provider;
  const model = String(entry.model || "").trim();
  const enc = encryptAiKey(apiKey);
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO user_ai_keys ("userId", id, provider, label, model, "apiKeyEnc", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT ("userId", id) DO UPDATE SET
       provider = EXCLUDED.provider,
       label = EXCLUDED.label,
       model = EXCLUDED.model,
       "apiKeyEnc" = EXCLUDED."apiKeyEnc",
       "updatedAt" = NOW()`,
    [userId, id, provider, label, model, enc],
  );
  return { id, provider, label, model, apiKey };
}

export async function upsertUserAiKeys(
  userId: string,
  entries: UserAiKeyRow[],
): Promise<UserAiKeyRow[]> {
  const out: UserAiKeyRow[] = [];
  for (const e of entries) {
    out.push(await upsertUserAiKey(userId, e));
  }
  return out;
}

export async function deleteUserAiKey(
  userId: string,
  id: string,
): Promise<boolean> {
  const keyId = String(id || "").trim();
  if (!isValidUserAiKeyId(keyId)) return false;
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const res = await pool.query(
    `DELETE FROM user_ai_keys WHERE id = $1 AND "userId" = $2`,
    [keyId, userId],
  );
  return (res.rowCount || 0) > 0;
}

/** Resolve one vault entry (with decrypted key) for server-side proxy use. */
export async function getUserAiKey(
  userId: string,
  id: string,
): Promise<UserAiKeyRow | null> {
  const want = String(id || "").trim();
  if (!want) return null;
  const entries = await listUserAiKeys(userId);
  return entries.find((e) => e.id === want) || null;
}
