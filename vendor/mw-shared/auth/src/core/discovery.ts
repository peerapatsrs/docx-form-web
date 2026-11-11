import type { DiscoveryFetch, OpenIdProviderMetadata } from "./types.js";

type CacheEntry = {
  meta: OpenIdProviderMetadata;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function cacheKey(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

export function clearOidcDiscoveryCache(): void {
  cache.clear();
}

/**
 * Fetch OpenID Provider Metadata (RFC 8414).
 * Cache is module-scoped but keyed by issuer — no env reads.
 * Callers should prefer injecting `fetch` for tests / workerd.
 */
export async function fetchOidcDiscovery(
  issuer: string,
  opts: {
    fetch?: DiscoveryFetch;
    now?: () => number;
    bypassCache?: boolean;
    ttlMs?: number;
  } = {},
): Promise<OpenIdProviderMetadata> {
  const key = cacheKey(issuer);
  const now = opts.now ?? Date.now;
  const nowMs = now();
  if (!opts.bypassCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.meta;
  }

  const fetchFn = opts.fetch ?? fetch;
  const url = `${key}/.well-known/openid-configuration`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OIDC_DISCOVERY_HTTP_${res.status}`);
  }
  const raw = (await res.json()) as Partial<OpenIdProviderMetadata>;
  if (
    !raw.issuer ||
    !raw.authorization_endpoint ||
    !raw.token_endpoint ||
    !raw.jwks_uri
  ) {
    throw new Error("OIDC_DISCOVERY_INCOMPLETE");
  }
  const metaIssuer = String(raw.issuer).replace(/\/$/, "");
  if (metaIssuer !== key) {
    throw new Error("OIDC_DISCOVERY_ISSUER_MISMATCH");
  }

  const meta: OpenIdProviderMetadata = {
    issuer: metaIssuer,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    jwks_uri: raw.jwks_uri,
    end_session_endpoint: raw.end_session_endpoint,
    backchannel_logout_supported: raw.backchannel_logout_supported,
    backchannel_logout_session_supported:
      raw.backchannel_logout_session_supported,
  };

  cache.set(key, {
    meta,
    expiresAt: nowMs + (opts.ttlMs ?? DEFAULT_TTL_MS),
  });
  return meta;
}
