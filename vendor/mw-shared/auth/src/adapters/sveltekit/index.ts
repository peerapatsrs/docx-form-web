/**
 * SvelteKit hooks + route helpers for mw-auth (qr-table-order style).
 *
 * Public API:
 * - `createSvelteKitAuthHandle(options)` → `Handle` for `hooks.server.ts`
 * - `createSvelteKitOidcActions(client)` → load/action helpers for SSO routes
 * - Land path defaults to `/auth/sso/land` (web) while API SSO lives under `/api/v1/auth/sso/*`
 *
 * Note: qr-table-order clone was inaccessible; paths mirror gated behaviour
 * from RESULT-51dfb46 / RESULT-1a1173a (web land hop + API callback/logout).
 */
import type { MwAuthClient } from "../../core/client.js";
import { toWebResponse, readFormOrJson } from "../../core/http.js";
import { readCookie } from "../../core/cookies.js";
import {
  hasSsoBypassQuery,
  safeReturnTo,
  stripSsoBypassParam,
} from "../../core/safe-return.js";

export type SvelteKitAuthLocals = {
  session: Awaited<
    ReturnType<MwAuthClient["validateRequestSession"]>
  > | null;
};

type MaybePromise<T> = T | Promise<T>;

/** Minimal SvelteKit Handle-compatible types (no hard dependency). */
export type RequestEventLike = {
  request: Request;
  url: URL;
  cookies: {
    get: (name: string) => string | undefined;
  };
  locals: Record<string, unknown>;
  fetch: typeof fetch;
};

export type HandleLike = (input: {
  event: RequestEventLike;
  resolve: (event: RequestEventLike) => MaybePromise<Response>;
}) => MaybePromise<Response>;

export type SvelteKitAuthHandleOptions = {
  client: MwAuthClient;
  /** App routes that require a session (e.g. /app, /platform). */
  protectedPathPrefixes?: string[];
  /** Interactive login path. Default: /auth/login */
  interactiveLoginPath?: string;
  /** Web-side silent land path. Default: /auth/sso/land */
  landPath?: string;
  /** Skip silent SSO prefixes. */
  skipPathPrefixes?: string[];
};

function isProtected(pathname: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * SvelteKit `Handle` that:
 * 1. Validates session (fail-safe on store errors)
 * 2. Starts silent SSO on top-level document navigations only
 * 3. Redirects protected routes to interactive login (public pages never auto-login)
 * 4. Strips refused `?sso=1`
 */
export function createSvelteKitAuthHandle(
  options: SvelteKitAuthHandleOptions,
): HandleLike {
  const client = options.client;
  const protectedPrefixes = options.protectedPathPrefixes ?? [
    "/app",
    "/platform",
  ];
  const loginPath = options.interactiveLoginPath ?? "/auth/login";
  const landPath = options.landPath ?? "/auth/sso/land";

  return async ({ event, resolve }) => {
    const cookie = event.request.headers.get("cookie");
    const session = await client.validateRequestSession({
      cookieHeader: cookie,
    });
    event.locals.mwAuthSession = session;

    // Land hop — same-origin, Referrer-Policy: no-referrer
    if (event.url.pathname === landPath) {
      const result = client.land({ next: event.url.searchParams.get("next") });
      return toWebResponse(result);
    }

    const decision = client.decideSilentSso({
      pathname: event.url.pathname,
      search: event.url.search,
      hasSession: session.hasSession,
      cooldownCookie: readCookie(
        cookie,
        client.config.cooldownCookieName,
      ),
      referer: event.request.headers.get("referer"),
      headers: event.request.headers,
    });

    if (decision.start) {
      const next = stripSsoBypassParam(
        `${event.url.pathname}${event.url.search}`,
      );
      const silentPath = client.config.paths.silent;
      const q = new URLSearchParams({ next });
      if (decision.viaBypass) q.set("bypass", "1");
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${silentPath}?${q.toString()}`,
          "Referrer-Policy": "no-referrer",
        },
      });
    }

    if (decision.stripSsoParam && hasSsoBypassQuery(event.url.search)) {
      return new Response(null, {
        status: 307,
        headers: {
          Location: stripSsoBypassParam(
            `${event.url.pathname}${event.url.search}`,
          ),
        },
      });
    }

    if (!session.hasSession && isProtected(event.url.pathname, protectedPrefixes)) {
      const next = safeReturnTo(
        `${event.url.pathname}${event.url.search}`,
        "/",
        client.config.publicOrigin,
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${loginPath}?next=${encodeURIComponent(next)}`,
        },
      });
    }

    return resolve(event);
  };
}

/** Helpers for SvelteKit `+server.ts` SSO route files. */
export function createSvelteKitOidcHandlers(client: MwAuthClient): {
  login: (request: Request) => Promise<Response>;
  silent: (request: Request) => Promise<Response>;
  callback: (request: Request) => Promise<Response>;
  logoutGet: () => Response;
  logoutPost: (request: Request) => Promise<Response>;
  land: (request: Request) => Response;
  backchannel: (request: Request) => Promise<Response>;
} {
  return {
    login: async (request) => {
      const url = new URL(request.url);
      return toWebResponse(
        await client.startInteractiveLogin({
          returnTo: url.searchParams.get("next"),
          kcIdpHint: url.searchParams.get("kc_idp_hint"),
        }),
      );
    },
    silent: async (request) => {
      const url = new URL(request.url);
      return toWebResponse(
        await client.startSilentLogin({
          returnTo: url.searchParams.get("next"),
          viaBypass: url.searchParams.get("bypass") === "1",
          cooldownCookie: readCookie(
            request.headers.get("cookie"),
            client.config.cooldownCookieName,
          ),
        }),
      );
    },
    callback: async (request) =>
      toWebResponse(
        await client.handleCallback({
          url: request.url,
          cookieHeader: request.headers.get("cookie"),
        }),
      ),
    logoutGet: () =>
      new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      }),
    logoutPost: async (request) => {
      const cookie = request.headers.get("cookie");
      return toWebResponse(
        await client.logout({
          sessionId: readCookie(cookie, client.sessionCookieName),
          cookieHeader: cookie,
        }),
      );
    },
    land: (request) => {
      const url = new URL(request.url);
      return toWebResponse(client.land({ next: url.searchParams.get("next") }));
    },
    backchannel: async (request) => {
      const body = await readFormOrJson(request);
      return toWebResponse(
        await client.handleBackchannelLogout({
          logoutToken: body.logout_token || "",
        }),
      );
    },
  };
}
