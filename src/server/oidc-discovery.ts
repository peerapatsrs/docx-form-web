export type OpenIdProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
};

type CacheEntry = {
  at: number;
  meta: OpenIdProviderMetadata;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export type DiscoveryFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

function discoveryUrl(issuer: string): string {
  const base = issuer.replace(/\/$/, "");
  return `${base}/.well-known/openid-configuration`;
}

/**
 * OIDC Discovery (RFC 8414). Cached briefly; never logs response bodies
 * (may contain nothing secret, but keep logs clean).
 */
export async function fetchOidcDiscovery(
  issuer: string,
  deps: { fetch?: DiscoveryFetch; now?: () => number; bypassCache?: boolean } = {},
): Promise<OpenIdProviderMetadata> {
  const key = issuer.replace(/\/$/, "");
  const now = deps.now ?? Date.now;
  const cached = cache.get(key);
  if (!deps.bypassCache && cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.meta;
  }

  const fetchFn = deps.fetch ?? fetch;
  const res = await fetchFn(discoveryUrl(key), {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "follow",
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
  const meta: OpenIdProviderMetadata = {
    issuer: String(raw.issuer).replace(/\/$/, ""),
    authorization_endpoint: String(raw.authorization_endpoint),
    token_endpoint: String(raw.token_endpoint),
    jwks_uri: String(raw.jwks_uri),
    userinfo_endpoint: raw.userinfo_endpoint
      ? String(raw.userinfo_endpoint)
      : undefined,
    end_session_endpoint: raw.end_session_endpoint
      ? String(raw.end_session_endpoint)
      : undefined,
    id_token_signing_alg_values_supported:
      raw.id_token_signing_alg_values_supported,
    code_challenge_methods_supported: raw.code_challenge_methods_supported,
  };
  // Issuer in discovery should match configured issuer (allow trailing-slash variance).
  if (meta.issuer.replace(/\/$/, "") !== key) {
    throw new Error("OIDC_DISCOVERY_ISSUER_MISMATCH");
  }
  cache.set(key, { at: now(), meta });
  return meta;
}

/** Test helper — clear discovery cache between cases. */
export function clearOidcDiscoveryCache(): void {
  cache.clear();
}
