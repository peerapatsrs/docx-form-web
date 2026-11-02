/**
 * Safe public origin helpers for redirects and host checks.
 * Never build absolute redirect targets from raw Host / X-Forwarded-Host.
 */

import { getAppBaseUrl } from "./app-base-url";

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

/** Parse hostname (lowercased, no port) from an origin or host:port string. */
export function hostnameFromHostOrOrigin(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    if (value.includes("://")) {
      const host = new URL(value).hostname;
      return host ? host.toLowerCase() : null;
    }
  } catch {
    return null;
  }
  // host[:port] — strip brackets for IPv6 and trailing port when unambiguous.
  const noBrackets = value.replace(/^\[|\]$/g, "");
  if (noBrackets.includes(":") && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(noBrackets)) {
    // Likely IPv6 without scheme — reject unless it was URL-parsed above.
    if (noBrackets.split(":").length > 2) return null;
  }
  const hostname = noBrackets.replace(/:\d+$/, "").toLowerCase();
  return hostname || null;
}

function configuredOriginStrings(): string[] {
  const fromEnv = [
    firstEnv(["APP_BASE_URL"]),
    firstEnv(["NEXT_PUBLIC_APP_URL"]),
    firstEnv(["BETTER_AUTH_URL"]),
    firstEnv(["RENDER_EXTERNAL_URL"]),
  ].filter((v): v is string => Boolean(v));

  const extra = String(process.env.APP_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return [...fromEnv, ...extra];
}

/**
 * Hostnames allowed for this deployment (from configured public URLs +
 * optional APP_ALLOWED_HOSTS). Empty when nothing is configured beyond the
 * local-dev fallback — callers should treat that as "no production redirect".
 */
export function getAllowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const raw of configuredOriginStrings()) {
    const host = hostnameFromHostOrOrigin(raw);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export function isLoopbackOrLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local")
  );
}

export function isAllowedRequestHost(presentedHost: string | null | undefined): boolean {
  const hostname = hostnameFromHostOrOrigin(String(presentedHost || ""));
  if (!hostname) return false;
  if (isLoopbackOrLocalHostname(hostname)) return true;
  const allowed = getAllowedHosts().filter((h) => !isLoopbackOrLocalHostname(h));
  // No production hosts configured — do not treat arbitrary hosts as allowed.
  if (allowed.length === 0) return false;
  return allowed.includes(hostname);
}

/**
 * HTTPS redirect target for a cleartext request.
 * Uses the configured public base URL only — never the request Host header.
 * Returns null when redirecting would be unsafe or unnecessary.
 */
export function buildSafeHttpsRedirectUrl(
  pathWithSearch: string,
  presentedHost: string | null | undefined,
): string | null {
  const presentedHostname = hostnameFromHostOrOrigin(
    String(presentedHost || ""),
  );
  // Health checks and local cleartext should never be bounced to a public URL.
  if (!presentedHostname || isLoopbackOrLocalHostname(presentedHostname)) {
    return null;
  }
  if (!isAllowedRequestHost(presentedHost)) {
    return null;
  }

  let base: string;
  try {
    base = getAppBaseUrl();
  } catch {
    return null;
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(base.includes("://") ? base : `https://${base}`);
  } catch {
    return null;
  }

  if (isLoopbackOrLocalHostname(baseUrl.hostname)) {
    return null;
  }

  // Force https on the configured public origin.
  baseUrl.protocol = "https:";

  const path = pathWithSearch.startsWith("/")
    ? pathWithSearch
    : `/${pathWithSearch}`;
  return new URL(path, baseUrl).toString();
}

/**
 * Absolute URL for an in-app path from the configured public origin.
 * Prefer this over `new URL(path, request.url)` for redirects.
 */
export function safeAppPathUrl(pathWithSearch: string): string {
  const base = getAppBaseUrl();
  const path = pathWithSearch.startsWith("/")
    ? pathWithSearch
    : `/${pathWithSearch}`;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
