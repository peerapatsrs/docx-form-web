/**
 * Resolved public origin for canonical / Open Graph / JSON-LD / sitemap.
 * Prefer an explicitly configured deployed URL; never bake a hard-coded host.
 */

function trimOrigin(raw: string): string {
  return raw.trim().replace(/\/$/, "");
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = String(process.env[name] || "").trim();
    if (v) return trimOrigin(v);
  }
  return undefined;
}

/**
 * Configured site origin (no trailing slash).
 * Order: APP_BASE_URL → NEXT_PUBLIC_APP_URL → BETTER_AUTH_URL → RENDER_EXTERNAL_URL → local dev.
 */
export function getAppBaseUrl(): string {
  const configured = firstEnv([
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
    "RENDER_EXTERNAL_URL",
  ]);
  if (configured) return configured;
  return "http://localhost:3000";
}

/**
 * Origin used by Better Auth (session cookies / OIDC redirect base).
 * Prefer BETTER_AUTH_URL when set so IdP / WebAuthn origins stay aligned;
 * otherwise fall back to the general app base URL.
 */
export function getBetterAuthBaseUrl(): string {
  const explicit = firstEnv(["BETTER_AUTH_URL"]);
  if (explicit) return explicit;
  return getAppBaseUrl();
}

export function absoluteAppUrl(path = "/"): string {
  const base = getAppBaseUrl();
  if (!path || path === "/") return `${base}/`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
