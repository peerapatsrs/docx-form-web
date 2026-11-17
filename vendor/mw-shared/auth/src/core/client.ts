import { resolveAuthConfig, type ResolvedAuthConfig } from "./config.js";
import type { MwAuthConfig } from "./types.js";
import type { MwAuthDeps, Logger } from "./interfaces.js";
import { createConsoleLogger, noopLogger, summarizeOidcError } from "./logger.js";
import { buildAuthorizationRedirect } from "./authorize.js";
import { fetchOidcDiscovery, clearOidcDiscoveryCache } from "./discovery.js";
import { exchangeAuthorizationCode, buildEndSessionUrl } from "./token.js";
import { isIdTokenFreshForHint } from "./jwt-payload.js";
import { validateOidcIdToken } from "./id-token.js";
import { validateLogoutToken } from "./logout-token.js";
import {
  buildCooldownState,
  buildSilentLandPath,
  isTopLevelDocumentNavigation,
  normalizeSilentOutcome,
  parseCooldownCookie,
  resolveSilentSsoStart,
  serializeCooldownValue,
} from "./silent-sso.js";
import {
  createSessionId,
  deleteSessionsBySidOrSub,
  sessionCookie,
  validateSession,
} from "./session.js";
import {
  buildOidcPasskeyDeleteAction,
  getOidcPasskeyAddAction,
  validateOidcPasskeyCredentialId,
} from "./passkey.js";
import { expireCookie, readCookie } from "./cookies.js";
import {
  hasSsoBypassQuery,
  safeReturnTo,
  stripSsoBypassParam,
} from "./safe-return.js";
import type {
  AuthFlowResult,
  CookieJarEntry,
  DiscoveryFetch,
  SessionRecord,
  SilentSsoStartDecision,
} from "./types.js";
import type { JSONWebKeySet } from "jose";

async function fetchJwks(
  jwksUri: string,
  fetchFn: DiscoveryFetch,
): Promise<JSONWebKeySet> {
  const res = await fetchFn(jwksUri, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OIDC_JWKS_HTTP_${res.status}`);
  return (await res.json()) as JSONWebKeySet;
}

export type CreateAuthClientOptions = {
  config: MwAuthConfig;
  deps: MwAuthDeps;
  /** Local session cookie name. Default: mw_session. */
  sessionCookieName?: string;
  /** Session max-age seconds. Default: 7 days. */
  sessionMaxAgeSec?: number;
};

function cookieEntry(
  name: string,
  value: string,
  opts: {
    secure: boolean;
    httpOnly?: boolean;
    maxAge: number;
  },
): CookieJarEntry {
  return {
    name,
    value,
    attributes: {
      path: "/",
      httpOnly: opts.httpOnly ?? true,
      secure: opts.secure,
      sameSite: "Lax",
      maxAge: opts.maxAge,
    },
  };
}

/**
 * Framework-agnostic OIDC auth client.
 * All config is passed at construction — no import-time env reads.
 */
export class MwAuthClient {
  readonly config: ResolvedAuthConfig;
  readonly deps: MwAuthDeps;
  readonly sessionCookieName: string;
  readonly sessionMaxAgeSec: number;
  readonly logger: Logger;

  constructor(opts: CreateAuthClientOptions) {
    this.config = resolveAuthConfig(opts.config);
    this.deps = opts.deps;
    this.sessionCookieName = opts.sessionCookieName || "mw_session";
    this.sessionMaxAgeSec = opts.sessionMaxAgeSec ?? 60 * 60 * 24 * 7;
    this.logger = opts.deps.logger ?? createConsoleLogger();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private fetchFn(): DiscoveryFetch {
    return this.deps.fetch ?? fetch;
  }

  cooldownSetCookie(input: {
    pending: boolean;
    bypassUsed: boolean;
    previous?: string | null;
  }): CookieJarEntry {
    const previous = parseCooldownCookie(input.previous);
    const state = buildCooldownState({
      nowMs: this.now(),
      cooldownSec: this.config.cooldownSec,
      pending: input.pending,
      bypassUsed: input.bypassUsed,
      previous,
    });
    const maxAge = Math.max(
      1,
      Math.ceil((state.until - this.now()) / 1000),
    );
    return cookieEntry(
      this.config.cooldownCookieName,
      serializeCooldownValue(state),
      { secure: this.config.secureCookies, maxAge },
    );
  }

  cooldownClearCookie(): CookieJarEntry {
    return expireCookie(this.config.cooldownCookieName, {
      secure: this.config.secureCookies,
      httpOnly: true,
    });
  }

  /** Decide silent SSO for a document navigation. */
  decideSilentSso(input: {
    pathname: string;
    search?: string;
    hasSession: boolean;
    cooldownCookie?: string | null;
    referer?: string | null;
    headers?: Headers | Record<string, string | null | undefined>;
  }): SilentSsoStartDecision {
    const h = input.headers;
    const get = (name: string): string | null => {
      if (!h) return null;
      if (typeof (h as Headers).get === "function") {
        return (h as Headers).get(name);
      }
      const rec = h as Record<string, string | null | undefined>;
      return (
        rec[name] ??
        rec[name.toLowerCase()] ??
        null
      );
    };

    const isDoc = isTopLevelDocumentNavigation({
      accept: get("accept"),
      secFetchDest: get("sec-fetch-dest"),
      secFetchMode: get("sec-fetch-mode"),
      rscHeader: get("rsc"),
      nextRouterPrefetch: get("next-router-prefetch"),
      purpose: get("purpose"),
      pathname: input.pathname,
      search: input.search,
    });

    return resolveSilentSsoStart({
      pathname: input.pathname,
      search: input.search,
      hasSession: input.hasSession,
      cooldownCookie: input.cooldownCookie,
      nowMs: this.now(),
      cooldownSec: this.config.cooldownSec,
      hubOrigins: this.config.hubOrigins,
      referer: input.referer,
      oidcEnabled: true,
      isDocumentNavigation: isDoc,
    });
  }

  async startInteractiveLogin(input: {
    returnTo?: string | null;
    kcIdpHint?: string | null;
  } = {}): Promise<AuthFlowResult> {
    const built = await buildAuthorizationRedirect({
      config: this.config,
      stateStore: this.deps.state,
      returnTo: input.returnTo,
      silent: false,
      prompt: null,
      kcIdpHint: input.kcIdpHint,
      fetchDiscovery: this.fetchFn(),
      now: () => this.now(),
    });
    if (!built.ok) {
      return { status: built.status, error: built.error, body: built.error };
    }
    return {
      status: 302,
      redirectTo: built.url,
      clearCookies: [this.cooldownClearCookie()],
    };
  }

  async startSilentLogin(input: {
    returnTo?: string | null;
    viaBypass?: boolean;
    cooldownCookie?: string | null;
  } = {}): Promise<AuthFlowResult> {
    this.logger.log("info", "silent", {
      viaBypass: Boolean(input.viaBypass),
    });
    const built = await buildAuthorizationRedirect({
      config: this.config,
      stateStore: this.deps.state,
      returnTo: stripSsoBypassParam(
        safeReturnTo(input.returnTo, "/", this.config.publicOrigin),
      ),
      silent: true,
      prompt: "none",
      viaBypass: input.viaBypass,
      fetchDiscovery: this.fetchFn(),
      now: () => this.now(),
    });
    if (!built.ok) {
      return { status: built.status, error: built.error, body: built.error };
    }
    return {
      status: 302,
      redirectTo: built.url,
      setCookies: [
        this.cooldownSetCookie({
          pending: true,
          bypassUsed: Boolean(input.viaBypass),
          previous: input.cooldownCookie,
        }),
      ],
      headers: { "Referrer-Policy": "no-referrer" },
    };
  }

  async handleCallback(input: {
    url: string | URL;
    cookieHeader?: string | null;
  }): Promise<AuthFlowResult> {
    const url = typeof input.url === "string" ? new URL(input.url) : input.url;
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const kcActionStatus = url.searchParams.get("kc_action_status");
    const cooldownRaw = readCookie(
      input.cookieHeader,
      this.config.cooldownCookieName,
    );

    const quietSilentFail = (
      returnTo: string,
      errCode: string,
      viaBypass: boolean,
    ): AuthFlowResult => {
      const land = buildSilentLandPath(
        returnTo,
        this.config.paths.silentLand,
      );
      normalizeSilentOutcome(errCode); // login_required / interaction_required → quiet
      return {
        status: 302,
        redirectTo: land,
        setCookies: [
          this.cooldownSetCookie({
            pending: false,
            bypassUsed: viaBypass,
            previous: cooldownRaw,
          }),
        ],
        headers: { "Referrer-Policy": "no-referrer" },
      };
    };

    try {
      if (error && !kcActionStatus) {
        const pending = state
          ? await this.deps.state.consume(state)
          : null;
        if (pending?.silent || !pending) {
          return quietSilentFail(
            pending?.returnTo || "/",
            error,
            Boolean(pending?.viaBypass),
          );
        }
        const dest = `/login?error=oidc_${encodeURIComponent(error)}`;
        return { status: 302, redirectTo: dest };
      }

      if (kcActionStatus && !code) {
        const pending = state
          ? await this.deps.state.consume(state)
          : null;
        const base = safeReturnTo(
          pending?.returnTo,
          "/",
          this.config.publicOrigin,
        );
        const sep = base.includes("?") ? "&" : "?";
        const status =
          kcActionStatus === "success"
            ? "success"
            : kcActionStatus === "cancelled"
              ? "cancelled"
              : "error";
        return {
          status: 302,
          redirectTo: `${base}${sep}passkey=${status}`,
        };
      }

      if (!code || !state) {
        return {
          status: 302,
          redirectTo: "/login?error=oidc_missing_code",
        };
      }

      const pending = await this.deps.state.consume(state);
      if (!pending) {
        return quietSilentFail("/", "missing_state", false);
      }

      const meta = await fetchOidcDiscovery(this.config.issuer, {
        fetch: this.fetchFn(),
        now: () => this.now(),
      });
      const tokens = await exchangeAuthorizationCode({
        code,
        codeVerifier: pending.codeVerifier,
        config: this.config,
        meta,
        fetchFn: this.fetchFn(),
      });
      if (!tokens.id_token) {
        throw new Error("OIDC_MISSING_ID_TOKEN");
      }

      const jwks = await fetchJwks(meta.jwks_uri, this.fetchFn());
      const claims = await validateOidcIdToken({
        idToken: tokens.id_token,
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        nonce: pending.nonce,
        jwksUri: meta.jwks_uri,
        jwks,
        clockToleranceSec: this.config.clockToleranceSec,
        allowedAlgs: this.config.allowedJwtAlgs,
      });

      const user = await this.deps.users.resolve(claims, this.config.issuer);
      const sessionId = createSessionId();
      const session: SessionRecord = {
        sessionId,
        userId: user.userId,
        sub: claims.sub,
        sid: claims.sid ?? null,
        idToken: tokens.id_token,
        expiresAt: this.now() + this.sessionMaxAgeSec * 1000,
      };
      const saved = await this.deps.sessions.create(session);

      let redirectTo = stripSsoBypassParam(
        safeReturnTo(pending.returnTo, "/", this.config.publicOrigin),
      );

      if (pending.silent && this.deps.onSilentLoginSuccess) {
        const hooked = await this.deps.onSilentLoginSuccess({
          userId: user.userId,
          sub: claims.sub,
          returnTo: redirectTo,
          session: saved,
        });
        if (hooked) {
          redirectTo = safeReturnTo(hooked, redirectTo, this.config.publicOrigin);
        }
      }

      if (pending.silent) {
        this.logger.log("info", "silent", { result: "success" });
      }

      const setCookies: CookieJarEntry[] = [
        sessionCookie(this.sessionCookieName, saved.sessionId, {
          secure: this.config.secureCookies,
          maxAge: this.sessionMaxAgeSec,
        }),
        cookieEntry(this.config.idTokenCookieName, tokens.id_token, {
          secure: this.config.secureCookies,
          httpOnly: true,
          maxAge: this.sessionMaxAgeSec,
        }),
        cookieEntry(this.config.oidcFlagCookieName, "1", {
          secure: this.config.secureCookies,
          httpOnly: false,
          maxAge: this.sessionMaxAgeSec,
        }),
        this.cooldownClearCookie(),
      ];

      return { status: 302, redirectTo, setCookies };
    } catch (err) {
      this.logger.log("error", "callback failed", {
        error: summarizeOidcError(err),
      });
      // If we still have a silent pending consumed already, quiet fail to land.
      return quietSilentFail("/", "callback_failed", false);
    }
  }

  /**
   * RP-initiated logout. Adapters expose this as POST-only (GET → 405).
   *
   * MUST be invoked from a **top-level document navigation** (HTML form POST),
   * never `fetch` / XHR — the response is a 302/303 document redirect to the
   * IdP `end_session_endpoint` (with `id_token_hint`) so Keycloak clears its
   * SSO session. A fetch/XHR caller would not navigate the browser to end_session.
   */
  async logout(input: {
    sessionId?: string | null;
    idTokenHint?: string | null;
    cookieHeader?: string | null;
  } = {}): Promise<AuthFlowResult> {
    const clear: CookieJarEntry[] = [
      expireCookie(this.sessionCookieName, {
        secure: this.config.secureCookies,
        httpOnly: true,
      }),
      expireCookie(this.config.idTokenCookieName, {
        secure: this.config.secureCookies,
        httpOnly: true,
      }),
      expireCookie(this.config.oidcFlagCookieName, {
        secure: this.config.secureCookies,
        httpOnly: false,
      }),
      this.cooldownClearCookie(),
    ];

    if (input.sessionId) {
      try {
        await this.deps.sessions.delete(input.sessionId);
      } catch (err) {
        this.logger.log("warn", "session delete failed on logout", {
          error: summarizeOidcError(err),
        });
      }
    }

    const rawHint =
      input.idTokenHint ||
      readCookie(input.cookieHeader, this.config.idTokenCookieName);
    // Hub behaviour: only send id_token_hint while the token is still fresh.
    // Stale hints trigger Keycloak's logout confirmation page.
    const hint =
      rawHint &&
      isIdTokenFreshForHint(
        rawHint,
        this.config.idTokenHintFreshnessSec,
        this.now(),
      )
        ? rawHint
        : null;

    try {
      const meta = await fetchOidcDiscovery(this.config.issuer, {
        fetch: this.fetchFn(),
        now: () => this.now(),
      });
      if (!meta.end_session_endpoint) {
        return {
          status: 303,
          redirectTo: this.config.postLogoutRedirectUri,
          clearCookies: clear,
        };
      }
      const url = buildEndSessionUrl({
        endSessionEndpoint: meta.end_session_endpoint,
        clientId: this.config.clientId,
        postLogoutRedirectUri: this.config.postLogoutRedirectUri,
        idTokenHint: hint,
      });
      // 303 after POST → browser performs a top-level GET to end_session.
      return { status: 303, redirectTo: url, clearCookies: clear };
    } catch {
      return {
        status: 303,
        redirectTo: this.config.postLogoutRedirectUri,
        clearCookies: clear,
      };
    }
  }

  /**
   * Back-Channel Logout 1.0 endpoint handler.
   * Returns 200 no-store on success; 400 on invalid token / replay / missing jti.
   * Requires `StateStore.seenJti` — refuses otherwise.
   */
  async handleBackchannelLogout(input: {
    logoutToken: string;
  }): Promise<AuthFlowResult> {
    const noStore = { "Cache-Control": "no-store" };
    try {
      if (typeof this.deps.state.seenJti !== "function") {
        return {
          status: 400,
          body: "replay_guard_unavailable",
          contentType: "text/plain",
          headers: noStore,
          error: "LOGOUT_TOKEN_REPLAY_GUARD_UNAVAILABLE",
        };
      }

      const meta = await fetchOidcDiscovery(this.config.issuer, {
        fetch: this.fetchFn(),
        now: () => this.now(),
      });

      const jwks = await fetchJwks(meta.jwks_uri, this.fetchFn());
      const claims = await validateLogoutToken({
        logoutToken: input.logoutToken,
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        jwksUri: meta.jwks_uri,
        jwks,
        clockToleranceSec: this.config.clockToleranceSec,
        allowedAlgs: this.config.allowedJwtAlgs,
        now: () => this.now(),
        refetchJwks: async () => {
          clearOidcDiscoveryCache();
          const refreshedMeta = await fetchOidcDiscovery(this.config.issuer, {
            fetch: this.fetchFn(),
            bypassCache: true,
            now: () => this.now(),
          });
          return fetchJwks(refreshedMeta.jwks_uri, this.fetchFn());
        },
      });

      const expMs = Math.max(
        this.now() + 60_000,
        claims.exp * 1000 + this.config.clockToleranceSec * 1000,
      );
      const replay = await this.deps.state.seenJti(claims.jti, expMs);
      if (replay) {
        return {
          status: 400,
          body: "replay",
          contentType: "text/plain",
          headers: noStore,
          error: "LOGOUT_TOKEN_REPLAY",
        };
      }

      await deleteSessionsBySidOrSub({
        store: this.deps.sessions,
        sid: claims.sid,
        sub: claims.sub,
      });

      return {
        status: 200,
        body: "",
        contentType: "text/plain",
        headers: noStore,
      };
    } catch (err) {
      this.logger.log("warn", "backchannel logout rejected", {
        error: summarizeOidcError(err),
      });
      return {
        status: 400,
        body: "invalid_token",
        contentType: "text/plain",
        headers: noStore,
        error: summarizeOidcError(err),
      };
    }
  }

  async startPasskeyAdd(input: {
    returnTo?: string | null;
    action?: string | null;
  } = {}): Promise<AuthFlowResult> {
    const action = getOidcPasskeyAddAction(
      input.action ?? this.config.passkeyAddAction,
    );
    const built = await buildAuthorizationRedirect({
      config: this.config,
      stateStore: this.deps.state,
      returnTo: input.returnTo,
      kcAction: action,
      scopes: ["openid"],
      silent: false,
      prompt: null,
      fetchDiscovery: this.fetchFn(),
      now: () => this.now(),
    });
    if (!built.ok) {
      return { status: built.status, error: built.error };
    }
    return { status: 302, redirectTo: built.url };
  }

  async startPasskeyRemove(input: {
    credentialId: string;
    returnTo?: string | null;
  }): Promise<AuthFlowResult> {
    const id = validateOidcPasskeyCredentialId(input.credentialId);
    if (!id) {
      return { status: 400, error: "OIDC_PASSKEY_INVALID_CREDENTIAL_ID" };
    }
    const built = await buildAuthorizationRedirect({
      config: this.config,
      stateStore: this.deps.state,
      returnTo: input.returnTo,
      kcAction: buildOidcPasskeyDeleteAction(id),
      scopes: ["openid"],
      silent: false,
      prompt: null,
      fetchDiscovery: this.fetchFn(),
      now: () => this.now(),
    });
    if (!built.ok) {
      return { status: built.status, error: built.error };
    }
    return { status: 302, redirectTo: built.url };
  }

  async validateRequestSession(input: {
    cookieHeader?: string | null;
  }): Promise<ReturnType<typeof validateSession>> {
    const sessionId = readCookie(input.cookieHeader, this.sessionCookieName);
    return validateSession({
      sessionId,
      store: this.deps.sessions,
      sessionCookieName: this.sessionCookieName,
      secureCookies: this.config.secureCookies,
    });
  }

  /** Same-origin land hop after quiet silent fail. */
  land(input: { next?: string | null }): AuthFlowResult {
    const next = stripSsoBypassParam(
      safeReturnTo(input.next, "/", this.config.publicOrigin),
    );
    return {
      status: 302,
      redirectTo: next,
      headers: { "Referrer-Policy": "no-referrer" },
    };
  }

  /** Strip ?sso=1 from a path when bypass was refused. */
  stripSsoRedirect(pathname: string, search: string): AuthFlowResult | null {
    if (!hasSsoBypassQuery(search)) return null;
    const next = stripSsoBypassParam(`${pathname}${search}`);
    return { status: 307, redirectTo: next };
  }
}

export function createAuthClient(opts: CreateAuthClientOptions): MwAuthClient {
  return new MwAuthClient(opts);
}
