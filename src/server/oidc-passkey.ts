import {
  getOidcConfig,
  type OidcConfig,
} from "./oidc-config";
import {
  findIdentityByIssuerAndUserId,
} from "./oidc-identities";
import type { DiscoveryFetch } from "./oidc-discovery";

/** Default Keycloak AIA for registering a passwordless WebAuthn credential. */
export const DEFAULT_OIDC_PASSKEY_ADD_ACTION =
  "webauthn-register-passwordless";

/** Credential type returned by Keycloak Admin API for passwordless passkeys. */
export const KEYCLOAK_WEBAUTHN_PASSWORDLESS = "webauthn-passwordless";

const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type OidcPasskeyCredential = {
  id: string;
  label: string;
  createdAt: string | null;
  type: string;
};

export type OidcAdminConfig = {
  tokenUrl: string;
  adminRealmBase: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Validate Keycloak credential id for `delete_credential:<id>` AIA.
 * Rejects empty, oversized, or characters that break kc_action encoding.
 */
export function validateOidcPasskeyCredentialId(
  raw: string | null | undefined,
): string | null {
  const id = String(raw || "").trim();
  if (!id || !CREDENTIAL_ID_RE.test(id)) return null;
  return id;
}

export function getOidcPasskeyAddAction(
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  const v = String(envSource.OIDC_PASSKEY_ADD_ACTION || "").trim();
  return v || DEFAULT_OIDC_PASSKEY_ADD_ACTION;
}

export function buildOidcPasskeyDeleteAction(credentialId: string): string {
  const id = validateOidcPasskeyCredentialId(credentialId);
  if (!id) throw new Error("OIDC_PASSKEY_INVALID_CREDENTIAL_ID");
  return `delete_credential:${id}`;
}

/**
 * Derive Keycloak Admin realm base from OIDC issuer:
 * `{origin}/realms/{realm}` → `{origin}/admin/realms/{realm}`.
 * Never hardcodes host or realm.
 */
export function deriveKeycloakAdminRealmBase(issuer: string): string | null {
  try {
    const u = new URL(issuer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const m = u.pathname.replace(/\/$/, "").match(/\/realms\/([^/]+)$/);
    if (!m) return null;
    return `${u.origin}/admin/realms/${encodeURIComponent(m[1])}`;
  } catch {
    return null;
  }
}

/**
 * Service-account Admin API config. Null when OIDC or admin client env missing.
 */
export function getOidcAdminConfig(
  envSource: NodeJS.ProcessEnv = process.env,
): OidcAdminConfig | null {
  const oidc = getOidcConfig(envSource);
  if (!oidc) return null;
  const clientId = String(envSource.OIDC_ADMIN_CLIENT_ID || "").trim();
  const clientSecret = String(envSource.OIDC_ADMIN_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  const adminRealmBase = deriveKeycloakAdminRealmBase(oidc.issuer);
  if (!adminRealmBase) return null;
  return {
    tokenUrl: `${oidc.issuer}/protocol/openid-connect/token`,
    adminRealmBase,
    clientId,
    clientSecret,
  };
}

export function isOidcPasskeyListingEnabled(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  return getOidcAdminConfig(envSource) !== null;
}

async function fetchAdminAccessToken(
  admin: OidcAdminConfig,
  fetchFn: DiscoveryFetch = fetch,
): Promise<string> {
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", admin.clientId);
  body.set("client_secret", admin.clientSecret);
  const res = await fetchFn(admin.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`OIDC_ADMIN_TOKEN_HTTP_${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  const token = String(json.access_token || "").trim();
  if (!token) throw new Error("OIDC_ADMIN_TOKEN_MISSING");
  return token;
}

type KeycloakCredentialRaw = {
  id?: string;
  type?: string;
  userLabel?: string;
  createdDate?: number | string;
};

/**
 * List the signed-in user's own Keycloak webauthn-passwordless credentials.
 * `keycloakSub` must come from identities for the session user — never from input.
 */
export async function listOwnOidcPasskeys(input: {
  keycloakSub: string;
  config?: OidcConfig | null;
  admin?: OidcAdminConfig | null;
  fetchFn?: DiscoveryFetch;
}): Promise<{
  ok: true;
  credentials: OidcPasskeyCredential[];
} | { ok: false; status: number; error: string }> {
  const sub = String(input.keycloakSub || "").trim();
  if (!sub || sub.includes("/") || sub.includes("..")) {
    return { ok: false, status: 400, error: "OIDC_PASSKEY_BAD_SUB" };
  }
  const admin =
    input.admin === undefined ? getOidcAdminConfig() : input.admin;
  if (!admin) {
    return { ok: false, status: 404, error: "OIDC_ADMIN_DISABLED" };
  }

  try {
    const fetchFn = input.fetchFn ?? fetch;
    const token = await fetchAdminAccessToken(admin, fetchFn);
    const url = `${admin.adminRealmBase}/users/${encodeURIComponent(sub)}/credentials`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      throw new Error(`OIDC_ADMIN_CREDS_HTTP_${res.status}`);
    }
    const raw = (await res.json()) as KeycloakCredentialRaw[];
    if (!Array.isArray(raw)) {
      throw new Error("OIDC_ADMIN_CREDS_SHAPE");
    }
    const credentials: OidcPasskeyCredential[] = raw
      .filter((c) => String(c.type || "") === KEYCLOAK_WEBAUTHN_PASSWORDLESS)
      .map((c) => {
        const id = String(c.id || "").trim();
        const createdMs =
          typeof c.createdDate === "number"
            ? c.createdDate
            : typeof c.createdDate === "string" && /^\d+$/.test(c.createdDate)
              ? Number(c.createdDate)
              : NaN;
        return {
          id,
          label: String(c.userLabel || "").trim() || "Passkey",
          createdAt: Number.isFinite(createdMs)
            ? new Date(createdMs).toISOString()
            : null,
          type: KEYCLOAK_WEBAUTHN_PASSWORDLESS,
        };
      })
      .filter((c) => validateOidcPasskeyCredentialId(c.id));
    return { ok: true, credentials };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "OIDC_ADMIN_LIST_FAILED";
    console.error("[oidc] passkey list failed:", msg);
    return { ok: false, status: 502, error: "OIDC_ADMIN_LIST_FAILED" };
  }
}

/** Resolve Keycloak `sub` for an app user id from identities (own only). */
export async function resolveOwnKeycloakSub(input: {
  userId: string;
  issuer?: string;
}): Promise<string | null> {
  const oidc = getOidcConfig();
  const issuer = (input.issuer || oidc?.issuer || "").replace(/\/$/, "");
  if (!issuer || !input.userId) return null;
  const row = await findIdentityByIssuerAndUserId(issuer, input.userId);
  return row?.subject ?? null;
}

/** Append `passkey=` status to a safe return path (Thai UI reads this). */
export function appendOidcPasskeyStatusParam(
  returnTo: string,
  status: "success" | "cancelled" | "error",
): string {
  const path = returnTo.startsWith("/") ? returnTo : "/account";
  try {
    const u = new URL(path, "http://oidc.local");
    u.searchParams.set("passkey", status);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return `/account?passkey=${status}`;
  }
}

export function normalizeKcActionStatus(
  raw: string | null | undefined,
): "success" | "cancelled" | "error" | null {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "success" || v === "cancelled" || v === "error") return v;
  return null;
}
