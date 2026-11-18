import { DEFAULT_PASSKEY_ADD_ACTION } from "./config.js";

const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function validateOidcPasskeyCredentialId(
  raw: string | null | undefined,
): string | null {
  const id = String(raw || "").trim();
  if (!id || !CREDENTIAL_ID_RE.test(id)) return null;
  return id;
}

export function getOidcPasskeyAddAction(action?: string | null): string {
  const v = String(action || "").trim();
  return v || DEFAULT_PASSKEY_ADD_ACTION;
}

export function buildOidcPasskeyDeleteAction(credentialId: string): string {
  const id = validateOidcPasskeyCredentialId(credentialId);
  if (!id) throw new Error("OIDC_PASSKEY_INVALID_CREDENTIAL_ID");
  return `delete_credential:${id}`;
}

/**
 * Derive Keycloak Admin realm base from OIDC issuer.
 * Never hardcodes host or realm.
 */
export function deriveKeycloakAdminRealmBase(issuer: string): string | null {
  try {
    const u = new URL(issuer);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const m = u.pathname.replace(/\/$/, "").match(/\/realms\/([^/]+)$/);
    if (!m) return null;
    return `${u.origin}/admin/realms/${encodeURIComponent(m[1]!)}`;
  } catch {
    return null;
  }
}
