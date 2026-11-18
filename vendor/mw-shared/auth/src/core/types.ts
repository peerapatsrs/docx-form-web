/** Runtime configuration — never read from import-time env. */
export type MwAuthConfig = {
  /** OIDC issuer URL, e.g. https://auth.example/realms/{env} (no trailing slash required). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Absolute public origin of this app, e.g. https://app.example. */
  publicOrigin: string;
  /** Absolute callback URL. Default: `{publicOrigin}{paths.callback}`. */
  redirectUri?: string;
  /** Absolute post-logout redirect. Default: `{publicOrigin}{paths.postLogout}`. */
  postLogoutRedirectUri?: string;
  scopes?: string[];
  /** Cookie name for silent SSO cooldown. Default: `mw_sso_checked`. */
  cooldownCookieName?: string;
  /** Cookie name for RP id_token_hint. Default: `mw_oidc_id_token`. */
  idTokenCookieName?: string;
  /** Optional non-HttpOnly flag cookie. Default: `mw_oidc`. */
  oidcFlagCookieName?: string;
  /** Cooldown window seconds. Default: 60. */
  cooldownSec?: number;
  /** Hub origins allowed to bypass cooldown via Referer. Absolute origins only. */
  hubOrigins?: string[];
  /** Clock skew for JWT iat/exp checks (seconds). Default: 60. */
  clockToleranceSec?: number;
  /**
   * RP logout: include `id_token_hint` only while `exp > now - freshnessSec`.
   * When stale/missing, omit the hint (client_id + post_logout_redirect_uri only)
   * so Keycloak does not show its logout confirmation page.
   * Default: same as `clockToleranceSec`.
   */
  idTokenHintFreshnessSec?: number;
  /** Login-state TTL seconds. Default: 600. */
  stateTtlSec?: number;
  /** Passkey add AIA. Default: webauthn-register-passwordless. */
  passkeyAddAction?: string;
  /** Whether Secure cookie attribute is set. Default: true when publicOrigin is https. */
  secureCookies?: boolean;
  /** Route path overrides (relative, starting with /). */
  paths?: Partial<MwAuthPaths>;
  /** Optional IdP hint for Keycloak social brokers. */
  kcIdpHint?: string | null;
  /** Allowed algorithms for logout_token / id_token. Default: RS256, ES256. */
  allowedJwtAlgs?: ReadonlyArray<"RS256" | "ES256">;
};

export type MwAuthPaths = {
  login: string;
  silent: string;
  silentLand: string;
  callback: string;
  logout: string;
  backchannelLogout: string;
  passkeyAdd: string;
  passkeyRemove: string;
  postLogout: string;
};

export type OpenIdProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  backchannel_logout_supported?: boolean;
  backchannel_logout_session_supported?: boolean;
};

export type OidcIdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  sid?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  picture?: string;
};

export type OidcTokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
};

export type AuthRequestSecrets = {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
};

export type PendingAuthState = {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  silent: boolean;
  viaBypass?: boolean;
  kcAction?: string | null;
  expiresAt: number;
};

export type SessionRecord = {
  /** Opaque local session id / token. */
  sessionId: string;
  /** App user id. */
  userId: string;
  /** OIDC subject. */
  sub: string;
  /** OIDC session id from id_token (for back-channel logout). */
  sid?: string | null;
  /** Raw id_token for RP-initiated logout hint (optional). */
  idToken?: string | null;
  expiresAt?: number | null;
  metadata?: Record<string, unknown>;
};

export type ResolvedUser = {
  userId: string;
  linkedBy: "identity" | "email" | "created";
  email?: string | null;
  isNew?: boolean;
};

export type CookieJarEntry = {
  name: string;
  value: string;
  attributes: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    maxAge?: number;
  };
};

export type AuthFlowResult = {
  status: number;
  redirectTo?: string | null;
  body?: string | null;
  contentType?: string;
  setCookies?: CookieJarEntry[];
  clearCookies?: CookieJarEntry[];
  headers?: Record<string, string>;
  error?: string;
};

export type SilentSsoStartDecision = {
  start: boolean;
  viaBypass: boolean;
  /** True when ?sso=1 was present but bypass refused — caller should strip it. */
  stripSsoParam?: boolean;
};

export type SessionValidationResult = {
  hasSession: boolean;
  session?: SessionRecord | null;
  /** Expire these cookies (forged / definitive miss). Empty on store errors (fail-safe). */
  clearCookies: CookieJarEntry[];
  /** True when store threw — keep cookie, do not silent-SSO. */
  storeError?: boolean;
};

export type SilentSuccessHookContext = {
  userId: string;
  sub: string;
  returnTo: string;
  session: SessionRecord;
};

export type DiscoveryFetch = typeof fetch;
