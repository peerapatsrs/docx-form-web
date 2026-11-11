import { randomUUID } from "node:crypto";

export type AiJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type AiJobProgress = {
  step?: number;
  total?: number;
  message?: string;
};

export type AiJobRecord = {
  id: string;
  kind: string;
  status: AiJobStatus;
  progress: AiJobProgress;
  result?: unknown;
  error?: string;
  /** Stable error code when status=error (e.g. AI_SERVER_KEY_INVALID). */
  code?: string;
  ownerUserId: string | null;
  createdAt: number;
  updatedAt: number;
};

type InternalJob = AiJobRecord & {
  abortController: AbortController;
  runPromise: Promise<void>;
};

const jobs = new Map<string, InternalJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

export function publicAiJob(job: AiJobRecord): AiJobRecord {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "error" || job.status === "cancelled" ? job.error : undefined,
    code:
      job.status === "error" || job.status === "cancelled"
        ? job.code
        : undefined,
    ownerUserId: job.ownerUserId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getAiJob(jobId: string): AiJobRecord | null {
  pruneOldJobs();
  const job = jobs.get(String(jobId || "").trim());
  return job ? publicAiJob(job) : null;
}

export type AiJobActivitySummary = {
  jobState: "idle" | "queued" | "running" | "error";
  activeJobId: string | null;
  activeJobKind: string | null;
  activeJobMessage: string | null;
};

/** Latest in-flight or failed job for the session user (for status pill / polling). */
export function summarizeAiJobsForUser(
  ownerUserId: string | null | undefined,
): AiJobActivitySummary {
  pruneOldJobs();
  const uid = String(ownerUserId || "").trim();
  let best: InternalJob | null = null;
  for (const job of jobs.values()) {
    if (uid && job.ownerUserId && job.ownerUserId !== uid) continue;
    if (!uid && job.ownerUserId) continue;
    if (job.status !== "queued" && job.status !== "running" && job.status !== "error") {
      continue;
    }
    if (!best || job.updatedAt > best.updatedAt) best = job;
  }
  if (!best) {
    return {
      jobState: "idle",
      activeJobId: null,
      activeJobKind: null,
      activeJobMessage: null,
    };
  }
  const jobState = best.status as AiJobActivitySummary["jobState"];
  return {
    jobState,
    activeJobId: best.id,
    activeJobKind: best.kind,
    activeJobMessage: best.progress?.message || best.error || null,
  };
}

export function cancelAiJob(jobId: string, ownerUserId?: string | null): boolean {
  const job = jobs.get(String(jobId || "").trim());
  if (!job) return false;
  if (ownerUserId && job.ownerUserId && job.ownerUserId !== ownerUserId) {
    return false;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    return true;
  }
  job.abortController.abort();
  job.status = "cancelled";
  job.error = "ยกเลิกแล้ว";
  job.updatedAt = Date.now();
  return true;
}

export type RunAiJobOpts = {
  kind: string;
  ownerUserId?: string | null;
  run: (
    emit: (progress: AiJobProgress) => void,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export function startAiJob(opts: RunAiJobOpts): AiJobRecord {
  pruneOldJobs();
  const id = randomUUID();
  const abortController = new AbortController();
  const now = Date.now();
  const job: InternalJob = {
    id,
    kind: opts.kind,
    status: "queued",
    progress: { message: "รอคิว…" },
    ownerUserId: opts.ownerUserId ?? null,
    createdAt: now,
    updatedAt: now,
    abortController,
    runPromise: Promise.resolve(),
  };
  jobs.set(id, job);

  job.runPromise = (async () => {
    try {
      job.status = "running";
      job.progress = { message: "กำลังทำงาน…" };
      job.updatedAt = Date.now();
      const result = await opts.run(
        (progress) => {
          job.progress = { ...job.progress, ...progress };
          job.updatedAt = Date.now();
        },
        abortController.signal,
      );
      if (abortController.signal.aborted) {
        job.status = "cancelled";
        job.error = job.error || "ยกเลิกแล้ว";
      } else {
        job.status = "done";
        job.result = result;
        job.progress = { ...job.progress, message: "เสร็จแล้ว" };
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        job.status = "cancelled";
        job.error = job.error || "ยกเลิกแล้ว";
        job.code = job.code || "AI_JOB_CANCELLED";
      } else {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        const code =
          err &&
          typeof err === "object" &&
          "code" in err &&
          typeof (err as { code?: unknown }).code === "string"
            ? String((err as { code: string }).code).trim()
            : "";
        job.code = code || "AI_PROVIDER_ERROR";
      }
    } finally {
      job.updatedAt = Date.now();
    }
  })();

  void job.runPromise;
  return publicAiJob(job);
}

/** Test hook: await job completion (not for production HTTP). */
export async function waitAiJobDone(jobId: string, timeoutMs = 120_000): Promise<AiJobRecord> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = jobs.get(jobId);
    if (!job) throw new Error("job not found");
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      return publicAiJob(job);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job wait timeout");
}
