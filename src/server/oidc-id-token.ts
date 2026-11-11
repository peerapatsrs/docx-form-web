/**
 * id_token validation — re-export @mw-shared/auth core.
 */
export {
  validateOidcIdToken,
  type OidcIdTokenClaims,
} from "@mw-shared/auth";

export type ValidateIdTokenInput = Parameters<
  typeof import("@mw-shared/auth").validateOidcIdToken
>[0];
