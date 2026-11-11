/**
 * Next.js App Router + Better Auth adapter for mw-auth.
 *
 * Public API:
 * - `createNextAuthAdapter(options)` → route handlers + proxy/middleware helpers
 * - `createBetterAuthSessionBridge(auth)` → SessionStore backed by Better Auth internals
 * - Handler map usable from `app/api/auth/oidc/.../route.ts`
 */
import type { MwAuthClient } from "../../core/client.js";
import { toWebResponse, readFormOrJson } from "../../core/http.js";
import { readCookie } from "../../core/cookies.js";
import {
  hasSsoBypassQuery,
  safeReturnTo,
  stripSsoBypassParam,
} from "../../core/safe-return.js";
import type { SessionStore, StateStore, UserResolver } from "../../core/interfaces.js";
import type { SessionRecord } from "../../core/types.js";

export type NextAuthAdapterOptions = {
  client: MwAuthClient;
  /**
   * Paths treated as protected — unauthenticated document navigations
   * redirect to interactive login (public pages never auto-login).
   */
  protectedPathPrefixes?: string[];
  /** Override login entry path for interactive redirects. Default: /login */
  interactiveLoginPath?: string;
};

export type NextAuthHandlers = {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};

function isProtected(
  pathname: string,
  prefixes: string[],
): boolean {
  for (const p of prefixes) {
    if (pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Create App Router route handlers for OIDC endpoints.
 * Mount under the paths configured on the client (defaults match docx-form).
 */
export function createNextOidcHandlers(
  client: MwAuthClient,
): Record<string, NextAuthHandlers> {
  const paths = client.config.paths;

  const login: NextAuthHandlers = {
    GET: async (request) => {
      const url = new URL(request.url);
      const result = await client.startInteractiveLogin({
        returnTo: url.searchParams.get("next"),
        kcIdpHint: url.searchParams.get("kc_idp_hint"),
      });
      return toWebResponse(result);
    },
    POST: async (request) => login.GET(request),
  };

  const silent: NextAuthHandlers = {
    GET: async (request) => {
      const url = new URL(request.url);
      const result = await client.startSilentLogin({
        returnTo: url.searchParams.get("next"),
        viaBypass: url.searchParams.get("bypass") === "1",
        cooldownCookie: readCookie(
          request.headers.get("cookie"),
          client.config.cooldownCookieName,
        ),
      });
      return toWebResponse(result);
    },
    POST: async () =>
      new Response("Method Not Allowed", { status: 405 }),
  };

  const silentLand: NextAuthHandlers = {
    GET: async (request) => {
      const url = new URL(request.url);
      return toWebResponse(client.land({ next: url.searchParams.get("next") }));
    },
    POST: async () =>
      new Response("Method Not Allowed", { status: 405 }),
  };

  const callback: NextAuthHandlers = {
    GET: async (request) => {
      const result = await client.handleCallback({
        url: request.url,
        cookieHeader: request.headers.get("cookie"),
      });
      return toWebResponse(result);
    },
    POST: async (request) => callback.GET(request),
  };

  const logout: NextAuthHandlers = {
    GET: async () =>
      new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      }),
    POST: async (request) => {
      const cookie = request.headers.get("cookie");
      const sessionId = readCookie(cookie, client.sessionCookieName);
      const result = await client.logout({
        sessionId,
        cookieHeader: cookie,
      });
      return toWebResponse(result);
    },
  };

  const backchannel: NextAuthHandlers = {
    GET: async () =>
      new Response("Method Not Allowed", { status: 405 }),
    POST: async (request) => {
      const body = await readFormOrJson(request);
      const token = body.logout_token || "";
      const result = await client.handleBackchannelLogout({
        logoutToken: token,
      });
      return toWebResponse(result);
    },
  };

  const passkeyAdd: NextAuthHandlers = {
    GET: async (request) => {
      const url = new URL(request.url);
      const result = await client.startPasskeyAdd({
        returnTo: url.searchParams.get("next"),
      });
      return toWebResponse(result);
    },
    POST: async (request) => passkeyAdd.GET(request),
  };

  const passkeyRemove: NextAuthHandlers = {
    GET: async (request) => {
      const url = new URL(request.url);
      const credentialId = url.searchParams.get("credentialId") || "";
      const result = await client.startPasskeyRemove({
        credentialId,
        returnTo: url.searchParams.get("next"),
      });
      return toWebResponse(result);
    },
    POST: async (request) => passkeyRemove.GET(request),
  };

  return {
    [paths.login]: login,
    [paths.silent]: silent,
    [paths.silentLand]: silentLand,
    [paths.callback]: callback,
    [paths.logout]: logout,
    [paths.backchannelLogout]: backchannel,
    [paths.passkeyAdd]: passkeyAdd,
    [paths.passkeyRemove]: passkeyRemove,
  };
}

/**
 * Edge/proxy helper for silent SSO + protected-route gating.
 * Public pages never auto-redirect to interactive login.
 */
export async function handleNextAuthProxy(
  request: Request,
  options: NextAuthAdapterOptions,
): Promise<Response | null> {
  const { client } = options;
  const protectedPrefixes = options.protectedPathPrefixes ?? [
    "/account",
    "/admin",
  ];
  const loginPath = options.interactiveLoginPath ?? "/login";
  const url = new URL(request.url);
  const cookie = request.headers.get("cookie");

  const session = await client.validateRequestSession({ cookieHeader: cookie });
  const decision = client.decideSilentSso({
    pathname: url.pathname,
    search: url.search,
    hasSession: session.hasSession,
    cooldownCookie: readCookie(cookie, client.config.cooldownCookieName),
    referer: request.headers.get("referer"),
    headers: request.headers,
  });

  if (decision.start) {
    const next = stripSsoBypassParam(`${url.pathname}${url.search}`);
    const silentUrl = new URL(client.config.paths.silent, client.config.publicOrigin);
    silentUrl.searchParams.set("next", next);
    if (decision.viaBypass) silentUrl.searchParams.set("bypass", "1");
    const headers = new Headers({
      Location: `${silentUrl.pathname}${silentUrl.search}`,
      "Referrer-Policy": "no-referrer",
    });
    for (const c of session.clearCookies) {
      // clearCookies applied by caller via toWebResponse when needed
      void c;
    }
    return new Response(null, { status: 307, headers });
  }

  if (decision.stripSsoParam && hasSsoBypassQuery(url.search)) {
    const stripped = stripSsoBypassParam(`${url.pathname}${url.search}`);
    return new Response(null, {
      status: 307,
      headers: { Location: stripped },
    });
  }

  if (
    !session.hasSession &&
    isProtected(url.pathname, protectedPrefixes)
  ) {
    const next = safeReturnTo(
      `${url.pathname}${url.search}`,
      "/",
      client.config.publicOrigin,
    );
    return new Response(null, {
      status: 307,
      headers: {
        Location: `${loginPath}?next=${encodeURIComponent(next)}`,
      },
    });
  }

  return null;
}

export type BetterAuthLike = {
  $context: Promise<{
    internalAdapter: {
      createSession: (
        userId: string,
        dontRememberMe: boolean,
      ) => Promise<{ token: string; userId: string } | null>;
      findSession: (
        token: string,
      ) => Promise<{ session: { token: string; userId: string } } | null>;
      deleteSession: (token: string) => Promise<void>;
    };
    secret: string;
  }>;
};

/**
 * Bridge Better Auth sessions into SessionStore.
 * Apps still own user linking via UserResolver; sid/sub are stored in a
 * side map the app provides (or MemorySessionStore metadata).
 *
 * For full back-channel support, prefer wrapping with a store that
 * persists sid/sub alongside the Better Auth session token.
 */
export function createBetterAuthSessionBridge(input: {
  auth: BetterAuthLike;
  /** Side index for sid/sub → session token. */
  index: SessionStore;
}): SessionStore {
  return {
    async create(session: SessionRecord): Promise<SessionRecord> {
      const ctx = await input.auth.$context;
      const created = await ctx.internalAdapter.createSession(
        session.userId,
        false,
      );
      if (!created) throw new Error("BETTER_AUTH_SESSION_FAILED");
      const record: SessionRecord = {
        ...session,
        sessionId: created.token,
      };
      await input.index.create(record);
      return record;
    },
    async get(sessionId: string): Promise<SessionRecord | null> {
      const indexed = await input.index.get(sessionId);
      if (indexed) return indexed;
      const ctx = await input.auth.$context;
      const found = await ctx.internalAdapter.findSession(sessionId);
      if (!found) return null;
      return {
        sessionId: found.session.token,
        userId: found.session.userId,
        sub: "",
      };
    },
    async delete(sessionId: string): Promise<void> {
      await input.index.delete(sessionId);
      const ctx = await input.auth.$context;
      await ctx.internalAdapter.deleteSession(sessionId);
    },
    findBySid: (sid) => input.index.findBySid(sid),
    findBySub: (sub) => input.index.findBySub(sub),
  };
}

export function createNextAuthAdapter(options: NextAuthAdapterOptions): {
  handlers: Record<string, NextAuthHandlers>;
  handleProxy: (request: Request) => Promise<Response | null>;
  client: MwAuthClient;
} {
  return {
    handlers: createNextOidcHandlers(options.client),
    handleProxy: (request) => handleNextAuthProxy(request, options),
    client: options.client,
  };
}

export type { SessionStore, StateStore, UserResolver };
