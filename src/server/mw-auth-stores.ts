/**
 * App-owned Postgres stores for @mw-shared/auth (state, jti replay, sid/sub index).
 * Additive schema only — never drops or alters existing data.
 */

import type { QueryResultRow } from "pg";
import type {
  PendingAuthState,
  SessionRecord,
  SessionStore,
  StateStore,
  UserResolver,
  OidcIdTokenClaims,
  ResolvedUser,
} from "@mw-shared/auth";
import { getAuthPool } from "./auth-db";
import {
  ensureOidcIdentitiesSchema,
  resolveUserForOidcClaims,
  OidcEmailUnverifiedError,
} from "./oidc-identities";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

let schemaReady: Promise<void> | null = null;

export function resetMwAuthStoresSchemaGate(): void {
  schemaReady = null;
}

export async function ensureMwAuthStoresSchema(
  query?: QueryFn,
): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureOidcIdentitiesSchema(query);
      const q =
        query ??
        (async <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          params?: unknown[],
        ) => getAuthPool().query<T>(sql, params));

      // Additive columns for module PendingAuthState (viaBypass / kcAction).
      await q(`
        ALTER TABLE oidc_login_state
          ADD COLUMN IF NOT EXISTS "viaBypass" boolean NOT NULL DEFAULT false
      `);
      await q(`
        ALTER TABLE oidc_login_state
          ADD COLUMN IF NOT EXISTS "kcAction" text
      `);

      await q(`
        CREATE TABLE IF NOT EXISTS oidc_logout_jti (
          jti text PRIMARY KEY,
          "expiresAt" timestamptz NOT NULL,
          "createdAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS oidc_logout_jti_expires_idx
          ON oidc_logout_jti ("expiresAt")
      `);

      // sid/sub → Better Auth session token for back-channel logout.
      await q(`
        CREATE TABLE IF NOT EXISTS oidc_session_index (
          "sessionId" text PRIMARY KEY,
          "userId" text NOT NULL,
          sub text NOT NULL,
          sid text,
          "expiresAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT NOW(),
          "updatedAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS oidc_session_index_sid_idx
          ON oidc_session_index (sid)
          WHERE sid IS NOT NULL
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS oidc_session_index_sub_idx
          ON oidc_session_index (sub)
      `);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function defaultQuery(): QueryFn {
  return async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => getAuthPool().query<T>(sql, params);
}

/** DB-backed StateStore (PKCE state + logout_token jti replay). */
export function createPgStateStore(): StateStore {
  const q = defaultQuery();
  return {
    async save(state: PendingAuthState): Promise<void> {
      await ensureMwAuthStoresSchema();
      await q(
        `INSERT INTO oidc_login_state
           (state, nonce, "codeVerifier", "returnTo", silent, "viaBypass", "kcAction", "expiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0))
         ON CONFLICT (state) DO UPDATE SET
           nonce = EXCLUDED.nonce,
           "codeVerifier" = EXCLUDED."codeVerifier",
           "returnTo" = EXCLUDED."returnTo",
           silent = EXCLUDED.silent,
           "viaBypass" = EXCLUDED."viaBypass",
           "kcAction" = EXCLUDED."kcAction",
           "expiresAt" = EXCLUDED."expiresAt"`,
        [
          state.state,
          state.nonce,
          state.codeVerifier,
          state.returnTo || "/",
          Boolean(state.silent),
          Boolean(state.viaBypass),
          state.kcAction ?? null,
          state.expiresAt,
        ],
      );
    },

    async consume(state: string): Promise<PendingAuthState | null> {
      await ensureMwAuthStoresSchema();
      const { rows } = await q<{
        state: string;
        nonce: string;
        codeVerifier: string;
        returnTo: string;
        silent: boolean;
        viaBypass: boolean;
        kcAction: string | null;
        expiresAt: Date;
      }>(
        `DELETE FROM oidc_login_state
         WHERE state = $1
         RETURNING state, nonce, "codeVerifier" as "codeVerifier",
                   "returnTo" as "returnTo", silent,
                   "viaBypass" as "viaBypass", "kcAction" as "kcAction",
                   "expiresAt" as "expiresAt"`,
        [state],
      );
      const row = rows[0];
      if (!row) return null;
      const expiresAt = new Date(row.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
      return {
        state: row.state,
        nonce: row.nonce,
        codeVerifier: row.codeVerifier,
        returnTo: row.returnTo || "/",
        silent: Boolean(row.silent),
        viaBypass: Boolean(row.viaBypass),
        kcAction: row.kcAction,
        expiresAt,
      };
    },

    async seenJti(jti: string, expiresAtMs: number): Promise<boolean> {
      await ensureMwAuthStoresSchema();
      const id = String(jti || "").trim();
      if (!id) return true;
      await q(`DELETE FROM oidc_logout_jti WHERE "expiresAt" < NOW()`);
      const { rows } = await q<{ jti: string }>(
        `INSERT INTO oidc_logout_jti (jti, "expiresAt")
         VALUES ($1, to_timestamp($2 / 1000.0))
         ON CONFLICT (jti) DO NOTHING
         RETURNING jti`,
        [id, expiresAtMs],
      );
      // Inserted → first sighting (not replay). Conflict → already seen.
      return rows.length === 0;
    },
  };
}

/** sid/sub index used by createBetterAuthSessionBridge. */
export function createPgSessionIndexStore(): SessionStore {
  const q = defaultQuery();
  return {
    async create(session: SessionRecord): Promise<SessionRecord> {
      await ensureMwAuthStoresSchema();
      await q(
        `INSERT INTO oidc_session_index
           ("sessionId", "userId", sub, sid, "expiresAt", "updatedAt")
         VALUES ($1, $2, $3, $4,
           CASE WHEN $5::bigint IS NULL THEN NULL
                ELSE to_timestamp($5 / 1000.0) END,
           NOW())
         ON CONFLICT ("sessionId") DO UPDATE SET
           "userId" = EXCLUDED."userId",
           sub = EXCLUDED.sub,
           sid = EXCLUDED.sid,
           "expiresAt" = EXCLUDED."expiresAt",
           "updatedAt" = NOW()`,
        [
          session.sessionId,
          session.userId,
          session.sub,
          session.sid ?? null,
          session.expiresAt ?? null,
        ],
      );
      return session;
    },

    async get(sessionId: string): Promise<SessionRecord | null> {
      await ensureMwAuthStoresSchema();
      const { rows } = await q<{
        sessionId: string;
        userId: string;
        sub: string;
        sid: string | null;
        expiresAt: Date | null;
      }>(
        `SELECT "sessionId" as "sessionId", "userId" as "userId", sub, sid,
                "expiresAt" as "expiresAt"
         FROM oidc_session_index
         WHERE "sessionId" = $1
         LIMIT 1`,
        [sessionId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        sessionId: row.sessionId,
        userId: row.userId,
        sub: row.sub,
        sid: row.sid,
        expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
      };
    },

    async delete(sessionId: string): Promise<void> {
      await ensureMwAuthStoresSchema();
      await q(`DELETE FROM oidc_session_index WHERE "sessionId" = $1`, [
        sessionId,
      ]);
    },

    async findBySid(sid: string): Promise<SessionRecord[]> {
      await ensureMwAuthStoresSchema();
      const { rows } = await q<{
        sessionId: string;
        userId: string;
        sub: string;
        sid: string | null;
        expiresAt: Date | null;
      }>(
        `SELECT "sessionId" as "sessionId", "userId" as "userId", sub, sid,
                "expiresAt" as "expiresAt"
         FROM oidc_session_index
         WHERE sid = $1`,
        [sid],
      );
      return rows.map((row) => ({
        sessionId: row.sessionId,
        userId: row.userId,
        sub: row.sub,
        sid: row.sid,
        expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
      }));
    },

    async findBySub(sub: string): Promise<SessionRecord[]> {
      await ensureMwAuthStoresSchema();
      const { rows } = await q<{
        sessionId: string;
        userId: string;
        sub: string;
        sid: string | null;
        expiresAt: Date | null;
      }>(
        `SELECT "sessionId" as "sessionId", "userId" as "userId", sub, sid,
                "expiresAt" as "expiresAt"
         FROM oidc_session_index
         WHERE sub = $1`,
        [sub],
      );
      return rows.map((row) => ({
        sessionId: row.sessionId,
        userId: row.userId,
        sub: row.sub,
        sid: row.sid,
        expiresAt: row.expiresAt ? new Date(row.expiresAt).getTime() : null,
      }));
    },
  };
}

/** UserResolver → existing identities / email link / create path. */
export function createAppUserResolver(): UserResolver {
  return {
    async resolve(
      claims: OidcIdTokenClaims,
      _issuer: string,
    ): Promise<ResolvedUser> {
      try {
        const result = await resolveUserForOidcClaims(claims);
        return {
          userId: result.userId,
          linkedBy: result.linkedBy,
        };
      } catch (err) {
        if (err instanceof OidcEmailUnverifiedError) throw err;
        throw err;
      }
    },
  };
}
