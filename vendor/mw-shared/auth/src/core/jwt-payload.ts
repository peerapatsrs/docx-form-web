import { base64UrlToBytes } from "./crypto.js";

/**
 * Decode a JWT payload without verifying the signature.
 * Used only for non-security UX decisions (e.g. whether to attach id_token_hint).
 * Never logs the token.
 */
export function decodeJwtPayload(
  jwt: string,
): Record<string, unknown> | null {
  const parts = String(jwt || "").split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const bytes = base64UrlToBytes(parts[1]);
    const json =
      typeof TextDecoder !== "undefined"
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Whether an id_token is still fresh enough to send as `id_token_hint`.
 * Fresh when `exp` is present and `exp > nowSec - freshnessSkewSec`.
 * Stale / missing exp / unreadable → false (caller omits the hint).
 */
export function isIdTokenFreshForHint(
  idToken: string | null | undefined,
  freshnessSkewSec: number,
  nowMs: number = Date.now(),
): boolean {
  if (!idToken) return false;
  const payload = decodeJwtPayload(idToken);
  if (!payload) return false;
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  const skew = Math.max(0, Math.floor(freshnessSkewSec));
  const nowSec = Math.floor(nowMs / 1000);
  return exp > nowSec - skew;
}
