/**
 * Thin Next.js + Better Auth wiring for @mw-shared/auth.
 * Config from env at call time — no import-time env reads in the module.
 */

import { serializeSignedCookie } from "better-call";
import {
  configFromEnv,
  createAuthClient,
  createConsoleLogger,
  serializeCookie,
  type MwAuthClient,
  type CookieJarEntry,
} from "@mw-shared/auth";
import {
  createBetterAuthSessionBridge,
  createNextAuthAdapter,
  createNextOidcHandlers,
  handleNextAuthProxy,
} from "@mw-shared/auth/adapters/nextjs";

type NextAuthHandlers = {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
};
import { auth } from "./auth";
import { isOidcEnabled } from "./oidc-config";
import {
  createAppUserResolver,
  createPgSessionIndexStore,
  createPgStateStore,
  ensureMwAuthStoresSchema,
} from "./mw-auth-stores";
import { expireAppSessionCookies } from "./oidc-session-edge";

/** Keep existing cookie names so live sessions / docs stay aligned. */
export const MW_SESSION_COOKIE = "mw_session";
export const OIDC_SSO_COOLDOWN_COOKIE = "docx_sso_checked";
export const OIDC_ID_TOKEN_COOKIE = "docx_oidc_id_token";
export const OIDC_FLAG_COOKIE = "docx_oidc";

let cachedClient: MwAuthClient | null | undefined;

export function resetMwAuthClientCache(): void {
  cachedClient = undefined;
}

function buildConfigFromProcessEnv() {
  return configFromEnv(process.env as Record<string, string | undefined>, {
    cooldownCookieName: OIDC_SSO_COOLDOWN_COOKIE,
    idTokenCookieName: OIDC_ID_TOKEN_COOKIE,
    oidcFlagCookieName: OIDC_FLAG_COOKIE,
    secureCookies: process.env.NODE_ENV === "production",
  });
}

/**
 * Returns null when OIDC env is incomplete (soft-disable).
 */
export function getMwAuthClient(): MwAuthClient | null {
  if (cachedClient !== undefined) return cachedClient;
  if (!isOidcEnabled()) {
    cachedClient = null;
    return null;
  }
  try {
    const config = buildConfigFromProcessEnv();
    const index = createPgSessionIndexStore();
    const sessions = createBetterAuthSessionBridge({
      auth: auth as never,
      index,
    });
    cachedClient = createAuthClient({
      config,
      sessionCookieName: MW_SESSION_COOKIE,
      sessionMaxAgeSec: 60 * 60 * 24 * 7,
      deps: {
        sessions,
        state: createPgStateStore(),
        users: createAppUserResolver(),
        logger: createConsoleLogger(),
      },
    });
    void ensureMwAuthStoresSchema().catch(() => undefined);
    return cachedClient;
  } catch {
    cachedClient = null;
    return null;
  }
}

export function getMwAuthAdapter() {
  const client = getMwAuthClient();
  if (!client) return null;
  return createNextAuthAdapter({
    client,
    protectedPathPrefixes: ["/account", "/admin"],
    interactiveLoginPath: "/login",
  });
}

export function getMwOidcHandlers(): Record<string, NextAuthHandlers> | null {
  const client = getMwAuthClient();
  if (!client) return null;
  return createNextOidcHandlers(client);
}

/**
 * After module handlers set `mw_session=<ba-token>`, also emit the signed
 * Better Auth session_token cookie so auth.api.getSession keeps working.
 */
export async function augmentWithBetterAuthCookies(
  response: Response,
): Promise<Response> {
  const setCookies = response.headers.getSetCookie?.() || [];
  if (!setCookies.length) return response;

  const ctx = await auth.$context;
  const baName = ctx.authCookies.sessionToken.name;
  const secure = process.env.NODE_ENV === "production";
  const extra: string[] = [];

  for (const raw of setCookies) {
    const name = raw.split("=")[0]?.trim();
    if (name === MW_SESSION_COOKIE) {
      const rest = raw.slice(MW_SESSION_COOKIE.length + 1);
      const valuePart = rest.split(";")[0] || "";
      let token = valuePart;
      try {
        token = decodeURIComponent(valuePart);
      } catch {
        /* keep */
      }
      if (!token || /Max-Age=0/i.test(raw)) {
        for (const c of expireAppSessionCookies(secure)) extra.push(c);
      } else {
        const signed = await serializeSignedCookie(
          baName,
          token,
          ctx.secret,
          {
            ...ctx.authCookies.sessionToken.attributes,
            maxAge: ctx.sessionConfig.expiresIn,
          },
        );
        extra.push(signed);
      }
    }
  }

  if (!extra.length) return response;

  const headers = new Headers(response.headers);
  // Headers#getSetCookie is read-only aggregate; rebuild Set-Cookie list.
  headers.delete("set-cookie");
  for (const c of setCookies) headers.append("Set-Cookie", c);
  for (const c of extra) headers.append("Set-Cookie", c);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleMwAuthProxy(
  request: Request,
): Promise<Response | null> {
  const client = getMwAuthClient();
  if (!client) return null;
  return handleNextAuthProxy(request, {
    client,
    protectedPathPrefixes: ["/account", "/admin"],
    interactiveLoginPath: "/login",
  });
}

/** Serialize CookieJarEntry list the way adapters do (tests / proxy). */
export function serializeCookieJar(
  entries: CookieJarEntry[] | undefined,
): string[] {
  if (!entries?.length) return [];
  return entries.map((e) => serializeCookie(e));
}
