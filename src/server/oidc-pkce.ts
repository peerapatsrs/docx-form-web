import { createHash, randomBytes } from "node:crypto";

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateOidcRandom(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** RFC 7636 S256 code_challenge from verifier. */
export function pkceChallengeS256(verifier: string): string {
  const hash = createHash("sha256").update(verifier, "ascii").digest();
  return b64url(hash);
}

export type OidcAuthRequestSecrets = {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
};

export function createOidcAuthRequestSecrets(): OidcAuthRequestSecrets {
  const state = generateOidcRandom(32);
  const nonce = generateOidcRandom(32);
  const codeVerifier = generateOidcRandom(48);
  const codeChallenge = pkceChallengeS256(codeVerifier);
  return { state, nonce, codeVerifier, codeChallenge };
}
