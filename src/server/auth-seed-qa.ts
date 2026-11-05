import { randomUUID } from "node:crypto";
import { isDevAuthEnabled } from "@/lib/dev-auth-flag";
import { getAuthPool } from "./auth-db";
import { getDefaultDevAuthEmail } from "./dev-auth-default-email";
import { isSuperAdminEmail } from "./auth-superadmin";

export type SeedQaUserStatus = "created" | "exists" | "skipped";

export type SeedQaUserResult = {
  status: SeedQaUserStatus;
  reason?: "disabled" | "production" | "no_email";
  email?: string;
  id?: string;
};

export type SeedQaQueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

/**
 * Optional overrides for unit tests (fake query / env gates).
 * Production callers leave this empty.
 */
export type SeedQaUserDeps = {
  isEnabled?: () => boolean;
  isProduction?: () => boolean;
  getEmail?: () => string | undefined;
  isSuperAdmin?: (email: string) => boolean;
  generateId?: () => string;
  query?: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<SeedQaQueryResult<T>>;
};

async function defaultQuery<T>(
  sql: string,
  params?: unknown[],
): Promise<SeedQaQueryResult<T>> {
  const result = await getAuthPool().query(sql, params);
  return {
    rows: result.rows as T[],
    rowCount: result.rowCount,
  };
}

/**
 * Ensure the DEV_AUTH preferred email exists as a user row so login-as
 * works without a prior OAuth sign-in. Idempotent (safe to rerun).
 *
 * Same enablement gate as the dev-auth plugin (`isDevAuthEnabled`).
 * Skips when disabled, in production, or when no
 * email is configured via DEV_AUTH_DEFAULT_EMAIL / SUPERADMIN_EMAILS.
 * Relies on login-as (no password); never logs credentials.
 */
export async function seedQaUser(
  deps: SeedQaUserDeps = {},
): Promise<SeedQaUserResult> {
  const isEnabled = deps.isEnabled ?? isDevAuthEnabled;
  const isProduction =
    deps.isProduction ?? (() => process.env.NODE_ENV === "production");
  const getEmail = deps.getEmail ?? getDefaultDevAuthEmail;
  const isSuperAdmin = deps.isSuperAdmin ?? isSuperAdminEmail;
  const generateId = deps.generateId ?? (() => randomUUID());
  const query = deps.query ?? defaultQuery;

  if (!isEnabled()) {
    return {
      status: "skipped",
      reason: isProduction() ? "production" : "disabled",
    };
  }

  const email = getEmail();
  if (!email) {
    return { status: "skipped", reason: "no_email" };
  }

  const existing = await query<{ id: string }>(
    `SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  if (existing.rows[0]) {
    return { status: "exists", email, id: existing.rows[0].id };
  }

  const id = generateId();
  // Display name derived from the configured email local-part (not a fixed label).
  const name = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const role = isSuperAdmin(email) ? "superadmin" : "user";
  const plan = role === "superadmin" ? "pro" : "free";

  const inserted = await query<{ id: string }>(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, plan)
     VALUES ($1, $2, $3, true, NOW(), NOW(), $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [id, name, email, role, plan],
  );

  if (inserted.rows[0]) {
    return { status: "created", email, id: inserted.rows[0].id };
  }

  const again = await query<{ id: string }>(
    `SELECT id FROM "user" WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  const row = again.rows[0];
  if (!row) {
    throw new Error("[auth] QA seed conflict but user row missing");
  }
  return { status: "exists", email, id: row.id };
}
