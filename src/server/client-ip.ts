/**
 * Trustworthy client IP resolution for rate limiting behind reverse proxies.
 *
 * Optionally trusts an edge connecting-IP header when enabled via env, then
 * falls back to X-Forwarded-For using a configurable hop count from the right
 * (not the spoofable leftmost value). Unknown addresses map to a shared
 * sentinel IP so rate limits still apply.
 */

import { isIP } from "node:net";

export function isValidIp(ip: string): boolean {
  return isIP(ip.trim()) !== 0;
}

/**
 * Shared bucket when no client IP can be resolved.
 * Must be a valid IP so Better Auth accepts it as a rate-limit key.
 */
export const UNKNOWN_CLIENT_IP = "0.0.0.0";

const DEFAULT_TRUSTED_PROXY_COUNT = 1;
const CF_CONNECTING_IP = "cf-connecting-ip";

function envFlagEnabled(value: string | undefined): boolean {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether to trust cf-connecting-ip.
 * Env: TRUST_CF_CONNECTING_IP. Default off — only enable when the edge
 * overwrites this header (e.g. Cloudflare in front); otherwise clients can spoof it.
 */
export function trustCfConnectingIp(
  envValue: string | undefined = process.env.TRUST_CF_CONNECTING_IP,
): boolean {
  return envFlagEnabled(envValue);
}

/** Preferred IP headers before X-Forwarded-For (empty unless CF trust is on). */
export function getPreferredIpHeaders(
  trustCf: boolean = trustCfConnectingIp(),
): string[] {
  return trustCf ? [CF_CONNECTING_IP] : [];
}

/** Header list for Better Auth advanced.ipAddress.ipAddressHeaders. */
export function getIpAddressHeaders(
  trustCf: boolean = trustCfConnectingIp(),
): string[] {
  return [...getPreferredIpHeaders(trustCf), "x-forwarded-for"];
}

/**
 * Number of trusted reverse-proxy hops to skip from the right of X-Forwarded-For.
 * Env: TRUSTED_PROXY_COUNT (non-negative integer). Default 1.
 */
export function getTrustedProxyCount(
  envValue: string | undefined = process.env.TRUSTED_PROXY_COUNT,
): number {
  const raw = String(envValue ?? "").trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_COUNT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRUSTED_PROXY_COUNT;
  return n;
}

/**
 * Pick the client address from an X-Forwarded-For chain.
 * Counts `trustedProxyCount` hops from the right; does not use the leftmost
 * token (client-controlled when proxies append).
 */
export function clientIpFromXForwardedFor(
  value: string,
  trustedProxyCount: number,
): string | null {
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const hops = Math.max(0, Math.floor(trustedProxyCount));

  // No trusted hops: only a single-value header is trustworthy.
  if (hops === 0) {
    if (parts.length !== 1) return null;
    return isValidIp(parts[0]!) ? parts[0]! : null;
  }

  // Express-style: client sits hops entries from the right.
  const index = parts.length - hops;
  if (index < 0) return null;
  const ip = parts[index]!;
  return isValidIp(ip) ? ip : null;
}

export type ResolveClientIpOptions = {
  trustedProxyCount?: number;
  /** When set, overrides env for whether cf-connecting-ip is trusted. */
  trustCfConnectingIp?: boolean;
  /** Header names checked before X-Forwarded-For (first match wins). */
  preferredHeaders?: string[];
};

/**
 * Resolve the client IP from request headers.
 * Returns null when no trustworthy address is available.
 */
export function resolveClientIp(
  headers: Headers,
  options: ResolveClientIpOptions = {},
): string | null {
  const trustCf = options.trustCfConnectingIp ?? trustCfConnectingIp();
  const preferred =
    options.preferredHeaders ?? getPreferredIpHeaders(trustCf);

  for (const name of preferred) {
    const raw = headers.get(name);
    if (typeof raw !== "string") continue;
    // Preferred headers are expected to be single-valued (edge-set).
    const ip = raw.split(",")[0]?.trim();
    if (ip && isValidIp(ip)) return ip;
  }

  const xff = headers.get("x-forwarded-for");
  if (typeof xff === "string" && xff.trim()) {
    const count = options.trustedProxyCount ?? getTrustedProxyCount();
    return clientIpFromXForwardedFor(xff, count);
  }

  return null;
}

/**
 * Rate-limit key material: never return an empty key that would skip limiting.
 */
export function rateLimitClientIp(ip: string | null | undefined): string {
  const trimmed = typeof ip === "string" ? ip.trim() : "";
  return trimmed && isValidIp(trimmed) ? trimmed : UNKNOWN_CLIENT_IP;
}

/**
 * Rewrite forwarded headers so Better Auth sees a single trustworthy IP.
 * Collapses multi-hop X-Forwarded-For to one value. When resolution fails,
 * sets X-Forwarded-For to {@link UNKNOWN_CLIENT_IP} so rate limits still bind
 * to a shared bucket (fail closed) instead of skipping or using a spoofable header.
 */
export function withResolvedClientIpHeaders(
  request: Request,
  options: ResolveClientIpOptions = {},
): Request {
  const trustCf = options.trustCfConnectingIp ?? trustCfConnectingIp();
  const preferred =
    options.preferredHeaders ?? getPreferredIpHeaders(trustCf);
  const resolved = resolveClientIp(request.headers, {
    ...options,
    trustCfConnectingIp: trustCf,
    preferredHeaders: preferred,
  });
  const ip = rateLimitClientIp(resolved);
  const headers = new Headers(request.headers);

  // Drop spoofable edge headers unless we intentionally trusted and used one.
  for (const name of [CF_CONNECTING_IP, "x-real-ip"]) {
    headers.delete(name);
  }

  if (resolved && preferred.length > 0) {
    for (const name of preferred) {
      const raw = request.headers.get(name);
      if (typeof raw !== "string") continue;
      const candidate = raw.split(",")[0]?.trim();
      if (candidate && isValidIp(candidate) && candidate === resolved) {
        headers.set(name, resolved);
        break;
      }
    }
  }

  // Always a single-value XFF Better Auth can trust (real client or sentinel).
  headers.set("x-forwarded-for", ip);

  return new Request(request, { headers });
}
