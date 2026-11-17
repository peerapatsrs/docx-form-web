/**
 * Production response headers: CSP + common browser hardening.
 * Keep CSP aligned with same-origin APIs, Google Fonts, and blob downloads.
 * Passkeys/WebAuthn are managed at Keycloak — not in this app.
 */

export const SECURITY_HEADER_NAMES = [
  "Content-Security-Policy",
  "Strict-Transport-Security",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "X-DNS-Prefetch-Control",
] as const;

/** CSP for same-origin APIs, fonts, images, and BYOK AI (via same-origin API). */
export function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    // Next.js + hybrid /public/app.js shell use inline bootstraps.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ];
  return directives.join("; ");
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // App no longer hosts WebAuthn (passkeys live at Keycloak). Disable powerful features.
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=(), publickey-credentials-get=(), publickey-credentials-create=()",
    "X-DNS-Prefetch-Control": "off",
  };
}

/** Short TTL for public HTML / document navigations (CDN + browser). */
export const HTML_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, must-revalidate";

/**
 * Session / user-specific HTML must not be stored in shared caches.
 * Applies to authenticated surfaces such as account and admin.
 */
export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

/** Long-lived cache only for content-hashed / versioned static assets. */
export const VERSIONED_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

/**
 * Paths whose responses are user-specific and must never be cached publicly.
 * Keep in sync with auth gates in the edge proxy.
 */
export function isPrivateDocumentPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0] || "/";
  return (
    path === "/account" ||
    path.startsWith("/account/") ||
    path === "/admin" ||
    path.startsWith("/admin/")
  );
}

/** Cache-Control for HTML document navigations based on path sensitivity. */
export function documentCacheControl(pathname: string): string {
  return isPrivateDocumentPath(pathname)
    ? PRIVATE_NO_STORE_CACHE_CONTROL
    : HTML_CACHE_CONTROL;
}
