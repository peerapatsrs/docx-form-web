import { serializeSignedCookie } from "better-call";
import {
  getOidcConfig,
  type OidcConfig,
} from "./oidc-config";
import {
  fetchOidcDiscovery,
  type OpenIdProviderMetadata,
  type DiscoveryFetch,
} from "./oidc-discovery";
import { createOidcAuthRequestSecrets } from "./oidc-pkce";
import {
  validateOidcIdToken,
  type OidcIdTokenClaims,
} from "./oidc-id-token";
import {
  consumeOidcLoginState,
  OidcEmailUnverifiedError,
  resolveUserForOidcClaims,
  safeOidcReturnTo,
  saveOidcLoginState,
  ensureOidcIdentitiesSchema,
} from "./oidc-identities";
import {
  bumpOidcFailState,
  oidcFailClearCookieHeader,
  oidcFailSetCookieHeader,
  parseOidcFailCookie,
} from "./oidc-login-guard";
import {
  oidcSsoCheckedSetCookie,
  oidcSsoSkipClearCookie,
} from "./oidc-silent";
import type { JSONWebKeySet } from "jose";

export const OIDC_ID_TOKEN_COOKIE = "docx_oidc_id_token";
export const OIDC_FLAG_COOKIE = "docx_oidc";

export type OidcTokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
};

function redactTokenForLog(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "[redacted]";
  return `${value.slice(0, 4)}…[redacted]`;
}

/** Never put tokens in URLs or log lines. */
export function summarizeOidcError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || "OIDC_ERROR";
    // Strip anything that looks like a JWT
    return msg.replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[jwt]",
    );
  }
  return "OIDC_ERROR";
}

export async function buildOidcAuthorizationRedirect(input: {
  returnTo?: string | null;
  /** Keycloak application-initiated action (e.g. webauthn-register-passwordless). */
  kcAction?: string | null;
  /** Override scopes (AIA uses `openid` only when set). */
  scopes?: string[];
  /** OIDC prompt — use `none` for silent SSO. */
  prompt?: "none" | null;
  /** Mark pending state as silent (quiet login_required). */
  silent?: boolean;
  config?: OidcConfig | null;
  fetchDiscovery?: DiscoveryFetch;
  /** Test seam — defaults to DB-backed saveOidcLoginState. */
  saveState?: typeof saveOidcLoginState;
  ensureSchema?: typeof ensureOidcIdentitiesSchema;
}): Promise<{
  ok: true;
  url: string;
  state: string;
} | { ok: false; status: number; error: string }> {
  const config = input.config === undefined ? getOidcConfig() : input.config;
  if (!config) {
    return { ok: false, status: 404, error: "OIDC_DISABLED" };
  }

  try {
    const ensureSchema = input.ensureSchema ?? ensureOidcIdentitiesSchema;
    const saveState = input.saveState ?? saveOidcLoginState;
    await ensureSchema();
    const meta = await fetchOidcDiscovery(config.issuer, {
      fetch: input.fetchDiscovery,
    });
    const secrets = createOidcAuthRequestSecrets();
    const silent = Boolean(input.silent) || input.prompt === "none";
    const returnTo = safeOidcReturnTo(
      input.returnTo,
      input.kcAction ? "/account" : "/",
    );
    await saveState({
      state: secrets.state,
      nonce: secrets.nonce,
      codeVerifier: secrets.codeVerifier,
      returnTo,
      silent,
    });

    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    const scopes =
      input.scopes && input.scopes.length > 0
        ? input.scopes
        : config.scopes;
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
      // Keycloak AIA — value may include `delete_credential:<id>`; URLSearchParams encodes safely.
      url.searchParams.set("kc_action", kcAction);
    }

    return { ok: true, url: url.toString(), state: secrets.state };
  } catch (err) {
    console.error("[oidc] authorize failed:", summarizeOidcError(err));
    return { ok: false, status: 502, error: "OIDC_AUTHORIZE_FAILED" };
  }
}

async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  config: OidcConfig;
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

export async function createAppSessionCookie(
  userId: string,
): Promise<{ setCookie: string; userId: string }> {
  const { auth } = await import("./auth");
  const ctx = await auth.$context;
  const full = await ctx.internalAdapter.findUserById(userId);
  if (!full) throw new Error("OIDC_USER_NOT_FOUND");
  const session = await ctx.internalAdapter.createSession(full.id, false);
  if (!session) throw new Error("OIDC_SESSION_FAILED");
  const setCookie = await serializeSignedCookie(
    ctx.authCookies.sessionToken.name,
    session.token,
    ctx.secret,
    {
      ...ctx.authCookies.sessionToken.attributes,
      maxAge: ctx.sessionConfig.expiresIn,
    },
  );
  return { setCookie, userId: full.id };
}

export async function clearAppSessionCookie(): Promise<string[]> {
  const { auth } = await import("./auth");
  const ctx = await auth.$context;
  const name = ctx.authCookies.sessionToken.name;
  // Expire session cookie (signed value empty).
  const expired = await serializeSignedCookie(name, "", ctx.secret, {
    ...ctx.authCookies.sessionToken.attributes,
    maxAge: 0,
  });
  return [expired];
}

function appendSetCookie(headers: Headers, value: string): void {
  headers.append("Set-Cookie", value);
}

function buildOidcSideCookies(
  idToken: string | undefined,
  secure: boolean,
): string[] {
  const out: string[] = [];
  const secureAttr = secure ? "; Secure" : "";
  const httpOnlyBase = `Path=/; HttpOnly; SameSite=Lax${secureAttr}`;
  // Non-HttpOnly flag so the client can prefer RP-initiated logout (no secrets).
  const flagBase = `Path=/; SameSite=Lax${secureAttr}`;
  if (idToken) {
    // Hint for RP-initiated logout only — never put in URLs/logs.
    out.push(
      `${OIDC_ID_TOKEN_COOKIE}=${encodeURIComponent(idToken)}; ${httpOnlyBase}; Max-Age=${60 * 60 * 24 * 7}`,
    );
  }
  out.push(`${OIDC_FLAG_COOKIE}=1; ${flagBase}; Max-Age=${60 * 60 * 24 * 7}`);
  return out;
}

function clearOidcSideCookies(secure: boolean): string[] {
  const secureAttr = secure ? "; Secure" : "";
  return [
    `${OIDC_ID_TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=0`,
    `${OIDC_FLAG_COOKIE}=; Path=/; SameSite=Lax${secureAttr}; Max-Age=0`,
  ];
}

export async function handleOidcCallback(input: {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  /** Keycloak AIA result: success | cancelled | error. */
  kcActionStatus?: string | null;
  config?: OidcConfig | null;
  fetchFn?: DiscoveryFetch;
  jwks?: JSONWebKeySet;
  createSession?: typeof createAppSessionCookie;
  /** Test seam — defaults to DB-backed consumeOidcLoginState. */
  consumeState?: typeof consumeOidcLoginState;
  /** Test seam — defaults to resolveUserForOidcClaims. */
  resolveUser?: typeof resolveUserForOidcClaims;
  /** Current docx_oidc_fail cookie (loop breaker). */
  failCookieRaw?: string | null;
}): Promise<{
  status: number;
  redirectTo: string;
  setCookies: string[];
  error?: string;
}> {
  const { appendOidcPasskeyStatusParam, normalizeKcActionStatus } =
    await import("./oidc-passkey");
  const config = input.config === undefined ? getOidcConfig() : input.config;
  const secure = process.env.NODE_ENV === "production";
  const kcStatus = normalizeKcActionStatus(input.kcActionStatus);
  const consumeState = input.consumeState ?? consumeOidcLoginState;
  const resolveUser = input.resolveUser ?? resolveUserForOidcClaims;
  const failBumpCookie = () =>
    oidcFailSetCookieHeader(
      bumpOidcFailState(parseOidcFailCookie(input.failCookieRaw)),
      secure,
    );
  if (!config) {
    return {
      status: 404,
      redirectTo: "/login?error=oidc_disabled",
      setCookies: [failBumpCookie()],
      error: "OIDC_DISABLED",
    };
  }
  const code = String(input.code || "").trim();
  const state = String(input.state || "").trim();

  const quietSilentFail = (returnTo: string, error: string) => {
    console.error("[oidc] silent SSO quiet fail:", error);
    return {
      status: 302,
      redirectTo: safeOidcReturnTo(returnTo, "/"),
      setCookies: [oidcSsoCheckedSetCookie(secure)],
      error,
    };
  };

  // IdP error: silent (prompt=none) → stay logged out quietly; interactive → Thai error page.
  if (input.error && !kcStatus) {
    if (state) {
      const pending = await consumeState(state).catch(() => null);
      if (pending?.silent) {
        return quietSilentFail(
          pending.returnTo,
          String(input.error).slice(0, 128),
        );
      }
      return {
        status: 302,
        redirectTo: `/login?error=oidc_${encodeURIComponent(String(input.error).slice(0, 64))}`,
        setCookies: [failBumpCookie()],
        error: String(input.error),
      };
    }
    // No state — cannot tell; land home quietly with checked cookie (no loop).
    return quietSilentFail("/", String(input.error).slice(0, 128));
  }

  // AIA cancelled/error without code: still return to settings with status.
  if (!code && kcStatus && state) {
    const pending = await consumeState(state).catch(() => null);
    const base = safeOidcReturnTo(pending?.returnTo, "/account");
    return {
      status: 302,
      redirectTo: appendOidcPasskeyStatusParam(base, kcStatus),
      setCookies: [],
    };
  }
  if (!code && kcStatus) {
    return {
      status: 302,
      redirectTo: appendOidcPasskeyStatusParam("/account", kcStatus),
      setCookies: [],
    };
  }

  if (!code || !state) {
    if (state) {
      const pending = await consumeState(state).catch(() => null);
      if (pending?.silent) {
        return quietSilentFail(pending.returnTo, "OIDC_MISSING_CODE");
      }
    }
    return {
      status: 302,
      redirectTo: "/login?error=oidc_missing_code",
      setCookies: [failBumpCookie()],
      error: "OIDC_MISSING_CODE",
    };
  }

  let silentReturnTo: string | null = null;
  try {
    const pending = await consumeState(state);
    if (!pending) {
      return {
        status: 302,
        redirectTo: "/login?error=oidc_state_invalid",
        setCookies: [failBumpCookie()],
        error: "OIDC_STATE_INVALID",
      };
    }
    if (pending.silent) {
      silentReturnTo = pending.returnTo;
    }

    const meta = await fetchOidcDiscovery(config.issuer, {
      fetch: input.fetchFn,
    });
    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: pending.codeVerifier,
      config,
      meta,
      fetchFn: input.fetchFn,
    });
    const idToken = String(tokens.id_token || "").trim();
    if (!idToken) {
      throw new Error("OIDC_MISSING_ID_TOKEN");
    }

    const claims: OidcIdTokenClaims = await validateOidcIdToken({
      idToken,
      issuer: config.issuer,
      clientId: config.clientId,
      nonce: pending.nonce,
      jwksUri: meta.jwks_uri,
      jwks: input.jwks,
    });

    const { userId } = await resolveUser(claims);
    const createSession = input.createSession ?? createAppSessionCookie;
    const session = await createSession(userId);
    const setCookies = [
      session.setCookie,
      ...buildOidcSideCookies(idToken, secure),
      oidcFailClearCookieHeader(secure),
      oidcSsoCheckedSetCookie(secure),
      oidcSsoSkipClearCookie(secure),
    ];

    let redirectTo = safeOidcReturnTo(pending.returnTo, "/");
    if (kcStatus) {
      redirectTo = appendOidcPasskeyStatusParam(
        safeOidcReturnTo(pending.returnTo, "/account"),
        kcStatus,
      );
    }

    return {
      status: 302,
      redirectTo,
      setCookies,
    };
  } catch (err) {
    console.error("[oidc] callback failed:", summarizeOidcError(err));
    // Avoid leaking token material even in truncated form.
    void redactTokenForLog;
    if (silentReturnTo !== null) {
      return quietSilentFail(silentReturnTo, summarizeOidcError(err));
    }
    const failCookie = failBumpCookie();
    if (err instanceof OidcEmailUnverifiedError || (err as { code?: string })?.code === "OIDC_EMAIL_UNVERIFIED") {
      return {
        status: 302,
        redirectTo: "/login?error=oidc_email_unverified",
        setCookies: [...clearOidcSideCookies(secure), failCookie],
        error: "OIDC_EMAIL_UNVERIFIED",
      };
    }
    if (kcStatus) {
      return {
        status: 302,
        redirectTo: appendOidcPasskeyStatusParam("/account", "error"),
        setCookies: [...clearOidcSideCookies(secure), failCookie],
        error: summarizeOidcError(err),
      };
    }
    return {
      status: 302,
      redirectTo: "/login?error=oidc_callback_failed",
      setCookies: [...clearOidcSideCookies(secure), failCookie],
      error: summarizeOidcError(err),
    };
  }
}

export async function buildOidcLogoutRedirect(input: {
  idTokenHint?: string | null;
  config?: OidcConfig | null;
  fetchFn?: DiscoveryFetch;
  clearSession?: typeof clearAppSessionCookie;
}): Promise<{
  status: number;
  redirectTo: string;
  setCookies: string[];
}> {
  const config = input.config === undefined ? getOidcConfig() : input.config;
  const secure = process.env.NODE_ENV === "production";
  const clearSession = input.clearSession ?? clearAppSessionCookie;
  const sessionCookies = await clearSession().catch(() => [] as string[]);
  const setCookies = [...sessionCookies, ...clearOidcSideCookies(secure)];

  if (!config) {
    return {
      status: 302,
      redirectTo: "/login",
      setCookies,
    };
  }

  try {
    const meta = await fetchOidcDiscovery(config.issuer, {
      fetch: input.fetchFn,
    });
    if (!meta.end_session_endpoint) {
      return {
        status: 302,
        redirectTo: config.postLogoutRedirectUri,
        setCookies,
      };
    }
    const url = new URL(meta.end_session_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set(
      "post_logout_redirect_uri",
      config.postLogoutRedirectUri,
    );
    const hint = String(input.idTokenHint || "").trim();
    if (hint) {
      // id_token_hint is a form/query param to the IdP — required by OIDC RP logout.
      // We never log it and never echo it back into our app URLs.
      url.searchParams.set("id_token_hint", hint);
    }
    return {
      status: 302,
      redirectTo: url.toString(),
      setCookies,
    };
  } catch (err) {
    console.error("[oidc] logout discovery failed:", summarizeOidcError(err));
    return {
      status: 302,
      redirectTo: config.postLogoutRedirectUri,
      setCookies,
    };
  }
}

export function readCookie(
  cookieHeader: string | null,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

export function applyOidcSetCookies(
  headers: Headers,
  cookies: string[],
): void {
  for (const c of cookies) appendSetCookie(headers, c);
}
