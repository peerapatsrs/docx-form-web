import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { getAppBaseUrl } from "@/lib/app-base-url";
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

export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount: number | null }>;

export type WithTransactionFn = <T>(
  fn: (query: QueryFn) => Promise<T>,
) => Promise<T>;

/** Thrown when OIDC_TRUST_IDP_EMAIL=false and IdP email is unverified but an app user already exists. */
export class OidcEmailUnverifiedError extends Error {
  readonly code = "OIDC_EMAIL_UNVERIFIED";
  constructor(message = "OIDC_EMAIL_UNVERIFIED") {
    super(message);
    this.name = "OidcEmailUnverifiedError";
  }
}

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
          silent boolean NOT NULL DEFAULT false,
          "expiresAt" timestamptz NOT NULL,
          "createdAt" timestamptz NOT NULL DEFAULT NOW()
        )
      `);
      // Additive — existing deployments created the table before `silent` existed.
      await q(`
        ALTER TABLE oidc_login_state
          ADD COLUMN IF NOT EXISTS silent boolean NOT NULL DEFAULT false
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

/**
 * Keycloak Trust Email: app trusts IdP identity by default.
 * Set OIDC_TRUST_IDP_EMAIL=0|false|no|off to require IdP email_verified for linking.
 */
export function isOidcTrustIdpEmail(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = String(envSource.OIDC_TRUST_IDP_EMAIL ?? "true")
    .trim()
    .toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

async function withAuthTransaction<T>(
  fn: (query: QueryFn) => Promise<T>,
): Promise<T> {
  const pool = getAuthPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: QueryFn = async <TRow extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: unknown[],
    ) => client.query<TRow>(sql, params);
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
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

/** Look up IdP subject for an app user (own credentials listing). */
export async function findIdentityByIssuerAndUserId(
  issuer: string,
  userId: string,
  query: QueryFn = defaultQuery(),
): Promise<IdentityRow | null> {
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const { rows } = await query<IdentityRow>(
    `SELECT id, issuer, subject, "userId" as "userId", email,
            "emailVerified" as "emailVerified"
     FROM identities
     WHERE issuer = $1 AND "userId" = $2
     LIMIT 1`,
    [issuer.replace(/\/$/, ""), uid],
  );
  return rows[0] ?? null;
}

/** Case-insensitive email lookup — does NOT require app emailVerified. */
export async function findUserIdByEmail(
  email: string,
  query: QueryFn = defaultQuery(),
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM "user"
     WHERE lower(email) = $1
     LIMIT 1`,
    [normalized],
  );
  return rows[0]?.id ?? null;
}

/** @deprecated use findUserIdByEmail — kept for callers that still import the name. */
export async function findUserIdByVerifiedEmail(
  email: string,
  query: QueryFn = defaultQuery(),
): Promise<string | null> {
  return findUserIdByEmail(email, query);
}

async function markUserEmailVerified(
  userId: string,
  query: QueryFn,
): Promise<void> {
  await query(
    `UPDATE "user"
     SET "emailVerified" = true, "updatedAt" = NOW()
     WHERE id = $1 AND "emailVerified" IS DISTINCT FROM true`,
    [userId],
  );
}

export async function createAppUserFromOidc(
  claims: OidcIdTokenClaims,
  query: QueryFn = defaultQuery(),
): Promise<{ userId: string; created: boolean }> {
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
  // Linked / created via trusted IdP → mark verified in app.
  const emailVerified = true;
  const role = isSuperAdminEmail(email) ? "superadmin" : "user";
  const plan = role === "superadmin" ? "pro" : "free";
  const image =
    typeof claims.picture === "string" && claims.picture.trim()
      ? claims.picture.trim()
      : null;

  const inserted = await query<{ id: string }>(
    `INSERT INTO "user" (
       id, name, email, "emailVerified", image,
       "createdAt", "updatedAt", role, plan
     ) VALUES (
       $1, $2, $3, $4, $5, NOW(), NOW(), $6, $7
     )
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [id, name, email, emailVerified, image, role, plan],
  );
  if (inserted.rows[0]?.id) {
    return { userId: inserted.rows[0].id, created: true };
  }

  // Race: another request created the same email — link to that row (no duplicate).
  const existingId = await findUserIdByEmail(email, query);
  if (existingId) {
    await markUserEmailVerified(existingId, query);
    return { userId: existingId, created: false };
  }
  throw new Error("OIDC_USER_CREATE_CONFLICT");
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
  const id = randomUUID();
  const { rows } = await query<IdentityRow>(
    `INSERT INTO identities (
       id, issuer, subject, "userId", email, "emailVerified",
       "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (issuer, subject) DO UPDATE SET
       "userId" = EXCLUDED."userId",
       email = EXCLUDED.email,
       "emailVerified" = EXCLUDED."emailVerified",
       "updatedAt" = NOW()
     RETURNING id, issuer, subject, "userId" as "userId", email,
               "emailVerified" as "emailVerified"`,
    [
      id,
      issuer,
      input.subject,
      input.userId,
      input.email ?? null,
      input.emailVerified,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("OIDC_IDENTITY_UPSERT_FAILED");
  }
  return row;
}

/**
 * Resolve app user for validated ID-token claims (single transaction):
 * 1) existing (issuer, sub) identity
 * 2) case-insensitive email match (no app emailVerified required;
 *    IdP email_verified gate controlled by OIDC_TRUST_IDP_EMAIL, default true)
 * 3) create new user (ON CONFLICT email → link existing)
 * Keeps role/plan/superadmin; sets emailVerified=true on link (update only).
 */
export async function resolveUserForOidcClaims(
  claims: OidcIdTokenClaims,
  deps: {
    query?: QueryFn;
    withTransaction?: WithTransactionFn;
    trustIdpEmail?: boolean;
  } = {},
): Promise<{
  userId: string;
  linkedBy: "identity" | "email" | "created";
}> {
  const trustIdpEmail =
    deps.trustIdpEmail ?? isOidcTrustIdpEmail();
  const runTx =
    deps.withTransaction ??
    (deps.query
      ? async <T>(fn: (q: QueryFn) => Promise<T>) => fn(deps.query!)
      : withAuthTransaction);

  return runTx(async (query) => {
    await ensureOidcIdentitiesSchema(query);

    const issuer = claims.iss.replace(/\/$/, "");
    const emailRaw =
      typeof claims.email === "string" && claims.email.trim()
        ? claims.email.trim()
        : null;
    const emailNorm = emailRaw ? emailRaw.toLowerCase() : null;
    const idpVerified = claims.email_verified === true;

    const existing = await findIdentityByIssuerSub(
      issuer,
      claims.sub,
      query,
    );
    if (existing) {
      await upsertIdentity({
        issuer,
        subject: claims.sub,
        userId: existing.userId,
        email: emailNorm,
        emailVerified: true,
        query,
      });
      await markUserEmailVerified(existing.userId, query);
      return { userId: existing.userId, linkedBy: "identity" as const };
    }

    const mayLinkByEmail = Boolean(emailNorm) && (trustIdpEmail || idpVerified);

    if (emailNorm && !mayLinkByEmail) {
      // Trust off + IdP unverified: never create a duplicate of an existing account.
      const conflictId = await findUserIdByEmail(emailNorm, query);
      if (conflictId) {
        throw new OidcEmailUnverifiedError();
      }
    }

    if (mayLinkByEmail && emailNorm) {
      const byEmail = await findUserIdByEmail(emailNorm, query);
      if (byEmail) {
        await markUserEmailVerified(byEmail, query);
        await upsertIdentity({
          issuer,
          subject: claims.sub,
          userId: byEmail,
          email: emailNorm,
          emailVerified: true,
          query,
        });
        return { userId: byEmail, linkedBy: "email" as const };
      }
    }

    const created = await createAppUserFromOidc(claims, query);
    await upsertIdentity({
      issuer,
      subject: claims.sub,
      userId: created.userId,
      email: emailNorm,
      emailVerified: true,
      query,
    });
    await markUserEmailVerified(created.userId, query);

    return {
      userId: created.userId,
      linkedBy: created.created ? ("created" as const) : ("email" as const),
    };
  });
}

export async function saveOidcLoginState(input: {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /** prompt=none silent SSO — quiet fail on login_required. */
  silent?: boolean;
  ttlSec?: number;
  query?: QueryFn;
}): Promise<void> {
  const query = input.query ?? defaultQuery();
  await ensureOidcIdentitiesSchema(query);
  const ttl = input.ttlSec ?? 600;
  const silent = Boolean(input.silent);
  await query(
    `INSERT INTO oidc_login_state (state, nonce, "codeVerifier", "returnTo", silent, "expiresAt")
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6::int))
     ON CONFLICT (state) DO UPDATE SET
       nonce = EXCLUDED.nonce,
       "codeVerifier" = EXCLUDED."codeVerifier",
       "returnTo" = EXCLUDED."returnTo",
       silent = EXCLUDED.silent,
       "expiresAt" = EXCLUDED."expiresAt"`,
    [
      input.state,
      input.nonce,
      input.codeVerifier,
      input.returnTo,
      silent,
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
  silent: boolean;
} | null> {
  await ensureOidcIdentitiesSchema(query);
  const { rows } = await query<{
    nonce: string;
    codeVerifier: string;
    returnTo: string;
    silent: boolean;
    expiresAt: Date;
  }>(
    `DELETE FROM oidc_login_state
     WHERE state = $1
     RETURNING nonce, "codeVerifier" as "codeVerifier", "returnTo" as "returnTo",
               silent, "expiresAt" as "expiresAt"`,
    [state],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return {
    nonce: row.nonce,
    codeVerifier: row.codeVerifier,
    returnTo: row.returnTo || "/",
    silent: Boolean(row.silent),
  };
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function decodeUriComponentSafe(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Same-origin relative return paths only.
 * Accepts `/` or `/` + a non-`/` / non-`\` character (e.g. `/account`).
 * Rejects protocol-relative (`//`), backslash tricks (`/\`, `\\`), encoded
 * `%2F%2F` / `%5C`, and control characters. Verified by resolving against
 * APP_BASE_URL (or `baseUrl`) and comparing origins.
 */
export function safeOidcReturnTo(
  raw: string | null | undefined,
  fallback = "/",
  baseUrl?: string,
): string {
  const v = String(raw || "").trim();
  if (!v) return fallback;
  if (hasControlChars(v)) return fallback;
  // Raw backslash (incl. `/\…`, `\\…`) — never treat as a path separator.
  if (v.includes("\\")) return fallback;
  if (!v.startsWith("/")) return fallback;
  // Single `/` is fine; otherwise the next char must not be `/` or `\`.
  if (v.length > 1 && (v[1] === "/" || v[1] === "\\")) return fallback;

  // Decode once (and a second pass) to catch `%2F%2F`, `%5C`, `%252F`, …
  let decoded = decodeUriComponentSafe(v);
  if (decoded == null) return fallback;
  if (hasControlChars(decoded) || decoded.includes("\\")) return fallback;
  if (!decoded.startsWith("/")) return fallback;
  if (decoded.length > 1 && (decoded[1] === "/" || decoded[1] === "\\")) {
    return fallback;
  }
  const decoded2 = decodeUriComponentSafe(decoded);
  if (decoded2 != null && decoded2 !== decoded) {
    if (hasControlChars(decoded2) || decoded2.includes("\\")) return fallback;
    if (!decoded2.startsWith("/")) return fallback;
    if (
      decoded2.length > 1 &&
      (decoded2[1] === "/" || decoded2[1] === "\\")
    ) {
      return fallback;
    }
    decoded = decoded2;
  }

  const base = String(baseUrl || getAppBaseUrl() || "http://localhost:3000")
    .trim()
    .replace(/\/$/, "");
  try {
    const baseOrigin = new URL(base).origin;
    const resolved = new URL(decoded, base);
    if (resolved.origin !== baseOrigin) return fallback;
    const out = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // Re-check the resolved path shape (URL may normalize oddly).
    if (!out.startsWith("/")) return fallback;
    if (out.length > 1 && (out[1] === "/" || out[1] === "\\")) return fallback;
    if (out.includes("\\") || hasControlChars(out)) return fallback;
    return out || fallback;
  } catch {
    return fallback;
  }
}
