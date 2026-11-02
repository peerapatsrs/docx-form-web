/**
 * Production response headers: CSP + common browser hardening.
 * Keep CSP aligned with auth/passkeys, same-origin APIs, Google Fonts, and blob downloads.
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

/** CSP that preserves OAuth redirects, passkeys, fonts, images, and BYOK AI (via same-origin API). */
export function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    // Next.js + hybrid /public/app.js shell use inline bootstraps; passkeys stay same-origin.
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
    // Passkeys need publickey-credentials-*; disable unused powerful features.
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "X-DNS-Prefetch-Control": "off",
  };
}

/** Short TTL for HTML / document navigations (CDN + browser). */
export const HTML_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, must-revalidate";

/** Long-lived cache only for content-hashed / versioned static assets. */
export const VERSIONED_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
