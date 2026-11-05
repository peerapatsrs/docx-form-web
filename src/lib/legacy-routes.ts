/** SPA-era paths that should redirect to `/` (bookmarks / old menus). */
export const LEGACY_HOME_REDIRECT_PATHS = [
  "/tagger",
  "/form",
  "/progress",
  "/success",
  "/components",
] as const;

/** Normalize `/foo/` → `/foo` for legacy redirect matching. */
export function normalizeLegacyPathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
}

export function isLegacyHomeRedirectPath(pathname: string): boolean {
  const normalized = normalizeLegacyPathname(pathname);
  return (LEGACY_HOME_REDIRECT_PATHS as readonly string[]).includes(normalized);
}
