#!/usr/bin/env node
import assert from "node:assert/strict";

const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

async function loadAiConfig() {
  const id = `../src/server/ai-config.ts?t=${Date.now()}-${Math.random()}`;
  return import(id);
}

async function loadAiJobs() {
  const id = `../src/server/ai-jobs.ts?t=${Date.now()}-${Math.random()}`;
  return import(id);
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}`);
      console.error(err);
    }
  })();
}

console.log("ai-status-unit-test");

await check("BYOK status without key → needs_key", async () => {
  process.env.DOCX_FORM_BYOK_ONLY = "1";
  delete process.env.GEMINI_API_KEY;
  delete process.env.DOCX_FORM_CURSOR_API_KEY;
  const { geminiStatus } = await loadAiConfig();
  const status = geminiStatus({
    requestProvider: "google",
    adminDefaultProvider: "cursor",
    jobState: "idle",
  });
  assert.equal(status.connected, false);
  assert.equal(status.readinessState, "needs_key");
  assert.equal(status.keySource, "none");
  assert.equal(status.effectiveProvider, "cursor");
});

await check("running job → generating readiness", async () => {
  process.env.DOCX_FORM_BYOK_ONLY = "1";
  const { geminiStatus } = await loadAiConfig();
  const status = geminiStatus({
    requestKey: "01234567890123456789012345678901",
    requestProvider: "google",
    jobState: "running",
  });
  assert.equal(status.connected, true);
  assert.equal(status.readinessState, "generating");
  assert.equal(status.jobState, "running");
  assert.equal(status.keySource, "user");
});

await check("summarizeAiJobsForUser picks latest active job", async () => {
  const { startAiJob, summarizeAiJobsForUser } = await loadAiJobs();
  const userId = "user-test-1";
  startAiJob({
    kind: "test",
    ownerUserId: userId,
    run: async (emit) => {
      emit({ message: "working" });
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    },
  });
  const summary = summarizeAiJobsForUser(userId);
  assert.ok(summary.jobState === "queued" || summary.jobState === "running");
  assert.equal(summary.activeJobKind, "test");
});

restoreEnv();

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll ai-status unit tests passed.");
