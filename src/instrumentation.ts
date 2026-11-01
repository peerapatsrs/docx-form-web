export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { migrateAuth } = await import("./server/auth-migrate");
    await migrateAuth();
  } catch (err) {
    // Don't crash the process on boot if DB is briefly unreachable —
    // first auth request will surface the error clearly.
    console.error("[auth] migrate/bootstrap failed:", err);
  }
}
