import { getAuthPool } from "./auth-db";

/** Defaults when app_settings.limits is missing */
export const DEFAULT_FREE_MAX_MULTI = 2;
export const DEFAULT_PAID_MAX_MULTI = 10;

export type AppLimits = {
  freeMaxMulti: number;
  paidMaxMulti: number;
  /**
   * Optional upgrade / payment deep link (F37).
   * Empty or unset → Frontend hides the link. Never hardcode a URL in the app.
   */
  upgradeUrl?: string;
};

export type AuditRow = {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetId: string | null;
  targetEmail: string | null;
  detail: unknown;
  createdAt: Date;
};

export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  plan: string | null;
  banned: boolean | null;
  banReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let schemaReady: Promise<void> | null = null;
let limitsCache: { at: number; value: AppLimits } | null = null;

export function ensureAdminSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = getAuthPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key text PRIMARY KEY,
          value jsonb NOT NULL,
          "updatedAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_audit (
          id bigserial PRIMARY KEY,
          "actorId" text,
          "actorEmail" text,
          action text NOT NULL,
          "targetId" text,
          "targetEmail" text,
          detail jsonb,
          "createdAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS admin_audit_created_idx
          ON admin_audit ("createdAt" DESC)
      `);
      await pool.query(
        `INSERT INTO app_settings (key, value)
         VALUES ('limits', $1::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [
          JSON.stringify({
            freeMaxMulti: DEFAULT_FREE_MAX_MULTI,
            paidMaxMulti: DEFAULT_PAID_MAX_MULTI,
          }),
        ],
      );
      await pool.query(
        `INSERT INTO app_settings (key, value)
         VALUES ('ai', $1::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ defaultModel: "gemini-3.8-flash" })],
      );
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
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function clampLimit(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(50, Math.max(1, Math.floor(v)));
}

/** Allow only http(s) absolute URLs; empty → hidden. */
export function sanitizeUpgradeUrl(raw: unknown): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

/**
 * Effective upgrade deep link (F37): admin `limits.upgradeUrl` if set,
 * else `DOCX_FORM_UPGRADE_URL` env, else empty (FE hides the control).
 */
export function resolveUpgradeUrl(limits?: AppLimits | null): string {
  const fromLimits = sanitizeUpgradeUrl(limits?.upgradeUrl);
  if (fromLimits) return fromLimits;
  return sanitizeUpgradeUrl(process.env.DOCX_FORM_UPGRADE_URL);
}

export async function getAppLimits(): Promise<AppLimits> {
  await ensureAdminSchema();
  if (limitsCache && Date.now() - limitsCache.at < 5_000) {
    return limitsCache.value;
  }
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    value: { freeMaxMulti?: number; paidMaxMulti?: number; upgradeUrl?: string };
  }>(`SELECT value FROM app_settings WHERE key = 'limits' LIMIT 1`);
  const raw = rows[0]?.value || {};
  const value: AppLimits = {
    freeMaxMulti: clampLimit(raw.freeMaxMulti, DEFAULT_FREE_MAX_MULTI),
    paidMaxMulti: clampLimit(raw.paidMaxMulti, DEFAULT_PAID_MAX_MULTI),
    upgradeUrl: sanitizeUpgradeUrl(raw.upgradeUrl) || undefined,
  };
  if (value.paidMaxMulti < value.freeMaxMulti) {
    value.paidMaxMulti = value.freeMaxMulti;
  }
  limitsCache = { at: Date.now(), value };
  return value;
}

export async function setAppLimits(
  next: Partial<AppLimits>,
): Promise<AppLimits> {
  await ensureAdminSchema();
  const cur = await getAppLimits();
  const nextUrl =
    next.upgradeUrl !== undefined
      ? sanitizeUpgradeUrl(next.upgradeUrl)
      : cur.upgradeUrl || "";
  const value: AppLimits = {
    freeMaxMulti: clampLimit(next.freeMaxMulti ?? cur.freeMaxMulti, cur.freeMaxMulti),
    paidMaxMulti: clampLimit(next.paidMaxMulti ?? cur.paidMaxMulti, cur.paidMaxMulti),
    upgradeUrl: nextUrl || undefined,
  };
  if (value.paidMaxMulti < value.freeMaxMulti) {
    value.paidMaxMulti = value.freeMaxMulti;
  }
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO app_settings (key, value, "updatedAt")
     VALUES ('limits', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, "updatedAt" = NOW()`,
    [JSON.stringify(value)],
  );
  limitsCache = { at: Date.now(), value };
  return value;
}

export type AiAdminSettings = {
  defaultModel: string;
  /** When unset, treated as google (Gemini) for effective-provider resolution. */
  defaultProvider?: string;
};

export async function getAiAdminSettings(): Promise<AiAdminSettings> {
  await ensureAdminSchema();
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    value: { defaultModel?: string; defaultProvider?: string };
  }>(
    `SELECT value FROM app_settings WHERE key = 'ai' LIMIT 1`,
  );
  const model = String(rows[0]?.value?.defaultModel || "gemini-3.8-flash").trim();
  const defaultProvider = String(rows[0]?.value?.defaultProvider || "").trim();
  return {
    defaultModel: model || "gemini-3.8-flash",
    ...(defaultProvider ? { defaultProvider } : {}),
  };
}

export async function setAiAdminSettings(
  next: Partial<AiAdminSettings>,
): Promise<AiAdminSettings> {
  await ensureAdminSchema();
  const cur = await getAiAdminSettings();
  const value: AiAdminSettings = {
    defaultModel: String(next.defaultModel || cur.defaultModel).trim() || cur.defaultModel,
    defaultProvider: String(next.defaultProvider || cur.defaultProvider || "").trim() || undefined,
  };
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO app_settings (key, value, "updatedAt")
     VALUES ('ai', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, "updatedAt" = NOW()`,
    [JSON.stringify(value)],
  );
  return value;
}

export async function writeAuditLog(input: {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetId?: string | null;
  targetEmail?: string | null;
  detail?: unknown;
}): Promise<void> {
  await ensureAdminSchema();
  const pool = getAuthPool();
  await pool.query(
    `INSERT INTO admin_audit
      ("actorId", "actorEmail", action, "targetId", "targetEmail", detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.actorId || null,
      input.actorEmail || null,
      input.action,
      input.targetId || null,
      input.targetEmail || null,
      JSON.stringify(input.detail ?? null),
    ],
  );
}

export async function listAuditLogs(limit = 100): Promise<AuditRow[]> {
  await ensureAdminSchema();
  const pool = getAuthPool();
  const { rows } = await pool.query<AuditRow>(
    `SELECT id, "actorId", "actorEmail", action, "targetId", "targetEmail", detail, "createdAt"
     FROM admin_audit
     ORDER BY "createdAt" DESC
     LIMIT $1`,
    [Math.min(500, Math.max(1, limit))],
  );
  return rows;
}

export async function listUsersForAdmin(opts?: {
  q?: string;
}): Promise<AdminUserRow[]> {
  await ensureAdminSchema();
  const pool = getAuthPool();
  const q = String(opts?.q || "").trim().toLowerCase();
  if (q) {
    const { rows } = await pool.query<AdminUserRow>(
      `SELECT id, name, email, role, plan, banned, "banReason", "createdAt", "updatedAt"
       FROM "user"
       WHERE lower(email) LIKE $1 OR lower(COALESCE(name, '')) LIKE $1
       ORDER BY "createdAt" DESC
       LIMIT 200`,
      [`%${q}%`],
    );
    return rows;
  }
  const { rows } = await pool.query<AdminUserRow>(
    `SELECT id, name, email, role, plan, banned, "banReason", "createdAt", "updatedAt"
     FROM "user"
     ORDER BY "createdAt" DESC
     LIMIT 200`,
  );
  return rows;
}

export async function setUserPlan(
  userId: string,
  plan: "free" | "pro",
): Promise<{ email: string; plan: string; role: string | null } | null> {
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    email: string;
    plan: string;
    role: string | null;
  }>(
    `UPDATE "user"
     SET plan = $2, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING email, plan, role`,
    [userId, plan],
  );
  return rows[0] ?? null;
}

const ALLOWED_ROLES = new Set(["user", "admin", "superadmin"]);

export async function setUserRole(
  userId: string,
  role: string,
): Promise<{ email: string; role: string } | null> {
  const r = String(role || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_ROLES.has(r)) return null;
  const pool = getAuthPool();
  const { rows } = await pool.query<{ email: string; role: string }>(
    `UPDATE "user"
     SET role = $2, "updatedAt" = NOW()
     WHERE id = $1
     RETURNING email, role`,
    [userId, r],
  );
  return rows[0] ?? null;
}

export async function setUserBanned(
  userId: string,
  banned: boolean,
  banReason?: string | null,
): Promise<{ email: string; banned: boolean; banReason: string | null } | null> {
  const pool = getAuthPool();
  const reason = banned ? String(banReason || "ถูกระงับโดยแอดมิน").trim() : null;
  const { rows } = await pool.query<{
    email: string;
    banned: boolean;
    banReason: string | null;
  }>(
    `UPDATE "user"
     SET banned = $2,
         "banReason" = $3,
         "banExpires" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1
     RETURNING email, banned, "banReason"`,
    [userId, banned, reason],
  );
  if (banned && rows[0]) {
    await pool.query(`DELETE FROM session WHERE "userId" = $1`, [userId]);
  }
  return rows[0] ?? null;
}
