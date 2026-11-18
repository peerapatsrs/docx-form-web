import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

export type LogoutTokenClaims = {
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
  sub?: string;
  sid?: string;
  events: Record<string, unknown>;
};

export type ValidateLogoutTokenInput = {
  logoutToken: string;
  issuer: string;
  clientId: string;
  jwksUri: string;
  jwks?: JSONWebKeySet;
  /** Optional secondary JWKS after unknown kid — caller can clear cache. */
  refetchJwks?: () => Promise<JSONWebKeySet | null>;
  clockToleranceSec?: number;
  allowedAlgs?: ReadonlyArray<"RS256" | "ES256">;
  now?: () => number;
};

const BACKCHANNEL_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";

/**
 * OIDC Back-Channel Logout 1.0 logout_token verification.
 * - RS256/ES256 only (reject none / HS256 / others)
 * - Require iss, aud, iat, exp, jti, events.backchannel-logout
 * - Require sub and/or sid; reject nonce
 * - Reject stale iat outside clockToleranceSec; jose rejects expired exp
 */
export async function validateLogoutToken(
  input: ValidateLogoutTokenInput,
): Promise<LogoutTokenClaims> {
  const algs = [...(input.allowedAlgs ?? ["RS256", "ES256"])];
  const skew = input.clockToleranceSec ?? 60;
  const nowSec = Math.floor((input.now ?? Date.now)() / 1000);
  const header = decodeProtectedHeader(input.logoutToken);
  if (
    !header.alg ||
    header.alg === "none" ||
    !algs.includes(header.alg as "RS256" | "ES256")
  ) {
    throw new Error("LOGOUT_TOKEN_ALG_REJECTED");
  }

  const verifyOnce = async (
    jwks:
      | ReturnType<typeof createLocalJWKSet>
      | ReturnType<typeof createRemoteJWKSet>,
  ) =>
    jwtVerify(input.logoutToken, jwks, {
      issuer: input.issuer.replace(/\/$/, ""),
      audience: input.clientId,
      clockTolerance: skew,
      algorithms: algs,
    });

  let result;
  try {
    const jwks = input.jwks
      ? createLocalJWKSet(input.jwks)
      : createRemoteJWKSet(new URL(input.jwksUri));
    result = await verifyOnce(jwks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const unknownKid =
      /no matching|unknown kid|JWKSNoMatchingKey|key does not match/i.test(
        msg,
      );
    if (!unknownKid || !input.refetchJwks) throw err;
    const refreshed = await input.refetchJwks();
    if (!refreshed) throw err;
    result = await verifyOnce(createLocalJWKSet(refreshed));
  }

  const payload = result.payload as JWTPayload & {
    events?: Record<string, unknown>;
    sid?: string;
    nonce?: unknown;
  };

  if (payload.nonce !== undefined) {
    throw new Error("LOGOUT_TOKEN_NONCE_PRESENT");
  }
  if (payload.iat == null || typeof payload.iat !== "number") {
    throw new Error("LOGOUT_TOKEN_MISSING_IAT");
  }
  if (payload.exp == null || typeof payload.exp !== "number") {
    throw new Error("LOGOUT_TOKEN_MISSING_EXP");
  }
  if (typeof payload.jti !== "string" || !payload.jti.trim()) {
    throw new Error("LOGOUT_TOKEN_MISSING_JTI");
  }

  // Stale / future iat outside allowed clock skew.
  if (Math.abs(nowSec - Number(payload.iat)) > skew) {
    throw new Error("LOGOUT_TOKEN_IAT_OUT_OF_TOLERANCE");
  }

  const events = payload.events;
  if (!events || typeof events !== "object" || !(BACKCHANNEL_EVENT in events)) {
    throw new Error("LOGOUT_TOKEN_MISSING_EVENT");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  const sid = typeof payload.sid === "string" ? payload.sid : undefined;
  if (!sub && !sid) {
    throw new Error("LOGOUT_TOKEN_MISSING_SUB_AND_SID");
  }

  return {
    iss: String(payload.iss || "").replace(/\/$/, ""),
    aud: payload.aud as string | string[],
    iat: Number(payload.iat),
    exp: Number(payload.exp),
    jti: payload.jti.trim(),
    sub,
    sid,
    events,
  };
}

export { BACKCHANNEL_EVENT };
