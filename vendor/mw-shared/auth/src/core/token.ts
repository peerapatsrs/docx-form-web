import type { ResolvedAuthConfig } from "./config.js";
import type {
  DiscoveryFetch,
  OidcTokenResponse,
  OpenIdProviderMetadata,
} from "./types.js";

export async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  config: ResolvedAuthConfig;
  meta: OpenIdProviderMetadata;
  fetchFn?: DiscoveryFetch;
}): Promise<OidcTokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", input.code);
  body.set("redirect_uri", input.config.redirectUri);
  body.set("client_id", input.config.clientId);
  body.set("client_secret", input.config.clientSecret);
  body.set("code_verifier", input.codeVerifier);

  const fetchFn = input.fetchFn ?? fetch;
  const res = await fetchFn(input.meta.token_endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`OIDC_TOKEN_HTTP_${res.status}`);
  }
  return (await res.json()) as OidcTokenResponse;
}

export function buildEndSessionUrl(input: {
  endSessionEndpoint: string;
  clientId: string;
  postLogoutRedirectUri: string;
  /**
   * Only attach when the id_token is still fresh. Stale hints make Keycloak
   * show a logout confirmation page — omit and send client_id + post_logout only.
   */
  idTokenHint?: string | null;
}): string {
  const url = new URL(input.endSessionEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set(
    "post_logout_redirect_uri",
    input.postLogoutRedirectUri,
  );
  if (input.idTokenHint) {
    url.searchParams.set("id_token_hint", input.idTokenHint);
  }
  return url.toString();
}
