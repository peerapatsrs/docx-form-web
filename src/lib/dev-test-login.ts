/**
 * Pure helpers for Backend-owned DEV test-login (SHOW_TEST_ACCOUNTS + APP_ENV=dev).
 * FE never reads passwords — only keys/labels from GET /api/dev/test-accounts.
 * See docs/FE-DEV-TEST-LOGIN.md.
 */

export const TEST_ACCOUNTS_PANEL_TITLE = "บัญชีทดสอบ (เฉพาะ DEV)";

export const TEST_ACCOUNTS_LIST_PATH = "/api/dev/test-accounts";
export const TEST_LOGIN_PATH = "/api/dev/test-login";

export type DevTestAccount = {
  key: string;
  label: string;
  role: string;
};

/** Same-origin relative paths only (block open redirects). */
export function safeLoginNextPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  const v = String(raw || "").trim();
  if (!v.startsWith("/") || v.startsWith("//")) return fallback;
  return v;
}

/**
 * Normalize GET /api/dev/test-accounts JSON into account rows.
 * Accepts a bare array or `{ accounts: [...] }`.
 */
export function parseTestAccountsPayload(data: unknown): DevTestAccount[] {
  const raw = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { accounts?: unknown }).accounts)
      ? (data as { accounts: unknown[] }).accounts
      : null;
  if (!raw) return [];
  /** @type {DevTestAccount[]} */
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const key = String((row as { key?: unknown }).key || "").trim();
    if (!key) continue;
    const label =
      String((row as { label?: unknown }).label || "").trim() || key;
    const role = String((row as { role?: unknown }).role || "").trim() || "user";
    out.push({ key, label, role });
  }
  return out;
}

/**
 * Show the panel only when the list call succeeded with at least one account.
 * 404 / network / empty → hidden (flag off or not configured).
 */
export function shouldShowTestAccountsPanel(
  status: number,
  accounts: DevTestAccount[] | null | undefined,
): boolean {
  return status === 200 && Array.isArray(accounts) && accounts.length > 0;
}

function isAdminRole(role: string | null | undefined): boolean {
  const r = String(role || "")
    .trim()
    .toLowerCase();
  return r === "admin" || r === "superadmin" || r === "staff";
}

/**
 * After a successful POST /api/dev/test-login, pick the redirect target.
 * Honours `?next=` when set; otherwise admin-like roles go to `/admin`.
 */
export function resolveTestLoginRedirect(
  role: string | null | undefined,
  nextRaw: string | null | undefined,
): string {
  const next = safeLoginNextPath(nextRaw, "");
  if (next && next !== "/") return next;
  if (isAdminRole(role)) return "/admin";
  return next || "/";
}
