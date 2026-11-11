import { generateRandomBase64Url, sha256Base64Url } from "./crypto.js";
import type { AuthRequestSecrets } from "./types.js";

export function generateOidcRandom(bytes = 32): string {
  return generateRandomBase64Url(bytes);
}

/** RFC 7636 S256 code_challenge from verifier. */
export async function pkceChallengeS256(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

export async function createOidcAuthRequestSecrets(): Promise<AuthRequestSecrets> {
  const state = generateOidcRandom(32);
  const nonce = generateOidcRandom(32);
  const codeVerifier = generateOidcRandom(48);
  const codeChallenge = await pkceChallengeS256(codeVerifier);
  return { state, nonce, codeVerifier, codeChallenge };
}
