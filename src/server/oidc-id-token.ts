import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JSONWebKeySet,
  createLocalJWKSet,
} from "jose";

export type OidcIdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  picture?: string;
};

export type ValidateIdTokenInput = {
  idToken: string;
  issuer: string;
  clientId: string;
  nonce: string;
  jwksUri: string;
  /** Optional static JWKS for unit tests (skips remote fetch). */
  jwks?: JSONWebKeySet;
  clockToleranceSec?: number;
};

/**
 * Validate ID Token per OIDC Core: signature via JWKS, iss/aud/exp/nonce.
 * Never logs the token.
 */
export async function validateOidcIdToken(
  input: ValidateIdTokenInput,
): Promise<OidcIdTokenClaims> {
  const jwks = input.jwks
    ? createLocalJWKSet(input.jwks)
    : createRemoteJWKSet(new URL(input.jwksUri));

  const { payload } = await jwtVerify(input.idToken, jwks, {
    issuer: input.issuer.replace(/\/$/, ""),
    audience: input.clientId,
    clockTolerance: input.clockToleranceSec ?? 60,
  });

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
