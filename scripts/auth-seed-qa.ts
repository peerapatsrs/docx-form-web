import { seedQaUser } from "../src/server/auth-seed-qa";

async function main() {
  const result = await seedQaUser();
  if (result.status === "skipped") {
    console.info(`[auth] QA seed skipped (${result.reason})`);
    return;
  }
  console.info(`[auth] QA seed ${result.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
