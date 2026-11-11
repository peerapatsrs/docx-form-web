import type { ResolvedAuthConfig } from "./config.js";
import { createOidcAuthRequestSecrets } from "./pkce.js";
import { fetchOidcDiscovery } from "./discovery.js";
import { safeReturnTo } from "./safe-return.js";
import type { DiscoveryFetch, OpenIdProviderMetadata } from "./types.js";
import type { StateStore } from "./interfaces.js";

export type BuildAuthorizeInput = {
  config: ResolvedAuthConfig;
  stateStore: StateStore;
  returnTo?: string | null;
  /** Keycloak application-initiated action. */
  kcAction?: string | null;
  scopes?: string[];
  prompt?: "none" | null;
  silent?: boolean;
  viaBypass?: boolean;
  /** Optional kc_idp_hint. */
  kcIdpHint?: string | null;
  fetchDiscovery?: DiscoveryFetch;
  now?: () => number;
  meta?: OpenIdProviderMetadata;
};

export type BuildAuthorizeResult =
  | { ok: true; url: string; state: string }
  | { ok: false; status: number; error: string };

/**
 * Build authorization redirect (auth-code + PKCE S256).
 * Never sets max_age or prompt=login.
 */
export async function buildAuthorizationRedirect(
  input: BuildAuthorizeInput,
): Promise<BuildAuthorizeResult> {
  try {
    const meta =
      input.meta ??
      (await fetchOidcDiscovery(input.config.issuer, {
        fetch: input.fetchDiscovery,
        now: input.now,
      }));
    const secrets = await createOidcAuthRequestSecrets();
    const silent = Boolean(input.silent) || input.prompt === "none";
    const returnTo = safeReturnTo(
      input.returnTo,
      input.kcAction ? "/" : "/",
      input.config.publicOrigin,
    );
    const nowMs = (input.now ?? Date.now)();
    await input.stateStore.save({
      state: secrets.state,
      nonce: secrets.nonce,
      codeVerifier: secrets.codeVerifier,
      returnTo,
      silent,
      viaBypass: Boolean(input.viaBypass),
      kcAction: input.kcAction ?? null,
      expiresAt: nowMs + input.config.stateTtlSec * 1000,
    });

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.config.clientId);
    url.searchParams.set("redirect_uri", input.config.redirectUri);
    const scopes =
      input.scopes && input.scopes.length > 0
        ? input.scopes
        : input.kcAction
          ? ["openid"]
          : input.config.scopes;
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", secrets.state);
    url.searchParams.set("nonce", secrets.nonce);
    url.searchParams.set("code_challenge", secrets.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    if (input.prompt === "none") {
      url.searchParams.set("prompt", "none");
    }

    const kcAction = String(input.kcAction || "").trim();
    if (kcAction) {
      url.searchParams.set("kc_action", kcAction);
    }

    const hint = String(
      input.kcIdpHint ?? input.config.kcIdpHint ?? "",
    ).trim();
    if (hint && !kcAction) {
      url.searchParams.set("kc_idp_hint", hint);
    }

    return { ok: true, url: url.toString(), state: secrets.state };
  } catch {
    return { ok: false, status: 502, error: "OIDC_AUTHORIZE_FAILED" };
  }
}
