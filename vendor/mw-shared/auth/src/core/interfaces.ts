import type {
  PendingAuthState,
  SessionRecord,
  ResolvedUser,
  OidcIdTokenClaims,
} from "./types.js";

/** Persist / look up local app sessions. Apps provide Redis, Postgres, etc. */
export interface SessionStore {
  create(session: SessionRecord): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
  findBySid(sid: string): Promise<SessionRecord[]>;
  findBySub(sub: string): Promise<SessionRecord[]>;
}

/** Server-side OIDC state / PKCE / nonce / logout_token jti replay set. */
export interface StateStore {
  save(state: PendingAuthState): Promise<void>;
  consume(state: string): Promise<PendingAuthState | null>;
  /**
   * Back-channel logout replay guard (required).
   * Return true if `jti` was already seen; otherwise record it until `expiresAtMs`
   * and return false.
   */
  seenJti(jti: string, expiresAtMs: number): Promise<boolean>;
}

/**
 * Link OIDC claims to an app user. Apps decide identity tables / email policy.
 */
export interface UserResolver {
  resolve(claims: OidcIdTokenClaims, issuer: string): Promise<ResolvedUser>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured logger — never pass tokens, cookies, or PII. */
export interface Logger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

export type MwAuthDeps = {
  sessions: SessionStore;
  state: StateStore;
  users: UserResolver;
  logger?: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * Called after a successful *silent* login so apps can redirect
   * (e.g. no-tenant → /create-shop). Only invoked for silent flows.
   */
  onSilentLoginSuccess?: (
    ctx: import("./types.js").SilentSuccessHookContext,
  ) => Promise<string | null | undefined> | string | null | undefined;
};
