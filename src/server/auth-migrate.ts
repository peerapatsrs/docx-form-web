import { getMigrations } from "better-auth/db/migration";
import { ensureAdminSchema } from "./admin-store";
import { auth } from "./auth";
import { ensureSuperAdmins } from "./auth-superadmin";
import { ensureOidcIdentitiesSchema } from "./oidc-identities";
import { isOidcEnabled, logOidcNotConfigured } from "./oidc-config";

let ran = false;

/** Apply Better Auth schema (idempotent), OIDC identities, bootstrap superadmins. */
export async function migrateAuth(): Promise<void> {
  if (ran) return;
  await ensureAdminSchema();
  await ensureOidcIdentitiesSchema();
  if (isOidcEnabled()) {
    console.info("[auth] OIDC SSO enabled (identities table ready)");
  } else {
    logOidcNotConfigured("migrate");
  }
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
  ran = true;
}
