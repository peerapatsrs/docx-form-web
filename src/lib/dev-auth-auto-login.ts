/**
 * Pure helper for Run Local /dev auth auto sign-in.
 * When defaultEmail is null/empty, do not pick any user (show the picker only).
 * Never falls back to users[0].
 */

export type DevAutoLoginUser = {
  email: string;
  banned?: boolean | null;
};

/**
 * @returns Matching non-banned user, or null when auto login must not run.
 */
export function resolveDevAutoLoginUser<T extends DevAutoLoginUser>(
  users: T[] | null | undefined,
  defaultEmail: string | null | undefined,
): T | null {
  const preferred = String(defaultEmail ?? "")
    .trim()
    .toLowerCase();
  if (!preferred) return null;
  const list = Array.isArray(users) ? users : [];
  const target = list.find(
    (u) => String(u?.email || "").trim().toLowerCase() === preferred,
  );
  if (!target || target.banned) return null;
  return target;
}
