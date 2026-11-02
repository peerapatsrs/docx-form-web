import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { admin } from "better-auth/plugins";
import { getAuthPool } from "./auth-db";
import { ac, roles } from "@/lib/auth-permissions";
import { isSuperAdminEmail } from "./auth-superadmin";
import { isDevAuthEnabled } from "@/lib/dev-auth-flag";
import { getBetterAuthBaseUrl } from "@/lib/app-base-url";

function env(name: string): string | undefined {
  const v = String(process.env[name] || "").trim();
  return v || undefined;
}

function baseURL(): string {
  return getBetterAuthBaseUrl();
}

function rpID(): string {
  try {
    return new URL(baseURL()).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/**
 * Only enable providers that have both client id + secret configured.
 * Google is the primary path; others appear when credentials exist.
 */
function buildSocialProviders() {
  /** @type {NonNullable<Parameters<typeof betterAuth>[0]>['socialProviders']} */
  const social: Record<
    string,
    {
      clientId: string;
      clientSecret: string;
      enabled?: boolean;
      /** Refresh name/image from the IdP on every sign-in (per-account avatars). */
      overrideUserInfoOnSignIn?: boolean;
    }
  > = {};

  const pairs: [string, string, string][] = [
    ["google", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["github", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    ["microsoft", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    ["apple", "APPLE_CLIENT_ID", "APPLE_CLIENT_SECRET"],
    ["discord", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
    ["facebook", "FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
    ["gitlab", "GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET"],
    ["linkedin", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    ["twitch", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"],
    ["twitter", "TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"],
    ["spotify", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    ["tiktok", "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET"],
    ["reddit", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
    ["line", "LINE_CLIENT_ID", "LINE_CLIENT_SECRET"],
    ["kakao", "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET"],
    ["notion", "NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
    ["slack", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    ["dropbox", "DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"],
    ["huggingface", "HUGGINGFACE_CLIENT_ID", "HUGGINGFACE_CLIENT_SECRET"],
    ["paypal", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
    ["salesforce", "SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"],
    ["zoom", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
  ];

  for (const [id, idKey, secretKey] of pairs) {
    const clientId = env(idKey);
    const clientSecret = env(secretKey);
    if (clientId && clientSecret) {
      social[id] = {
        clientId,
        clientSecret,
        // Keep avatar/name in sync with Google / Facebook / … on each login.
        overrideUserInfoOnSignIn: true,
      };
    }
  }

  return social;
}

const socialProviders = buildSocialProviders();

export const enabledOAuthProviders = Object.keys(socialProviders);

export const auth = betterAuth({
  appName: "docx-form",
  baseURL: baseURL(),
  secret:
    env("BETTER_AUTH_SECRET") ||
    env("AUTH_SECRET") ||
    // Build-time / local fallback only — set BETTER_AUTH_SECRET in production.
    "docx-form-dev-secret-change-me-32b",
  database: getAuthPool(),
  emailAndPassword: {
    // Password auth off — OAuth + passkeys only (phishing-resistant by default).
    enabled: false,
  },
  user: {
    additionalFields: {
      /**
       * Billing plan until Stripe — superadmin toggles via /admin.
       * free → multi-file cap 2 · pro → cap 10
       */
      plan: {
        type: "string",
        required: false,
        defaultValue: "free",
        // Admin UI writes via /api/admin/plan; keep readable on session.
        input: false,
      },
    },
  },
  socialProviders,
  /**
   * OAuth state lives in Postgres (`verification`). Skip the extra signed
   * `better-auth.state` cookie check — Cursor preview / some browsers drop that
   * short-lived cookie on the Google → localhost round-trip, which surfaces as
   * `state_mismatch` ("State not persisted correctly") even when the DB row exists.
   * CSRF is still covered by the random `state` param stored server-side.
   */
  account: {
    storeStateStrategy: "database",
    skipStateCookieCheck: true,
    // When linking Google/Facebook/… copy that account's profile image/name.
    updateUserInfoOnLink: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
    // Cookie cache can serve a stale user.image after IdP refresh — always
    // read the live session so per-account avatars stay correct.
    cookieCache: {
      enabled: false,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 40,
    // Passkey challenge minting is cheap to abuse — tighter than global auth traffic.
    customRules: {
      "/passkey/generate-register-options": {
        window: 60,
        max: 8,
      },
      "/passkey/generate-authenticate-options": {
        window: 60,
        max: 10,
      },
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    defaultCookieAttributes: {
      sameSite: "lax",
      path: "/",
      // Dev is http://localhost — never force Secure here.
      secure: process.env.NODE_ENV === "production",
    },
    database: {
      // Generate IDs server-side
      generateId: undefined,
    },
  },
  trustedOrigins: [
    baseURL(),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ].filter(Boolean),
  databaseHooks: {
    user: {
      create: {
        async before(user) {
          if (!isSuperAdminEmail(user.email)) return;
          return {
            data: { ...user, role: "superadmin", plan: "pro" },
          };
        },
      },
    },
  },
  plugins: [
    admin({
      ac,
      roles,
      defaultRole: "user",
      adminRoles: ["admin", "superadmin"],
    }),
    passkey({
      rpID: rpID(),
      rpName: "docx-form",
      origin: baseURL(),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    }),
    // Local only: /api/auth/dev/users + /api/auth/dev/login-as (not registered when disabled)
    ...(() => {
      if (!isDevAuthEnabled()) return [];
      // Lazy load so production deployments with DEV_AUTH off never mount the routes.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- conditional load
      const { devAuthPlugin } = require("./dev-auth-plugin") as typeof import("./dev-auth-plugin");
      return [devAuthPlugin()];
    })(),
  ],
});

export type Session = typeof auth.$Infer.Session;
