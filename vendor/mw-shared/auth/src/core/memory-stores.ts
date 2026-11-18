import type { StateStore, SessionStore, UserResolver } from "./interfaces.js";
import type {
  PendingAuthState,
  SessionRecord,
  OidcIdTokenClaims,
  ResolvedUser,
} from "./types.js";

/** In-memory SessionStore for tests and local demos. */
export class MemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, SessionRecord>();

  async create(session: SessionRecord): Promise<SessionRecord> {
    this.byId.set(session.sessionId, { ...session });
    return { ...session };
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.byId.get(sessionId) ?? null;
  }

  async delete(sessionId: string): Promise<void> {
    this.byId.delete(sessionId);
  }

  async findBySid(sid: string): Promise<SessionRecord[]> {
    return [...this.byId.values()].filter((s) => s.sid === sid);
  }

  async findBySub(sub: string): Promise<SessionRecord[]> {
    return [...this.byId.values()].filter((s) => s.sub === sub);
  }

  clear(): void {
    this.byId.clear();
  }
}

/** In-memory StateStore (+ jti replay set). */
export class MemoryStateStore implements StateStore {
  private readonly states = new Map<string, PendingAuthState>();
  private readonly jtis = new Map<string, number>();

  async save(state: PendingAuthState): Promise<void> {
    this.states.set(state.state, { ...state });
  }

  async consume(state: string): Promise<PendingAuthState | null> {
    const pending = this.states.get(state) ?? null;
    this.states.delete(state);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) return null;
    return pending;
  }

  async seenJti(jti: string, expiresAtMs: number): Promise<boolean> {
    const now = Date.now();
    for (const [k, exp] of this.jtis) {
      if (exp < now) this.jtis.delete(k);
    }
    if (this.jtis.has(jti)) return true;
    this.jtis.set(jti, expiresAtMs);
    return false;
  }

  clear(): void {
    this.states.clear();
    this.jtis.clear();
  }
}

/** Simple UserResolver: link by sub map, else create from email/sub. */
export class MemoryUserResolver implements UserResolver {
  private readonly bySub = new Map<string, string>();
  private readonly byEmail = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly opts: {
      trustIdpEmail?: boolean;
    } = {},
  ) {}

  seed(sub: string, userId: string, email?: string): void {
    this.bySub.set(sub, userId);
    if (email) this.byEmail.set(email.toLowerCase(), userId);
  }

  async resolve(
    claims: OidcIdTokenClaims,
    _issuer: string,
  ): Promise<ResolvedUser> {
    const existing = this.bySub.get(claims.sub);
    if (existing) {
      return { userId: existing, linkedBy: "identity" };
    }
    const trust = this.opts.trustIdpEmail !== false;
    const email = claims.email?.toLowerCase();
    if (
      email &&
      (trust || claims.email_verified) &&
      this.byEmail.has(email)
    ) {
      const userId = this.byEmail.get(email)!;
      this.bySub.set(claims.sub, userId);
      return { userId, linkedBy: "email", email };
    }
    this.seq += 1;
    const userId = `user_${this.seq}`;
    this.bySub.set(claims.sub, userId);
    if (email) this.byEmail.set(email, userId);
    return { userId, linkedBy: "created", email, isNew: true };
  }
}
