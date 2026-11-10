import { seedTestUsers } from "../src/server/dev-test-accounts";

async function main() {
  const result = await seedTestUsers();
  if (result.status === "skipped") {
    console.info(`[auth] DEV test-user seed skipped (${result.reason})`);
    return;
  }
  console.info(
    `[auth] DEV test-user seed ${result.status} created=[${result.created.join(", ")}] updated=[${result.updated.join(", ")}]`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
