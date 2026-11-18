import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { getAuthPool } from "./auth-db";
import { getIpAddressHeaders } from "./client-ip";
import { ac, roles } from "@/lib/auth-permissions";
import { isSuperAdminEmail } from "./auth-superadmin";
import { getBetterAuthBaseUrl } from "@/lib/app-base-url";
import { resolveBetterAuthSecret } from "./auth-secret";

function env(name: string): string | undefined {
  const v = String(process.env[name] || "").trim();
  return v || undefined;
}

function baseURL(): string {
  return getBetterAuthBaseUrl();
}

/**
 * Session + admin roles only. Login is Keycloak OIDC (see oidc-*).
 * No social OAuth, password, passkey, or DEV login plugins.
 */
export const auth = betterAuth({
  appName: "docx-form",
  baseURL: baseURL(),
  secret: resolveBetterAuthSecret(),
  database: getAuthPool(),
  emailAndPassword: {
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
  socialProviders: {},
  account: {
    storeStateStrategy: "database",
    skipStateCookieCheck: true,
    updateUserInfoOnLink: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh daily
    cookieCache: {
      enabled: false,
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 40,
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    defaultCookieAttributes: {
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    },
    ipAddress: {
      ipAddressHeaders: getIpAddressHeaders(),
    },
    database: {
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
  ],
});

export type Session = typeof auth.$Infer.Session;
