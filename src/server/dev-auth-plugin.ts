import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { getAuthPool } from "./auth-db";

/**
 * Local/dev only: pick an existing DB user and get a real session cookie
 * without going through Google OAuth.
 *
 * Enabled when DEV_AUTH=1, or automatically in non-production.
 * Disable with DEV_AUTH=0.
 */
export function isDevAuthEnabled(): boolean {
  const explicit = String(process.env.DEV_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "no") {
    return false;
  }
  if (explicit === "1" || explicit === "true" || explicit === "yes") {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

/**
 * Preferred local/dev account for Run Local auto sign-in.
 * Order: DEV_AUTH_DEFAULT_EMAIL → first SUPERADMIN_EMAILS → peerapat.srs@gmail.com
 */
export function getDefaultDevAuthEmail(): string {
  const fromEnv = String(process.env.DEV_AUTH_DEFAULT_EMAIL || "")
    .trim()
    .toLowerCase();
  if (fromEnv) return fromEnv;
  const superadmin = String(process.env.SUPERADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .find(Boolean);
  if (superadmin) return superadmin;
  return "peerapat.srs@gmail.com";
}

type DevUserRow = {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  plan: string | null;
  image: string | null;
  banned: boolean | null;
};

async function listDevUsers(): Promise<DevUserRow[]> {
  const pool = getAuthPool();
  const { rows } = await pool.query<DevUserRow>(
    `SELECT id, name, email, role, plan, image, banned
     FROM "user"
     ORDER BY
       CASE WHEN lower(email) = 'peerapat.srs@gmail.com' THEN 0 ELSE 1 END,
       "createdAt" DESC
     LIMIT 50`,
  );
  return rows;
}

export function devAuthPlugin() {
  return {
    id: "dev-auth",
    endpoints: {
      listDevUsers: createAuthEndpoint(
        "/dev/users",
        { method: "GET" },
        async () => {
          if (!isDevAuthEnabled()) {
            throw APIError.from("FORBIDDEN", {
              message: "Dev auth ปิดอยู่",
              code: "DEV_AUTH_DISABLED",
            });
          }
          const users = await listDevUsers();
          return {
            users: users.map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role || "user",
              plan: u.plan || "free",
              image: u.image,
              banned: Boolean(u.banned),
            })),
          };
        },
      ),
      loginAsDevUser: createAuthEndpoint(
        "/dev/login-as",
        {
          method: "POST",
          body: z.object({
            userId: z.string().min(1).optional(),
            email: z.string().email().optional(),
          }),
        },
        async (ctx) => {
          if (!isDevAuthEnabled()) {
            throw APIError.from("FORBIDDEN", {
              message: "Dev auth ปิดอยู่",
              code: "DEV_AUTH_DISABLED",
            });
          }
          const userId = String(ctx.body.userId || "").trim();
          const email = String(ctx.body.email || "")
            .trim()
            .toLowerCase();
          if (!userId && !email) {
            throw APIError.from("BAD_REQUEST", {
              message: "ต้องส่ง userId หรือ email",
              code: "MISSING_USER",
            });
          }

          const pool = getAuthPool();
          const { rows } = await pool.query<DevUserRow>(
            userId
              ? `SELECT id, name, email, role, plan, image, banned
                 FROM "user" WHERE id = $1 LIMIT 1`
              : `SELECT id, name, email, role, plan, image, banned
                 FROM "user" WHERE lower(email) = $1 LIMIT 1`,
            [userId || email],
          );
          const row = rows[0];
          if (!row) {
            throw APIError.from("NOT_FOUND", {
              message: "ไม่พบผู้ใช้",
              code: "USER_NOT_FOUND",
            });
          }
          if (row.banned) {
            throw APIError.from("FORBIDDEN", {
              message: "ผู้ใช้นี้ถูกแบน",
              code: "USER_BANNED",
            });
          }

          const full = await ctx.context.internalAdapter.findUserById(row.id);
          if (!full) {
            throw APIError.from("NOT_FOUND", {
              message: "ไม่พบผู้ใช้",
              code: "USER_NOT_FOUND",
            });
          }

          const session = await ctx.context.internalAdapter.createSession(
            full.id,
            false,
          );
          if (!session) {
            throw APIError.from("INTERNAL_SERVER_ERROR", {
              message: "สร้างเซสชันไม่สำเร็จ",
              code: "SESSION_FAILED",
            });
          }

          await setSessionCookie(ctx, {
            session,
            user: full,
          });

          return ctx.json({
            ok: true,
            user: {
              id: full.id,
              name: full.name,
              email: full.email,
              role: (full as { role?: string }).role || row.role || "user",
              plan: (full as { plan?: string }).plan || row.plan || "free",
              image: full.image,
            },
          });
        },
      ),
    },
  };
}
