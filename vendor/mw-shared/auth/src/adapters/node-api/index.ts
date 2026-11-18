/**
 * Generic Node / Fastify / Hono-style API handler for @mw-shared/auth.
 *
 * Returns a `(request: Request) => Promise<Response>` (Fetch API) that apps
 * can mount under their SSO prefix (e.g. `/api/v1/auth/sso/*`).
 *
 * qr-table-order was not cloneable (private / 404); gated behaviour documents
 * Redis sessions + API routes under `/api/v1/auth/sso/{callback,logout,...}`.
 * This adapter is framework-agnostic so either Fastify (`@fastify/reply-from`
 * / custom), Hono, or a plain Node HTTP→Fetch bridge can use it.
 *
 * Public API:
 * - `createNodeAuthHandler(options)` → fetch handler
 * - `matchOidcRoute(pathname, paths)` → which action to run
 */
import type { MwAuthClient } from "../../core/client.js";
import { toWebResponse, readFormOrJson } from "../../core/http.js";
import { readCookie } from "../../core/cookies.js";
import type { MwAuthPaths } from "../../core/types.js";

export type NodeAuthHandlerOptions = {
  client: MwAuthClient;
  /**
   * Path prefix where this handler is mounted, e.g. `/api/v1/auth/sso`.
   * When set, incoming pathnames are matched relative to this prefix using
   * the client's configured path *suffixes* (login/callback/…).
   */
  mountPrefix?: string;
  /** Optional override map from action → absolute path. */
  routeMap?: Partial<Record<OidcRouteAction, string>>;
};

export type OidcRouteAction =
  | "login"
  | "silent"
  | "silentLand"
  | "callback"
  | "logout"
  | "backchannelLogout"
  | "passkeyAdd"
  | "passkeyRemove";

function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function defaultRouteMap(
  paths: MwAuthPaths,
  mountPrefix?: string,
): Record<OidcRouteAction, string> {
  if (!mountPrefix) {
    return {
      login: paths.login,
      silent: paths.silent,
      silentLand: paths.silentLand,
      callback: paths.callback,
      logout: paths.logout,
      backchannelLogout: paths.backchannelLogout,
      passkeyAdd: paths.passkeyAdd,
      passkeyRemove: paths.passkeyRemove,
    };
  }
  const base = normalizePath(mountPrefix);
  return {
    login: `${base}/login`,
    silent: `${base}/start-silent`,
    silentLand: `${base}/land`,
    callback: `${base}/callback`,
    logout: `${base}/logout`,
    backchannelLogout: `${base}/backchannel-logout`,
    passkeyAdd: `${base}/passkey/add`,
    passkeyRemove: `${base}/passkey/remove`,
  };
}

export function matchOidcRoute(
  pathname: string,
  routes: Record<OidcRouteAction, string>,
): OidcRouteAction | null {
  const path = normalizePath(pathname);
  for (const [action, route] of Object.entries(routes) as Array<
    [OidcRouteAction, string]
  >) {
    if (normalizePath(route) === path) return action;
  }
  return null;
}

/**
 * Create a Fetch-API request handler. Returns 404 when the path does not match.
 * Logout is POST-only (GET → 405).
 */
export function createNodeAuthHandler(
  options: NodeAuthHandlerOptions,
): (request: Request) => Promise<Response> {
  const client = options.client;
  const routes = {
    ...defaultRouteMap(client.config.paths, options.mountPrefix),
    ...options.routeMap,
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const action = matchOidcRoute(url.pathname, routes);
    if (!action) {
      return new Response("Not Found", { status: 404 });
    }

    const method = request.method.toUpperCase();
    const cookie = request.headers.get("cookie");

    switch (action) {
      case "login": {
        if (method !== "GET" && method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return toWebResponse(
          await client.startInteractiveLogin({
            returnTo: url.searchParams.get("next"),
            kcIdpHint: url.searchParams.get("kc_idp_hint"),
          }),
        );
      }
      case "silent": {
        if (method !== "GET") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return toWebResponse(
          await client.startSilentLogin({
            returnTo: url.searchParams.get("next"),
            viaBypass: url.searchParams.get("bypass") === "1",
            cooldownCookie: readCookie(
              cookie,
              client.config.cooldownCookieName,
            ),
          }),
        );
      }
      case "silentLand": {
        if (method !== "GET") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return toWebResponse(
          client.land({ next: url.searchParams.get("next") }),
        );
      }
      case "callback": {
        if (method !== "GET" && method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        return toWebResponse(
          await client.handleCallback({
            url: request.url,
            cookieHeader: cookie,
          }),
        );
      }
      case "logout": {
        if (method !== "POST") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "POST" },
          });
        }
        return toWebResponse(
          await client.logout({
            sessionId: readCookie(cookie, client.sessionCookieName),
            cookieHeader: cookie,
          }),
        );
      }
      case "backchannelLogout": {
        if (method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const body = await readFormOrJson(request);
        return toWebResponse(
          await client.handleBackchannelLogout({
            logoutToken: body.logout_token || "",
          }),
        );
      }
      case "passkeyAdd": {
        return toWebResponse(
          await client.startPasskeyAdd({
            returnTo: url.searchParams.get("next"),
          }),
        );
      }
      case "passkeyRemove": {
        return toWebResponse(
          await client.startPasskeyRemove({
            credentialId: url.searchParams.get("credentialId") || "",
            returnTo: url.searchParams.get("next"),
          }),
        );
      }
      default:
        return new Response("Not Found", { status: 404 });
    }
  };
}
