/**
 * Per-user AI API key vault (optional server sync).
 * Keys are AES-256-GCM encrypted at rest.
 * Public APIs never return plaintext secrets — only masked hints + metadata.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getAuthPool } from "./auth-db";
import { ensureAdminSchema } from "./admin-store";
import { maskGeminiKey } from "./ai-config";

export type UserAiKeyRow = {
  id: string;
  provider: string;
  label: string;
  model: string;
  apiKey: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastUsedAt?: string | null;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestCode?: string | null;
  lastTestMessage?: string | null;
};

/** Public meta for Frontend — never includes apiKey. */
export type UserAiKeyPublic = {
  id: string;
  provider: string;
  label: string;
  model: string;
  maskedKey: string;
  hint: string;
  hasKey: boolean;
  storeOnServer: true;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestCode: string | null;
  lastTestMessage: string | null;
  lastTestStatus: "ok" | "error" | "untested";
};

export type AiKeyAuditAction =
  | "create"
  | "test"
  | "replace"
  | "delete"
  | "use";

export type AiKeyAuditEvent = {
  id: string;
  keyId: string;
  action: AiKeyAuditAction;
  provider: string;
  ok: boolean;
  code: string | null;
  message: string | null;
  actorUserId: string;
  createdAt: string;
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
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toPublicAiKey(row: UserAiKeyRow): UserAiKeyPublic {
  const masked = maskGeminiKey(row.apiKey || "");
  const lastTestOk = row.lastTestOk;
  const lastTestStatus: UserAiKeyPublic["lastTestStatus"] =
    row.lastTestAt == null
      ? "untested"
      : lastTestOk
        ? "ok"
        : "error";
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    maskedKey: masked,
    hint: masked,
    hasKey: Boolean(row.apiKey),
    storeOnServer: true,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    lastUsedAt: row.lastUsedAt || null,
    lastTestAt: row.lastTestAt || null,
    lastTestOk: lastTestOk ?? null,
    lastTestCode: row.lastTestCode || null,
    lastTestMessage: row.lastTestMessage || null,
    lastTestStatus,
  };
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
  // New columns (migration 20261110_ai_key_meta_and_audit.sql) — additive only.
  await pool.query(`
    ALTER TABLE user_ai_keys
      ADD COLUMN IF NOT EXISTS "lastUsedAt" timestamptz NULL
  `);
  await pool.query(`
    ALTER TABLE user_ai_keys
      ADD COLUMN IF NOT EXISTS "lastTestAt" timestamptz NULL
  `);
  await pool.query(`
    ALTER TABLE user_ai_keys
      ADD COLUMN IF NOT EXISTS "lastTestOk" boolean NULL
  `);
  await pool.query(`
    ALTER TABLE user_ai_keys
      ADD COLUMN IF NOT EXISTS "lastTestCode" text NULL
  `);
  await pool.query(`
    ALTER TABLE user_ai_keys
      ADD COLUMN IF NOT EXISTS "lastTestMessage" text NULL
  `);
  await ensureUserAiKeyAuditTable();
}

export async function ensureUserAiKeyAuditTable(): Promise<void> {
  const pool = getAuthPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_ai_key_audit (
      id bigserial PRIMARY KEY,
      "userId" text NOT NULL,
      "keyId" text NOT NULL,
      action text NOT NULL,
      provider text NOT NULL DEFAULT '',
      ok boolean NOT NULL DEFAULT false,
      code text NULL,
      message text NULL,
      "actorUserId" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_ai_key_audit_user_created_idx
      ON user_ai_key_audit ("userId", "createdAt" DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_ai_key_audit_key_created_idx
      ON user_ai_key_audit ("userId", "keyId", "createdAt" DESC)
  `);
}

type DbKeyRow = {
  id: string;
  provider: string;
  label: string;
  model: string;
  apiKeyEnc: string;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  lastUsedAt: Date | string | null;
  lastTestAt: Date | string | null;
  lastTestOk: boolean | null;
  lastTestCode: string | null;
  lastTestMessage: string | null;
};

function mapDbRow(r: DbKeyRow): UserAiKeyRow | null {
  try {
    return {
      id: r.id,
      provider: r.provider,
      label: r.label || "",
      model: r.model || "",
      apiKey: decryptAiKey(r.apiKeyEnc),
      createdAt: toIso(r.createdAt),
      updatedAt: toIso(r.updatedAt),
      lastUsedAt: toIso(r.lastUsedAt),
      lastTestAt: toIso(r.lastTestAt),
      lastTestOk: r.lastTestOk,
      lastTestCode: r.lastTestCode,
      lastTestMessage: r.lastTestMessage,
    };
  } catch {
    return null;
  }
}

const KEY_SELECT = `
  id, provider, label, model, "apiKeyEnc" AS "apiKeyEnc",
  "createdAt" AS "createdAt", "updatedAt" AS "updatedAt",
  "lastUsedAt" AS "lastUsedAt", "lastTestAt" AS "lastTestAt",
  "lastTestOk" AS "lastTestOk", "lastTestCode" AS "lastTestCode",
  "lastTestMessage" AS "lastTestMessage"
`;

export async function listUserAiKeys(userId: string): Promise<UserAiKeyRow[]> {
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const { rows } = await pool.query<DbKeyRow>(
    `SELECT ${KEY_SELECT}
     FROM user_ai_keys
     WHERE "userId" = $1
     ORDER BY "updatedAt" DESC`,
    [userId],
  );
  const out: UserAiKeyRow[] = [];
  for (const r of rows) {
    const mapped = mapDbRow(r);
    if (mapped) out.push(mapped);
  }
  return out;
}

export async function listUserAiKeysPublic(
  userId: string,
): Promise<UserAiKeyPublic[]> {
  return (await listUserAiKeys(userId)).map(toPublicAiKey);
}

export async function upsertUserAiKey(
  userId: string,
  entry: UserAiKeyRow,
  opts?: { actorUserId?: string; auditAction?: "create" | "replace" },
): Promise<UserAiKeyRow> {
  await ensureUserAiKeysTable();
  const id = String(entry.id || "").trim();
  const apiKey = String(entry.apiKey || "").trim();
  if (!id || !apiKey) throw new Error("ต้องมี id และ apiKey");
  if (!isValidUserAiKeyId(id)) throw new Error("id ไม่ถูกต้อง");
  const provider = String(entry.provider || "google").trim() || "google";
  const label = String(entry.label || provider).trim() || provider;
  const model = String(entry.model || "").trim();
  const enc = encryptAiKey(apiKey);
  const pool = getAuthPool();

  const existing = await getUserAiKey(userId, id);
  const action: "create" | "replace" =
    opts?.auditAction || (existing ? "replace" : "create");

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

  await recordAiKeyAudit({
    userId,
    keyId: id,
    action,
    provider,
    ok: true,
    code: action === "create" ? "AI_KEY_CREATED" : "AI_KEY_REPLACED",
    message: action === "create" ? "สร้างคีย์แล้ว" : "หมุนเวียนคีย์แล้ว",
    actorUserId: opts?.actorUserId || userId,
  });

  const row = await getUserAiKey(userId, id);
  if (!row) throw new Error("บันทึกคีย์ไม่สำเร็จ");
  return row;
}

export async function upsertUserAiKeys(
  userId: string,
  entries: UserAiKeyRow[],
): Promise<UserAiKeyRow[]> {
  const out: UserAiKeyRow[] = [];
  for (const e of entries) {
    out.push(await upsertUserAiKey(userId, e, { actorUserId: userId }));
  }
  return out;
}

export async function createUserAiKey(
  userId: string,
  entry: Omit<UserAiKeyRow, "id"> & { id?: string },
): Promise<UserAiKeyRow> {
  const id =
    String(entry.id || "").trim() ||
    `k-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  if (!isValidUserAiKeyId(id)) throw new Error("id ไม่ถูกต้อง");
  const existing = await getUserAiKey(userId, id);
  if (existing) {
    const err = new Error("มีคีย์ id นี้แล้ว") as Error & { code?: string };
    err.code = "AI_KEY_EXISTS";
    throw err;
  }
  return upsertUserAiKey(
    userId,
    {
      id,
      provider: entry.provider,
      label: entry.label,
      model: entry.model,
      apiKey: entry.apiKey,
    },
    { actorUserId: userId, auditAction: "create" },
  );
}

export async function replaceUserAiKey(
  userId: string,
  id: string,
  patch: {
    apiKey: string;
    provider?: string;
    label?: string;
    model?: string;
  },
): Promise<UserAiKeyRow | null> {
  const existing = await getUserAiKey(userId, id);
  if (!existing) return null;
  return upsertUserAiKey(
    userId,
    {
      id,
      provider: patch.provider || existing.provider,
      label: patch.label != null ? patch.label : existing.label,
      model: patch.model != null ? patch.model : existing.model,
      apiKey: patch.apiKey,
    },
    { actorUserId: userId, auditAction: "replace" },
  );
}

export async function deleteUserAiKey(
  userId: string,
  id: string,
): Promise<boolean> {
  const keyId = String(id || "").trim();
  if (!isValidUserAiKeyId(keyId)) return false;
  await ensureUserAiKeysTable();
  const existing = await getUserAiKey(userId, keyId);
  const pool = getAuthPool();
  const res = await pool.query(
    `DELETE FROM user_ai_keys WHERE id = $1 AND "userId" = $2`,
    [keyId, userId],
  );
  const removed = (res.rowCount || 0) > 0;
  if (removed) {
    await recordAiKeyAudit({
      userId,
      keyId,
      action: "delete",
      provider: existing?.provider || "",
      ok: true,
      code: "AI_KEY_DELETED",
      message: "ลบคีย์แล้ว",
      actorUserId: userId,
    });
  }
  return removed;
}

/** Resolve one vault entry (with decrypted key) for server-side proxy use. */
export async function getUserAiKey(
  userId: string,
  id: string,
): Promise<UserAiKeyRow | null> {
  const want = String(id || "").trim();
  if (!want || !isValidUserAiKeyId(want)) return null;
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const { rows } = await pool.query<DbKeyRow>(
    `SELECT ${KEY_SELECT}
     FROM user_ai_keys
     WHERE "userId" = $1 AND id = $2
     LIMIT 1`,
    [userId, want],
  );
  if (!rows[0]) return null;
  return mapDbRow(rows[0]);
}

export async function touchUserAiKeyUsed(
  userId: string,
  id: string,
): Promise<void> {
  const keyId = String(id || "").trim();
  if (!isValidUserAiKeyId(keyId)) return;
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const res = await pool.query(
    `UPDATE user_ai_keys SET "lastUsedAt" = NOW()
     WHERE "userId" = $1 AND id = $2`,
    [userId, keyId],
  );
  if ((res.rowCount || 0) > 0) {
    const row = await getUserAiKey(userId, keyId);
    await recordAiKeyAudit({
      userId,
      keyId,
      action: "use",
      provider: row?.provider || "",
      ok: true,
      code: "AI_KEY_USED",
      message: "ใช้คีย์เรียก AI",
      actorUserId: userId,
    });
  }
}

export async function updateUserAiKeyTestResult(
  userId: string,
  id: string,
  result: {
    ok: boolean;
    code: string;
    message: string;
  },
): Promise<UserAiKeyRow | null> {
  const keyId = String(id || "").trim();
  if (!isValidUserAiKeyId(keyId)) return null;
  await ensureUserAiKeysTable();
  const pool = getAuthPool();
  const msg = String(result.message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  await pool.query(
    `UPDATE user_ai_keys SET
       "lastTestAt" = NOW(),
       "lastTestOk" = $3,
       "lastTestCode" = $4,
       "lastTestMessage" = $5,
       "lastUsedAt" = CASE WHEN $3 THEN NOW() ELSE "lastUsedAt" END,
       "updatedAt" = "updatedAt"
     WHERE "userId" = $1 AND id = $2`,
    [userId, keyId, result.ok, result.code, msg || null],
  );
  await recordAiKeyAudit({
    userId,
    keyId,
    action: "test",
    provider: (await getUserAiKey(userId, keyId))?.provider || "",
    ok: result.ok,
    code: result.code,
    message: msg || null,
    actorUserId: userId,
  });
  return getUserAiKey(userId, keyId);
}

export async function recordAiKeyAudit(opts: {
  userId: string;
  keyId: string;
  action: AiKeyAuditAction;
  provider?: string;
  ok: boolean;
  code?: string | null;
  message?: string | null;
  actorUserId?: string;
}): Promise<void> {
  await ensureUserAiKeyAuditTable();
  const pool = getAuthPool();
  const message = opts.message
    ? String(opts.message).replace(/\s+/g, " ").trim().slice(0, 200)
    : null;
  // Never persist anything that looks like a raw key.
  if (message && /(?:sk-|AIza|crsr_|Bearer\s)/i.test(message)) {
    await pool.query(
      `INSERT INTO user_ai_key_audit
         ("userId", "keyId", action, provider, ok, code, message, "actorUserId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.userId,
        opts.keyId,
        opts.action,
        opts.provider || "",
        opts.ok,
        opts.code || null,
        "รายละเอียดถูกตัดเพื่อความปลอดภัย",
        opts.actorUserId || opts.userId,
      ],
    );
    return;
  }
  await pool.query(
    `INSERT INTO user_ai_key_audit
       ("userId", "keyId", action, provider, ok, code, message, "actorUserId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.userId,
      opts.keyId,
      opts.action,
      opts.provider || "",
      opts.ok,
      opts.code || null,
      message,
      opts.actorUserId || opts.userId,
    ],
  );
}

export async function listUserAiKeyAudit(
  userId: string,
  opts?: { keyId?: string; limit?: number },
): Promise<AiKeyAuditEvent[]> {
  await ensureUserAiKeyAuditTable();
  const pool = getAuthPool();
  const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit || 50)));
  const keyId = String(opts?.keyId || "").trim();
  const params: unknown[] = [userId];
  let sql = `
    SELECT id::text AS id, "keyId" AS "keyId", action, provider, ok, code, message,
           "actorUserId" AS "actorUserId", "createdAt" AS "createdAt"
    FROM user_ai_key_audit
    WHERE "userId" = $1`;
  if (keyId) {
    params.push(keyId);
    sql += ` AND "keyId" = $2`;
  }
  params.push(limit);
  sql += ` ORDER BY "createdAt" DESC LIMIT $${params.length}`;
  const { rows } = await pool.query<{
    id: string;
    keyId: string;
    action: string;
    provider: string;
    ok: boolean;
    code: string | null;
    message: string | null;
    actorUserId: string;
    createdAt: Date | string;
  }>(sql, params);
  return rows.map((r) => ({
    id: r.id || randomUUID(),
    keyId: r.keyId,
    action: r.action as AiKeyAuditAction,
    provider: r.provider || "",
    ok: !!r.ok,
    code: r.code,
    message: r.message,
    actorUserId: r.actorUserId,
    createdAt: toIso(r.createdAt) || new Date().toISOString(),
  }));
}
