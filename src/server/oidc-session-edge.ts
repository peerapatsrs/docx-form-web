/**
 * Edge-safe Better Auth session_token checks (HMAC signature only — no DB).
 * Invalid/malformed cookies are treated as absent so silent SSO can run.
 */

import { getSessionCookie } from "better-auth/cookies";

function authSecret(): string {
  return (
    String(process.env.BETTER_AUTH_SECRET || "").trim() ||
    String(process.env.AUTH_SECRET || "").trim() ||
    "docx-form-dev-secret-change-me-32b"
  );
}

function sessionCookieNames(): string[] {
  const prefix = "better-auth";
  const base = `${prefix}.session_token`;
  return [`__Secure-${base}`, base, `__Secure-${prefix}-session_token`, `${prefix}-session_token`];
}

/**
 * Verify better-call signed cookie value: `payload.signature` (signature = base64, 44 chars).
 */
export async function verifySignedCookieValue(
  rawValue: string,
  secret: string = authSecret(),
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
 * Resolve whether the request presents a cryptographically valid session cookie.
 * Does not hit the DB — forged/truncated cookies → absent + clear Set-Cookie.
 */
export async function resolveProxySession(input: {
  request: { headers: Headers; cookies?: { get: (n: string) => { value: string } | undefined } };
  secure?: boolean;
}): Promise<{ hasSession: boolean; clearCookies: string[] }> {
  const secure =
    input.secure ?? process.env.NODE_ENV === "production";
  const raw = getSessionCookie(input.request as Parameters<typeof getSessionCookie>[0]);
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
  return { hasSession: true, clearCookies: [] };
}
