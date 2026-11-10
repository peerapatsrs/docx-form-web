/**
 * Better Auth session_token checks for the proxy.
 * HMAC verify always; optional DB/session-API validation on real page loads.
 */

import { getSessionCookie } from "better-auth/cookies";
import { resolveBetterAuthSecret } from "./auth-secret";

function sessionCookieNames(): string[] {
  const prefix = "better-auth";
  const base = `${prefix}.session_token`;
  return [
    `__Secure-${base}`,
    base,
    `__Secure-${prefix}-session_token`,
    `${prefix}-session_token`,
  ];
}

/**
 * Verify better-call signed cookie value: `payload.signature` (signature = base64, 44 chars).
 */
export async function verifySignedCookieValue(
  rawValue: string,
  secret: string = resolveBetterAuthSecret(),
): Promise<string | null> {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  const signatureStartPos = value.lastIndexOf(".");
  if (signatureStartPos < 1) return null;
  const signedValue = value.substring(0, signatureStartPos);
  const signature = value.substring(signatureStartPos + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  if (!signedValue) return null;

  try {
    const secretBuf = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
      "raw",
      secretBuf,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBinStr = atob(signature);
    const sigBytes = new Uint8Array(signatureBinStr.length);
    for (let i = 0; i < signatureBinStr.length; i++) {
      sigBytes[i] = signatureBinStr.charCodeAt(i);
    }
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(signedValue),
    );
    return ok ? signedValue : null;
  } catch {
    return null;
  }
}

export function expireAppSessionCookies(secure: boolean): string[] {
  const secureAttr = secure ? "; Secure" : "";
  return sessionCookieNames().map(
    (name) =>
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`,
  );
}

/**
 * Resolve whether the request has a live app session.
 * - Always HMAC-verify the cookie (forged → clear).
 * - When validateInDb (top-level document navigations only), also call
 *   auth.api.getSession; missing/expired DB session → clear + absent.
 */
export async function resolveProxySession(input: {
  request: {
    headers: Headers;
    cookies?: { get: (n: string) => { value: string } | undefined };
  };
  secure?: boolean;
  /** Page-load only — skip on RSC/prefetch to avoid DB load. */
  validateInDb?: boolean;
}): Promise<{ hasSession: boolean; clearCookies: string[] }> {
  const secure = input.secure ?? process.env.NODE_ENV === "production";
  const raw = getSessionCookie(
    input.request as Parameters<typeof getSessionCookie>[0],
  );
  if (!raw) {
    return { hasSession: false, clearCookies: [] };
  }
  const verified = await verifySignedCookieValue(raw);
  if (!verified) {
    return {
      hasSession: false,
      clearCookies: expireAppSessionCookies(secure),
    };
  }

  if (input.validateInDb) {
    try {
      const { auth } = await import("./auth");
      const session = await auth.api.getSession({
        headers: input.request.headers,
      });
      if (!session?.session || !session?.user) {
        return {
          hasSession: false,
          clearCookies: expireAppSessionCookies(secure),
        };
      }
    } catch {
      // Treat lookup failure as absent so silent SSO can still run.
      return {
        hasSession: false,
        clearCookies: expireAppSessionCookies(secure),
      };
    }
  }

  return { hasSession: true, clearCookies: [] };
}
