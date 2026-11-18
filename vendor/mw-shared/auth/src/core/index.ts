export type {
  MwAuthConfig,
  MwAuthPaths,
  OpenIdProviderMetadata,
  OidcIdTokenClaims,
  OidcTokenResponse,
  AuthRequestSecrets,
  PendingAuthState,
  SessionRecord,
  ResolvedUser,
  CookieJarEntry,
  AuthFlowResult,
  SilentSsoStartDecision,
  SessionValidationResult,
  SilentSuccessHookContext,
  DiscoveryFetch,
} from "./types.js";

export type {
  SessionStore,
  StateStore,
  UserResolver,
  Logger,
  LogLevel,
  MwAuthDeps,
} from "./interfaces.js";

export {
  DEFAULT_PATHS,
  DEFAULT_COOLDOWN_SEC,
  DEFAULT_STATE_TTL_SEC,
  DEFAULT_CLOCK_TOLERANCE_SEC,
  DEFAULT_PASSKEY_ADD_ACTION,
  DEFAULT_COOLDOWN_COOKIE,
  DEFAULT_ID_TOKEN_COOKIE,
  DEFAULT_OIDC_FLAG_COOKIE,
  DEFAULT_JWT_ALGS,
  resolveAuthConfig,
  configFromEnv,
  normalizeHubOrigins,
  type ResolvedAuthConfig,
} from "./config.js";

export {
  generateOidcRandom,
  pkceChallengeS256,
  createOidcAuthRequestSecrets,
} from "./pkce.js";

export {
  safeReturnTo,
  stripSsoBypassParam,
  hasSsoBypassQuery,
  safeAppReturnPath,
} from "./safe-return.js";

export {
  parseCookieHeader,
  readCookie,
  serializeCookie,
  expireCookie,
  applySetCookies,
} from "./cookies.js";

export {
  summarizeOidcError,
  createConsoleLogger,
  noopLogger,
} from "./logger.js";

export {
  fetchOidcDiscovery,
  clearOidcDiscoveryCache,
} from "./discovery.js";

export {
  parseCooldownCookie,
  serializeCooldownValue,
  isCooldownActive,
  canUseSilentSsoBypass,
  normalizeSilentOutcome,
  buildCooldownState,
  refererMatchesHubOrigin,
  isTopLevelDocumentNavigation,
  shouldSkipSilentSsoPath,
  buildSilentLandPath,
  resolveSilentSsoStart,
  type CooldownState,
} from "./silent-sso.js";

export { validateOidcIdToken } from "./id-token.js";
export {
  validateLogoutToken,
  BACKCHANNEL_EVENT,
  type LogoutTokenClaims,
  type ValidateLogoutTokenInput,
} from "./logout-token.js";

export { buildAuthorizationRedirect } from "./authorize.js";
export { exchangeAuthorizationCode, buildEndSessionUrl } from "./token.js";
export {
  decodeJwtPayload,
  isIdTokenFreshForHint,
} from "./jwt-payload.js";

export {
  validateOidcPasskeyCredentialId,
  getOidcPasskeyAddAction,
  buildOidcPasskeyDeleteAction,
  deriveKeycloakAdminRealmBase,
} from "./passkey.js";

export {
  createSessionId,
  validateSession,
  deleteSessionsBySidOrSub,
  sessionCookie,
} from "./session.js";

export {
  MemorySessionStore,
  MemoryStateStore,
  MemoryUserResolver,
} from "./memory-stores.js";

export { toWebResponse, readFormOrJson } from "./http.js";

export {
  MwAuthClient,
  createAuthClient,
  type CreateAuthClientOptions,
} from "./client.js";
