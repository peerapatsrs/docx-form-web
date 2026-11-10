import { randomBytes, randomUUID } from "node:crypto";
import { serializeSignedCookie } from "better-call";
import { hashPassword } from "better-auth/crypto";
import {
  isDevTestAccountsExposed,
  isDevTestUsersSeedEnabled,
} from "@/lib/dev-test-accounts-flag";
import { getAppEnv, isAppEnvDev } from "@/lib/app-env";
import { resolveClientIp, rateLimitClientIp } from "./client-ip";
import { getAuthPool } from "./auth-db";
import { writeAuditLog } from "./admin-store";

export type DevTestAccountPublic = {
  key: string;
  label: string;
  role: string;
};

export type DevTestAccountDef = DevTestAccountPublic & {
  plan: string;
  email: string;
  /** Present only during seed; never returned from public list. */
  password?: string;
};

export type SeedTestUsersStatus = "seeded" | "skipped" | "partial";

export type SeedTestUsersResult = {
  status: SeedTestUsersStatus;
  reason?: "disabled" | "not_dev" | "empty";
  created: string[];
  updated: string[];
  emails: string[];
};

export type SeedTestUsersDeps = {
  isSeedEnabled?: () => boolean;
  isDev?: () => boolean;
  getAccounts?: () => DevTestAccountDef[];
  generateId?: () => string;
  hashPassword?: (password: string) => Promise<string>;
  warn?: (message: string) => void;
  query?: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

export type TestLoginResult =
  | {
      ok: true;
      status: 200;
      setCookie: string;
      user: {
        id: string;
        email: string;
        name: string | null;
        role: string;
        plan: string;
      };
    }
  | { ok: false; status: 404 | 429 | 500; error: string };

type QueryFn = NonNullable<SeedTestUsersDeps["query"]>;

const DEFAULT_USER_EMAIL = "test-user@docx-form.dev";
const DEFAULT_ADMIN_EMAIL = "test-admin@docx-form.dev";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_LIST = 30;
const RATE_MAX_LOGIN = 12;

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = String(process.env[name] || "").trim();
    if (v) return v;
  }
  return undefined;
}

function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Configured DEV test accounts (emails/passwords from env; keys are fixed).
 * Passwords are never included in the public list payload.
 */
export function getConfiguredTestAccounts(): DevTestAccountDef[] {
  const userEmail =
    firstEnv(["TEST_LOGIN_USER_EMAIL", "SEED_TEST_USER_EMAIL"]) ||
    DEFAULT_USER_EMAIL;
  const adminEmail =
    firstEnv(["TEST_LOGIN_ADMIN_EMAIL", "SEED_TEST_ADMIN_EMAIL"]) ||
    DEFAULT_ADMIN_EMAIL;
  const userPassword = firstEnv([
    "TEST_LOGIN_USER_PASSWORD",
    "SEED_TEST_USER_PASSWORD",
  ]);
  const adminPassword = firstEnv([
    "TEST_LOGIN_ADMIN_PASSWORD",
    "SEED_TEST_ADMIN_PASSWORD",
  ]);

  return [
    {
      key: "user",
      label: "ผู้ใช้ทดสอบ",
      role: "user",
      plan: "free",
      email: userEmail.toLowerCase(),
      password: userPassword,
    },
    {
      key: "admin",
      label: "แอดมินทดสอบ",
      // APP_ENV=dev seed only — superadmin via normal DB role path (no SUPERADMIN_EMAILS).
      role: "superadmin",
      plan: "pro",
      email: adminEmail.toLowerCase(),
      password: adminPassword,
    },
  ];
}

/** Public list shape for GET /api/dev/test-accounts — no emails/passwords. */
export function listPublicTestAccounts(
  accounts: DevTestAccountDef[] = getConfiguredTestAccounts(),
): DevTestAccountPublic[] {
  return accounts.map(({ key, label, role }) => ({ key, label, role }));
}

async function defaultQuery<T>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const result = await getAuthPool().query(sql, params);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount,
  };
}

function warnNotDev(action: string, warn: (m: string) => void): void {
  const env = getAppEnv() || "(unset)";
  warn(
    `[dev-test-accounts] refused ${action}: APP_ENV=${env} (need APP_ENV=dev); flags ignored`,
  );
}

/**
 * Idempotent seed of the two DEV test users.
 * Only runs when SEED_TEST_USERS=1 and APP_ENV=dev.
 * Passwords come from env or are generated once (never logged).
 */
export async function seedTestUsers(
  deps: SeedTestUsersDeps = {},
): Promise<SeedTestUsersResult> {
  const isSeedEnabled = deps.isSeedEnabled ?? isDevTestUsersSeedEnabled;
  const isDev = deps.isDev ?? isAppEnvDev;
  const getAccounts = deps.getAccounts ?? getConfiguredTestAccounts;
  const generateId = deps.generateId ?? (() => randomUUID());
  const hash = deps.hashPassword ?? hashPassword;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const query = deps.query ?? defaultQuery;

  if (!isDev()) {
    if (
      String(process.env.SEED_TEST_USERS || "")
        .trim()
        .match(/^(1|true|yes|on)$/i)
    ) {
      warnNotDev("seed", warn);
    }
    return { status: "skipped", reason: "not_dev", created: [], updated: [], emails: [] };
  }

  if (!isSeedEnabled()) {
    return { status: "skipped", reason: "disabled", created: [], updated: [], emails: [] };
  }

  const accounts = getAccounts();
  if (!accounts.length) {
    return { status: "skipped", reason: "empty", created: [], updated: [], emails: [] };
  }

  const created: string[] = [];
  const updated: string[] = [];
  const emails: string[] = [];

  for (const account of accounts) {
    emails.push(account.email);
    const passwordPlain = account.password || generatePassword();
    const passwordHash = await hash(passwordPlain);
    const existing = await query<{ id: string; role: string | null; plan: string | null }>(
      `SELECT id, role, plan FROM "user" WHERE lower(email) = $1 LIMIT 1`,
      [account.email],
    );

    let userId: string;
    if (existing.rows[0]) {
      userId = existing.rows[0].id;
      await query(
        `UPDATE "user"
         SET role = $2, plan = $3, "emailVerified" = true, "updatedAt" = NOW()
         WHERE id = $1`,
        [userId, account.role, account.plan],
      );
      updated.push(account.key);
    } else {
      userId = generateId();
      const name = account.label;
      const inserted = await query<{ id: string }>(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, plan)
         VALUES ($1, $2, $3, true, NOW(), NOW(), $4, $5)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [userId, name, account.email, account.role, account.plan],
      );
      if (inserted.rows[0]?.id) {
        userId = inserted.rows[0].id;
        created.push(account.key);
      } else {
        const again = await query<{ id: string }>(
          `SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1`,
          [account.email],
        );
        userId = again.rows[0]?.id || userId;
        updated.push(account.key);
      }
    }

    // Credential account for completeness (password auth remains disabled app-wide).
    const accountId = account.email;
    const existingCred = await query<{ id: string }>(
      `SELECT id FROM account
       WHERE "userId" = $1 AND "providerId" = 'credential'
       LIMIT 1`,
      [userId],
    );
    if (existingCred.rows[0]) {
      await query(
        `UPDATE account
         SET password = $2, "accountId" = $3, "updatedAt" = NOW()
         WHERE id = $1`,
        [existingCred.rows[0].id, passwordHash, accountId],
      );
    } else {
      await query(
        `INSERT INTO account
           (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
         VALUES ($1, $2, 'credential', $3, $4, NOW(), NOW())`,
        [generateId(), accountId, userId, passwordHash],
      );
    }
  }

  const status: SeedTestUsersStatus =
    created.length === 0 && updated.length === 0 ? "skipped" : "seeded";
  return { status, created, updated, emails };
}

function takeRateLimit(bucketKey: string, max: number): boolean {
  const now = Date.now();
  const existing = rateBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

/** Test helper — clear in-memory rate-limit buckets. */
export function resetDevTestAccountsRateLimit(): void {
  rateBuckets.clear();
}

export function clientIpFromRequest(request: Request): string {
  return rateLimitClientIp(resolveClientIp(request.headers));
}

export function allowTestAccountsList(ip: string): boolean {
  return takeRateLimit(`list:${ip}`, RATE_MAX_LIST);
}

export function allowTestLogin(ip: string): boolean {
  return takeRateLimit(`login:${ip}`, RATE_MAX_LOGIN);
}

/**
 * Resolve a configured test account by opaque key. Never accepts arbitrary emails/ids.
 */
export function findConfiguredTestAccount(
  key: string,
  accounts: DevTestAccountDef[] = getConfiguredTestAccounts(),
): DevTestAccountDef | undefined {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return undefined;
  return accounts.find((a) => a.key.toLowerCase() === k);
}

async function createSessionSetCookie(userId: string): Promise<{
  setCookie: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    plan: string;
  };
}> {
  const { auth } = await import("./auth");
  const ctx = await auth.$context;
  const full = await ctx.internalAdapter.findUserById(userId);
  if (!full) {
    throw new Error("USER_NOT_FOUND");
  }
  const session = await ctx.internalAdapter.createSession(full.id, false);
  if (!session) {
    throw new Error("SESSION_FAILED");
  }
  const setCookie = await serializeSignedCookie(
    ctx.authCookies.sessionToken.name,
    session.token,
    ctx.secret,
    {
      ...ctx.authCookies.sessionToken.attributes,
      maxAge: ctx.sessionConfig.expiresIn,
    },
  );
  const role =
    String((full as { role?: string | null }).role || "").trim() || "user";
  const plan =
    String((full as { plan?: string | null }).plan || "").trim() || "free";
  return {
    setCookie,
    user: {
      id: full.id,
      email: full.email,
      name: full.name ?? null,
      role,
      plan,
    },
  };
}

export type TestLoginDeps = {
  isExposed?: () => boolean;
  getAccounts?: () => DevTestAccountDef[];
  allowLogin?: (ip: string) => boolean;
  resolveIp?: (request: Request) => string;
  query?: QueryFn;
  createSession?: typeof createSessionSetCookie;
  writeAudit?: typeof writeAuditLog;
};

/**
 * POST /api/dev/test-login — only the seeded keys; 404 when feature off or unknown key.
 */
export async function performTestLogin(
  request: Request,
  body: { key?: unknown },
  deps: TestLoginDeps = {},
): Promise<TestLoginResult> {
  const isExposed = deps.isExposed ?? isDevTestAccountsExposed;
  if (!isExposed()) {
    return { ok: false, status: 404, error: "ไม่พบ" };
  }

  const resolveIp = deps.resolveIp ?? clientIpFromRequest;
  const allowLogin = deps.allowLogin ?? allowTestLogin;
  const ip = resolveIp(request);
  if (!allowLogin(ip)) {
    return {
      ok: false,
      status: 429,
      error: "ลองใหม่ภายหลัง (rate limit)",
    };
  }

  const key = String(body?.key || "").trim();
  const account = findConfiguredTestAccount(
    key,
    deps.getAccounts?.() ?? getConfiguredTestAccounts(),
  );
  if (!account) {
    return { ok: false, status: 404, error: "ไม่พบบัญชีทดสอบ" };
  }

  const query = deps.query ?? defaultQuery;
  const { rows } = await query<{
    id: string;
    email: string;
    name: string | null;
    role: string | null;
    plan: string | null;
    banned: boolean | null;
  }>(
    `SELECT id, email, name, role, plan, banned
     FROM "user" WHERE lower(email) = $1 LIMIT 1`,
    [account.email],
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "ยังไม่ได้ seed บัญชีทดสอบ" };
  }
  if (row.banned) {
    return { ok: false, status: 404, error: "บัญชีทดสอบถูกแบน" };
  }

  try {
    const createSession = deps.createSession ?? createSessionSetCookie;
    const session = await createSession(row.id);
    const writeAudit = deps.writeAudit ?? writeAuditLog;
    await writeAudit({
      actorId: session.user.id,
      actorEmail: session.user.email,
      action: "dev.test_login",
      targetId: session.user.id,
      targetEmail: session.user.email,
      detail: { key: account.key, role: session.user.role, ip },
    }).catch(() => undefined);

    return {
      ok: true,
      status: 200,
      setCookie: session.setCookie,
      user: session.user,
    };
  } catch {
    return { ok: false, status: 500, error: "สร้างเซสชันไม่สำเร็จ" };
  }
}

/**
 * GET /api/dev/test-accounts — 200 list or 404 when gated off.
 */
export function getTestAccountsResponse(opts?: {
  isExposed?: () => boolean;
  allowList?: (ip: string) => boolean;
  ip?: string;
  accounts?: DevTestAccountDef[];
}):
  | { status: 200; body: DevTestAccountPublic[] }
  | { status: 404 | 429; body: { error: string } } {
  const isExposed = opts?.isExposed ?? isDevTestAccountsExposed;
  if (!isExposed()) {
    return { status: 404, body: { error: "ไม่พบ" } };
  }
  const ip = opts?.ip || "0.0.0.0";
  const allowList = opts?.allowList ?? allowTestAccountsList;
  if (!allowList(ip)) {
    return { status: 429, body: { error: "ลองใหม่ภายหลัง (rate limit)" } };
  }
  return {
    status: 200,
    body: listPublicTestAccounts(opts?.accounts ?? getConfiguredTestAccounts()),
  };
}
