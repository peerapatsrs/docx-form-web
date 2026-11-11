import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type { OidcIdTokenClaims } from "./types.js";

export type ValidateIdTokenInput = {
  idToken: string;
  issuer: string;
  clientId: string;
  nonce: string;
  jwksUri: string;
  jwks?: JSONWebKeySet;
  clockToleranceSec?: number;
  allowedAlgs?: ReadonlyArray<"RS256" | "ES256">;
};

/**
 * Validate ID Token per OIDC Core: signature via JWKS, iss/aud/exp/nonce.
 * Never logs the token. Rejects alg=none via jose defaults + allow-list.
 */
export async function validateOidcIdToken(
  input: ValidateIdTokenInput,
): Promise<OidcIdTokenClaims> {
  const jwks = input.jwks
    ? createLocalJWKSet(input.jwks)
    : createRemoteJWKSet(new URL(input.jwksUri));

  const { payload, protectedHeader } = await jwtVerify(input.idToken, jwks, {
    issuer: input.issuer.replace(/\/$/, ""),
    audience: input.clientId,
    clockTolerance: input.clockToleranceSec ?? 60,
    algorithms: [...(input.allowedAlgs ?? ["RS256", "ES256"])],
  });

  if (protectedHeader.alg === "none") {
    throw new Error("OIDC_ID_TOKEN_ALG_NONE");
  }

  const claims = payload as JWTPayload & OidcIdTokenClaims;
  if (!claims.sub || typeof claims.sub !== "string") {
    throw new Error("OIDC_ID_TOKEN_MISSING_SUB");
  }
  if (!claims.nonce || claims.nonce !== input.nonce) {
    throw new Error("OIDC_ID_TOKEN_NONCE_MISMATCH");
  }

  return {
    iss: String(claims.iss || "").replace(/\/$/, ""),
    sub: claims.sub,
    aud: claims.aud as string | string[],
    exp: Number(claims.exp),
    iat: claims.iat != null ? Number(claims.iat) : undefined,
    nonce: claims.nonce,
    sid: typeof claims.sid === "string" ? claims.sid : undefined,
    email: typeof claims.email === "string" ? claims.email : undefined,
    email_verified:
      typeof claims.email_verified === "boolean"
        ? claims.email_verified
        : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
    preferred_username:
      typeof claims.preferred_username === "string"
        ? claims.preferred_username
        : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
  };
}
