import { getMigrations } from "better-auth/db/migration";
import { ensureAdminSchema } from "./admin-store";
import { auth } from "./auth";
import { seedQaUser } from "./auth-seed-qa";
import { ensureSuperAdmins } from "./auth-superadmin";
import { seedTestUsers } from "./dev-test-accounts";

let ran = false;

/** Apply Better Auth schema (idempotent), bootstrap superadmins, seed QA login-as user. */
export async function migrateAuth(): Promise<void> {
  if (ran) return;
  await ensureAdminSchema();
  const { toBeCreated, toBeAdded, toBeAddedIndexes, runMigrations } =
    await getMigrations(auth.options);
  const pending =
    toBeCreated.length + toBeAdded.length + toBeAddedIndexes.length;
  if (pending > 0) {
    await runMigrations();
    console.info(
      `[auth] migrated schema (+${toBeCreated.length} tables, +${toBeAdded.length} columns, +${toBeAddedIndexes.length} indexes)`,
    );
  }
  const updated = await ensureSuperAdmins();
  if (updated > 0) {
    console.info(`[auth] promoted ${updated} user(s) to superadmin`);
  }
  const seeded = await seedQaUser();
  if (seeded.status === "created") {
    console.info("[auth] seeded QA login-as user");
  }
  // DEV test users: only when SEED_TEST_USERS=1 and APP_ENV=dev (see docs/DEV-TEST-ACCOUNTS.md).
  const testUsers = await seedTestUsers();
  if (testUsers.status === "seeded") {
    console.info(
      `[auth] seeded DEV test users (created=${testUsers.created.join(",") || "-"} updated=${testUsers.updated.join(",") || "-"})`,
    );
  }
  ran = true;
}
