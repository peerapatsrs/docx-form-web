import { getAuthPool } from "./auth-db";

const DEFAULT_SUPERADMIN_EMAILS = ["peerapat.srs@gmail.com"];

/** Emails that must always hold the `superadmin` role. */
export function getSuperAdminEmails(): string[] {
  const raw = String(process.env.SUPERADMIN_EMAILS || "").trim();
  const list = raw
    ? raw.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_SUPERADMIN_EMAILS;
  return [...new Set(list)];
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getSuperAdminEmails().includes(email.trim().toLowerCase());
}

/**
 * Ensure configured emails have role=superadmin in the DB.
 * Safe to call on every boot — only updates mismatched rows.
 */
export async function ensureSuperAdmins(): Promise<number> {
  const emails = getSuperAdminEmails();
  if (!emails.length) return 0;

  const pool = getAuthPool();
  const result = await pool.query(
    `UPDATE "user"
     SET role = 'superadmin',
         plan = 'pro'
     WHERE lower(email) = ANY($1::text[])
       AND (
         COALESCE(role, '') IS DISTINCT FROM 'superadmin'
         OR COALESCE(plan, '') IS DISTINCT FROM 'pro'
       )`,
    [emails],
  );
  return result.rowCount ?? 0;
}
