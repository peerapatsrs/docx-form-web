#!/usr/bin/env node
/**
 * Seed a local Better Auth user + session cookie for real-backend AI key E2E.
 * No OIDC required. Writes cookie to /tmp/ai-key-e2e-cookie.txt
 */
import { writeFileSync } from "node:fs";
import { createAppUserFromOidc } from "../src/server/oidc-identities.ts";
import { createAppSessionCookie } from "../src/server/oidc-flow.ts";
import { migrateAuth } from "../src/server/auth-migrate.ts";

const EMAIL = process.env.E2E_USER_EMAIL || "ai-key-e2e@example.com";
const NAME = process.env.E2E_USER_NAME || "AI Key E2E";

await migrateAuth();

const created = await createAppUserFromOidc({
  sub: "e2e-ai-key-sub",
  email: EMAIL,
  name: NAME,
  email_verified: true,
  iss: "https://e2e.local/realms/test",
  aud: "e2e",
});

const session = await createAppSessionCookie(created.userId);
const cookie = String(session.setCookie || "").split(";")[0];
if (!cookie || !cookie.includes("=")) {
  console.error("failed to mint session cookie", session);
  process.exit(1);
}

writeFileSync("/tmp/ai-key-e2e-cookie.txt", cookie, "utf8");
writeFileSync(
  "/tmp/ai-key-e2e-user.json",
  JSON.stringify(
    { id: created.userId, email: EMAIL, name: NAME, cookie, created: created.created },
    null,
    2,
  ),
);
console.log(`seeded user ${created.userId} (${EMAIL}) created=${created.created}`);
console.log(`cookie ${cookie.slice(0, 48)}…`);
