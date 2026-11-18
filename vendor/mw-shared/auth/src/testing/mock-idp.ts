import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
} from "jose";
import { BACKCHANNEL_EVENT } from "../core/logout-token.js";

export type MockOidcIdpOptions = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Base URL served by the mock (authorization/token/jwks). */
  baseUrl?: string;
};

export type MockOidcIdp = {
  issuer: string;
  clientId: string;
  jwks: JSONWebKeySet;
  privateJwk: JWK;
  kid: string;
  metadata: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    end_session_endpoint: string;
  };
  /** Sign an ID token. */
  signIdToken: (claims: Record<string, unknown>) => Promise<string>;
  /** Sign a back-channel logout_token. */
  signLogoutToken: (claims: {
    sub?: string;
    sid?: string;
    jti?: string;
    nonce?: string;
    omitEvent?: boolean;
    omitJti?: boolean;
    omitExp?: boolean;
    iat?: number;
    exp?: number;
  }) => Promise<string>;
  /** Rotate keys (new kid) — for unknown-kid refetch tests. */
  rotateKeys: () => Promise<void>;
  /** Register an auth code for the mock token endpoint. */
  registerCode: (
    code: string,
    data: { nonce: string; sub: string; sid?: string },
  ) => void;
  /** Fetch-compatible handler for discovery / jwks / token. */
  fetch: typeof fetch;
};

export async function createMockOidcIdp(
  opts: MockOidcIdpOptions,
): Promise<MockOidcIdp> {
  const issuer = opts.issuer.replace(/\/$/, "");
  const base = (opts.baseUrl || issuer).replace(/\/$/, "");
  let kid = "mock-kid-1";
  let { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  let privateJwk = await exportJWK(privateKey);
  privateJwk.kid = kid;
  privateJwk.alg = "RS256";
  let publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const metadata = {
    issuer,
    authorization_endpoint: `${base}/protocol/openid-connect/auth`,
    token_endpoint: `${base}/protocol/openid-connect/token`,
    jwks_uri: `${base}/protocol/openid-connect/certs`,
    end_session_endpoint: `${base}/protocol/openid-connect/logout`,
  };

  const getJwks = (): JSONWebKeySet => ({ keys: [{ ...publicJwk }] });

  const signIdToken = async (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(opts.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  };

  const signLogoutToken = async (claims: {
    sub?: string;
    sid?: string;
    jti?: string;
    nonce?: string;
    omitEvent?: boolean;
    omitJti?: boolean;
    omitExp?: boolean;
    iat?: number;
    exp?: number;
  }) => {
    const now = Math.floor(Date.now() / 1000);
    const iat = claims.iat ?? now;
    const payload: Record<string, unknown> = {};
    if (!claims.omitJti) {
      payload.jti = claims.jti ?? `jti-${now}`;
    }
    if (claims.sub) payload.sub = claims.sub;
    if (claims.sid) payload.sid = claims.sid;
    if (claims.nonce !== undefined) payload.nonce = claims.nonce;
    if (!claims.omitEvent) {
      payload.events = { [BACKCHANNEL_EVENT]: {} };
    }
    let builder = new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(opts.clientId)
      .setIssuedAt(iat);
    if (!claims.omitExp) {
      builder = builder.setExpirationTime(claims.exp ?? iat + 300);
    }
    return builder.sign(privateKey);
  };

  const rotateKeys = async () => {
    kid = `mock-kid-${Date.now()}`;
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    privateJwk = await exportJWK(privateKey);
    privateJwk.kid = kid;
    privateJwk.alg = "RS256";
    publicJwk = await exportJWK(publicKey);
    publicJwk.kid = kid;
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";
  };

  const codes = new Map<
    string,
    { nonce: string; sub: string; sid?: string; codeVerifier?: string }
  >();

  /** Register an auth code the mock token endpoint will redeem. */
  const registerCode = (
    code: string,
    data: { nonce: string; sub: string; sid?: string },
  ) => {
    codes.set(code, data);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path.endsWith("/.well-known/openid-configuration")) {
      return Response.json(metadata);
    }
    if (path.endsWith("/protocol/openid-connect/certs")) {
      return Response.json(getJwks());
    }
    if (path.endsWith("/protocol/openid-connect/token")) {
      const body = String(init?.body || "");
      const params = new URLSearchParams(body);
      const code = params.get("code") || "";
      const entry = codes.get(code);
      if (!entry) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      codes.delete(code);
      const idToken = await signIdToken({
        sub: entry.sub,
        sid: entry.sid,
        nonce: entry.nonce,
        email: `${entry.sub}@example.test`,
        email_verified: true,
      });
      return Response.json({
        access_token: "mock-access",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 300,
      });
    }
    if (path.endsWith("/protocol/openid-connect/auth")) {
      return new Response("authorize ok", { status: 200 });
    }
    if (path.endsWith("/protocol/openid-connect/logout")) {
      return new Response("logged out", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const idp: MockOidcIdp = {
    issuer,
    clientId: opts.clientId,
    get jwks() {
      return getJwks();
    },
    get privateJwk() {
      return privateJwk;
    },
    get kid() {
      return kid;
    },
    metadata,
    signIdToken,
    signLogoutToken,
    rotateKeys,
    registerCode,
    fetch: fetchImpl,
  };

  return idp;
}
