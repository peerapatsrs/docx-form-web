import assert from "node:assert/strict";

console.log("ai-jobs-unit-test");

const { startAiJob, getAiJob, waitAiJobDone, cancelAiJob } = await import(
  "../src/server/ai-jobs.ts"
);

/** Simulates work longer than the removed 180s Cursor cap (scaled down for CI). */
const MOCK_LONG_MS = 250;

const job = startAiJob({
  kind: "test-long-cursor-path",
  ownerUserId: "test-user",
  run: async (emit, signal) => {
    emit({ step: 0, total: 2, message: "queued" });
    const started = Date.now();
    while (Date.now() - started < MOCK_LONG_MS) {
      if (signal.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 40));
      emit({
        step: 1,
        total: 2,
        message: `working ${Date.now() - started}ms`,
      });
    }
    return { ok: true, simulatedOver180sCap: true };
  },
});

assert.ok(job.id);
assert.ok(["queued", "running"].includes(job.status));

const done = await waitAiJobDone(job.id, 10_000);
assert.equal(done.status, "done");
assert.equal(done.result?.ok, true);
assert.equal(done.result?.simulatedOver180sCap, true);
assert.ok(!String(done.error || "").includes("CURSOR_AGENT_TIMEOUT"));
assert.ok(!String(done.error || "").includes("หมดเวลา"));

const pollOnly = getAiJob(job.id);
assert.equal(pollOnly?.status, "done");

const cancelJob = startAiJob({
  kind: "test-cancel",
  ownerUserId: "u1",
  run: async (_emit, signal) => {
    await new Promise((r) => setTimeout(r, 5000));
    if (signal.aborted) throw new Error("aborted");
    return { ok: true };
  },
});
await new Promise((r) => setTimeout(r, 30));
assert.ok(cancelAiJob(cancelJob.id, "u1"));
const cancelled = await waitAiJobDone(cancelJob.id, 5000);
assert.equal(cancelled.status, "cancelled");

console.log("ai-jobs-unit-test: ok");
