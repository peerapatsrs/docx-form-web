import type { CookieJarEntry, SessionRecord, SessionValidationResult } from "./types.js";
import type { SessionStore } from "./interfaces.js";
import { expireCookie } from "./cookies.js";
import { generateRandomBase64Url } from "./crypto.js";

export function createSessionId(): string {
  return generateRandomBase64Url(32);
}

/**
 * Validate session on page load against the store.
 * Store errors keep the session (fail-safe — do not sign out / clear cookies).
 */
export async function validateSession(input: {
  sessionId: string | null | undefined;
  store: SessionStore;
  sessionCookieName: string;
  secureCookies?: boolean;
}): Promise<SessionValidationResult> {
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) {
    return { hasSession: false, clearCookies: [] };
  }

  try {
    const session = await input.store.get(sessionId);
    if (!session) {
      return {
        hasSession: false,
        clearCookies: [
          expireCookie(input.sessionCookieName, {
            secure: input.secureCookies,
            httpOnly: true,
          }),
        ],
      };
    }
    return { hasSession: true, session, clearCookies: [] };
  } catch {
    // Fail-safe: keep cookie, treat as signed-in for silent-SSO gating.
    return {
      hasSession: true,
      storeError: true,
      clearCookies: [],
    };
  }
}

export async function deleteSessionsBySidOrSub(input: {
  store: SessionStore;
  sid?: string;
  sub?: string;
}): Promise<number> {
  let deleted = 0;
  if (input.sid) {
    const bySid = await input.store.findBySid(input.sid);
    for (const s of bySid) {
      await input.store.delete(s.sessionId);
      deleted += 1;
    }
    if (deleted > 0) return deleted;
  }
  if (input.sub) {
    const bySub = await input.store.findBySub(input.sub);
    for (const s of bySub) {
      await input.store.delete(s.sessionId);
      deleted += 1;
    }
  }
  return deleted;
}

export function sessionCookie(
  name: string,
  value: string,
  opts: { secure: boolean; maxAge: number },
): CookieJarEntry {
  return {
    name,
    value,
    attributes: {
      path: "/",
      httpOnly: true,
      secure: opts.secure,
      sameSite: "Lax",
      maxAge: opts.maxAge,
    },
  };
}

export type { SessionRecord };
