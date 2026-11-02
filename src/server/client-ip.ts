/**
 * Trustworthy client IP resolution for rate limiting behind reverse proxies.
 *
 * Prefers an edge-set connecting-IP header, then falls back to X-Forwarded-For
 * using a configurable hop count from the right (not the spoofable leftmost
 * value). Unknown / unresolvable addresses must not bypass per-IP limits.
 */

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Basic IPv6 check — full RFC validation is unnecessary for header picking. */
function looksLikeIPv6(ip: string): boolean {
  if (!ip.includes(":")) return false;
  if (ip.length < 2 || ip.length > 45) return false;
  // Reject obvious junk; allow compressed forms and IPv4-mapped.
  return /^[0-9a-fA-F:.]+$/.test(ip) && (ip.match(/:/g) || []).length >= 2;
}

export function isValidIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;
  if (IPV4.test(trimmed)) return true;
  return looksLikeIPv6(trimmed);
}

/** Shared bucket key when no client IP can be resolved — fail closed. */
export const UNKNOWN_CLIENT_IP = "unknown";

const DEFAULT_TRUSTED_PROXY_COUNT = 1;

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

  // Express-style: client sits hops entries from the right (rightmost = last proxy's view of the peer when hops=1).
  const index = parts.length - hops;
  if (index < 0) return null;
  const ip = parts[index]!;
  return isValidIp(ip) ? ip : null;
}

export type ResolveClientIpOptions = {
  trustedProxyCount?: number;
  /** Header names checked before X-Forwarded-For (first match wins). */
  preferredHeaders?: string[];
};

const DEFAULT_PREFERRED = ["cf-connecting-ip"];

/**
 * Resolve the client IP from request headers.
 * Returns null when no trustworthy address is available.
 */
export function resolveClientIp(
  headers: Headers,
  options: ResolveClientIpOptions = {},
): string | null {
  const preferred = options.preferredHeaders ?? DEFAULT_PREFERRED;
  for (const name of preferred) {
    const raw = headers.get(name);
    if (typeof raw !== "string") continue;
    // Preferred headers are expected to be single-valued (edge-set).
    const ip = raw.split(",")[0]?.trim();
    if (ip && isValidIp(ip)) return ip;
  }

  const xff = headers.get("x-forwarded-for");
  if (typeof xff === "string" && xff.trim()) {
    const count =
      options.trustedProxyCount ?? getTrustedProxyCount();
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
 * Collapses multi-hop X-Forwarded-For to one value; clears headers when
 * resolution fails so limits fall back to a shared bucket (fail closed).
 */
export function withResolvedClientIpHeaders(
  request: Request,
  options: ResolveClientIpOptions = {},
): Request {
  const ip = resolveClientIp(request.headers, options);
  const headers = new Headers(request.headers);

  if (ip) {
    const preferred = options.preferredHeaders ?? DEFAULT_PREFERRED;
    let fromPreferred = false;
    for (const name of preferred) {
      const raw = request.headers.get(name);
      if (typeof raw !== "string") continue;
      const candidate = raw.split(",")[0]?.trim();
      if (candidate && isValidIp(candidate)) {
        headers.set(name, ip);
        fromPreferred = true;
        break;
      }
    }
    // Single-value XFF so Better Auth does not reject multi-hop chains.
    headers.set("x-forwarded-for", ip);
    if (!fromPreferred) {
      for (const name of preferred) headers.delete(name);
    }
  } else {
    for (const name of options.preferredHeaders ?? DEFAULT_PREFERRED) {
      headers.delete(name);
    }
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
  }

  return new Request(request, { headers });
}
