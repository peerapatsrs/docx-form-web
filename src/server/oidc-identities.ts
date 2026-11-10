import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { getAuthPool } from "./auth-db";
import type { OidcIdTokenClaims } from "./oidc-id-token";
import { isSuperAdminEmail } from "./auth-superadmin";

export type IdentityRow = {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
  email: string | null;
  emailVerified: boolean;
};

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

let schemaReady: Promise<void> | null = null;

/**
 * Map IdP subjects by (issuer, sub). Roles stay on app `"user".role`.
 */
export function ensureOidcIdentitiesSchema(
  query?: QueryFn,
): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q =
        query ??
        (async <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          params?: unknown[],
        ) => {
          const pool = getAuthPool();
          return pool.query<T>(sql, params);
        });
      await q(`
        CREATE TABLE IF NOT EXISTS identities (
          id text PRIMARY KEY,
          issuer text NOT NULL,
          subject text NOT NULL,
          "userId" text NOT NULL,
          email text,
          "emailVerified" boolean NOT NULL DEFAULT false,
          "createdAt" timestamptz NOT NULL DEFAULT NOW(),
          "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
          UNIQUE (issuer, subject)
        )
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS identities_user_idx
          ON identities ("userId")
      `);
      await q(`
        CREATE TABLE IF NOT EXISTS oidc_login_state (
          state text PRIMARY KEY,
          nonce text NOT NULL,
          "codeVerifier" text NOT NULL,
          "returnTo" text NOT NULL DEFAULT '/',
          "expiresAt" timestamptz NOT NULL,
          "createdAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS oidc_login_state_expires_idx
          ON oidc_login_state ("expiresAt")
      `);
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** Test helper. */
export function resetOidcIdentitiesSchemaGate(): void {
  schemaReady = null;
}

function defaultQuery(): QueryFn {
  return async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => {
    const pool = getAuthPool();
    return pool.query<T>(sql, params);
  };
}

export async function findIdentityByIssuerSub(
  issuer: string,
  subject: string,
  query: QueryFn = defaultQuery(),
): Promise<IdentityRow | null> {
  const { rows } = await query<IdentityRow>(
    `SELECT id, issuer, subject, "userId" as "userId", email,
            "emailVerified" as "emailVerified"
     FROM identities
     WHERE issuer = $1 AND subject = $2
     LIMIT 1`,
    [issuer.replace(/\/$/, ""), subject],
  );
  return rows[0] ?? null;
}

export async function findUserIdByVerifiedEmail(
  email: string,
  query: QueryFn = defaultQuery(),
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM "user"
     WHERE lower(email) = $1 AND "emailVerified" = true
     LIMIT 1`,
    [normalized],
  );
  return rows[0]?.id ?? null;
}

export async function createAppUserFromOidc(
  claims: OidcIdTokenClaims,
  query: QueryFn = defaultQuery(),
): Promise<string> {
  const id = randomUUID();
  const email =
    typeof claims.email === "string" && claims.email.trim()
      ? claims.email.trim().toLowerCase()
      : `${claims.sub}@oidc.local`;
  const name =
    (claims.name && claims.name.trim()) ||
    (claims.preferred_username && claims.preferred_username.trim()) ||
    email.split("@")[0] ||
    "User";
  const emailVerified = claims.email_verified === true;
  const role = isSuperAdminEmail(email) ? "superadmin" : "user";
  const plan = role === "superadmin" ? "pro" : "free";
  const image =
    typeof claims.picture === "string" && claims.picture.trim()
      ? claims.picture.trim()
      : null;

  await query(
    `INSERT INTO "user" (
       id, name, email, "emailVerified", image,
       "createdAt", "updatedAt", role, plan
     ) VALUES (
       $1, $2, $3, $4, $5, NOW(), NOW(), $6, $7
     )`,
    [id, name, email, emailVerified, image, role, plan],
  );
  return id;
}

export async function upsertIdentity(input: {
  issuer: string;
  subject: string;
  userId: string;
  email?: string | null;
  emailVerified: boolean;
  query?: QueryFn;
}): Promise<IdentityRow> {
  const query = input.query ?? defaultQuery();
  const issuer = input.issuer.replace(/\/$/, "");
  const existing = await findIdentityByIssuerSub(
    issuer,
    input.subject,
    query,
  );
  if (existing) {
    await query(
      `UPDATE identities
       SET "userId" = $1,
           email = $2,
           "emailVerified" = $3,
           "updatedAt" = NOW()
       WHERE id = $4`,
      [
        input.userId,
        input.email ?? null,
        input.emailVerified,
        existing.id,
      ],
    );
    return {
      ...existing,
      userId: input.userId,
      email: input.email ?? null,
      emailVerified: input.emailVerified,
    };
  }
  const id = randomUUID();
  await query(
    `INSERT INTO identities (
       id, issuer, subject, "userId", email, "emailVerified",
       "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [
      id,
      issuer,
      input.subject,
      input.userId,
      input.email ?? null,
      input.emailVerified,
    ],
  );
  return {
    id,
    issuer,
    subject: input.subject,
    userId: input.userId,
    email: input.email ?? null,
    emailVerified: input.emailVerified,
  };
}

/**
 * Resolve app user for validated ID-token claims:
 * 1) existing (issuer, sub) identity
 * 2) else link by email only when email_verified === true
 * 3) else create a new user (roles remain in app DB)
 */
export async function resolveUserForOidcClaims(
  claims: OidcIdTokenClaims,
  deps: { query?: QueryFn } = {},
): Promise<{ userId: string; linkedBy: "identity" | "email" | "created" }> {
  const query = deps.query ?? defaultQuery();
  await ensureOidcIdentitiesSchema(query);

  const issuer = claims.iss.replace(/\/$/, "");
  const existing = await findIdentityByIssuerSub(issuer, claims.sub, query);
  if (existing) {
    await upsertIdentity({
      issuer,
      subject: claims.sub,
      userId: existing.userId,
      email: claims.email ?? null,
      emailVerified: claims.email_verified === true,
      query,
    });
    return { userId: existing.userId, linkedBy: "identity" };
  }

  let userId: string | null = null;
  let linkedBy: "email" | "created" = "created";

  if (claims.email_verified === true && claims.email) {
    userId = await findUserIdByVerifiedEmail(claims.email, query);
    if (userId) linkedBy = "email";
  }

  if (!userId) {
    userId = await createAppUserFromOidc(claims, query);
    linkedBy = "created";
  }

  await upsertIdentity({
    issuer,
    subject: claims.sub,
    userId,
    email: claims.email ?? null,
    emailVerified: claims.email_verified === true,
    query,
  });

  return { userId, linkedBy };
}

export async function saveOidcLoginState(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  ttlSec?: number;
  query?: QueryFn;
}): Promise<void> {
  const query = input.query ?? defaultQuery();
  await ensureOidcIdentitiesSchema(query);
  const ttl = input.ttlSec ?? 600;
  await query(
    `INSERT INTO oidc_login_state (state, nonce, "codeVerifier", "returnTo", "expiresAt")
     VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5::int))
     ON CONFLICT (state) DO UPDATE SET
       nonce = EXCLUDED.nonce,
       "codeVerifier" = EXCLUDED."codeVerifier",
       "returnTo" = EXCLUDED."returnTo",
       "expiresAt" = EXCLUDED."expiresAt"`,
    [
      input.state,
      input.nonce,
      input.codeVerifier,
      input.returnTo,
      ttl,
    ],
  );
}

export async function consumeOidcLoginState(
  state: string,
  query: QueryFn = defaultQuery(),
): Promise<{
  nonce: string;
  codeVerifier: string;
  returnTo: string;
} | null> {
  await ensureOidcIdentitiesSchema(query);
  const { rows } = await query<{
    nonce: string;
    codeVerifier: string;
    returnTo: string;
    expiresAt: Date;
  }>(
    `DELETE FROM oidc_login_state
     WHERE state = $1
     RETURNING nonce, "codeVerifier" as "codeVerifier", "returnTo" as "returnTo", "expiresAt" as "expiresAt"`,
    [state],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return {
    nonce: row.nonce,
    codeVerifier: row.codeVerifier,
    returnTo: row.returnTo || "/",
  };
}

/** Only same-origin relative paths. */
export function safeOidcReturnTo(
  raw: string | null | undefined,
  fallback = "/",
): string {
  const v = String(raw || "").trim();
  if (!v.startsWith("/") || v.startsWith("//")) return fallback;
  return v;
}
