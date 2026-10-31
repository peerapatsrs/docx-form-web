import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { getAuthSqlite } from "./auth-db";

function env(name: string): string | undefined {
  const v = String(process.env[name] || "").trim();
  return v || undefined;
}

function baseURL(): string {
  return (
    env("BETTER_AUTH_URL") ||
    env("NEXT_PUBLIC_APP_URL") ||
    "http://localhost:3000"
  );
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
  const social: Record<string, { clientId: string; clientSecret: string; enabled?: boolean }> =
    {};

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
      social[id] = { clientId, clientSecret };
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
  database: getAuthSqlite(),
  emailAndPassword: {
    // Password auth off — OAuth + passkeys only (phishing-resistant by default).
    enabled: false,
  },
  socialProviders,
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 40,
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
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
  plugins: [
    passkey({
      rpID: rpID(),
      rpName: "docx-form",
      origin: baseURL(),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
