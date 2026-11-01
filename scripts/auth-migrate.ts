import { migrateAuth } from "../src/server/auth-migrate";

async function main() {
  await migrateAuth();
  console.info("[auth] migrate + superadmin bootstrap done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
