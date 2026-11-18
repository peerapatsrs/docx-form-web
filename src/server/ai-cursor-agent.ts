/**
 * Cursor BYOK via @cursor/sdk Cloud Agent (no-repo).
 * Not OpenAI-compatible chat — put document text in the prompt and parse JSON from result.result.
 * Real SDK calls run in a killable child process so a hung gotoReady loop cannot
 * pin the server event loop after our AbortSignal / Promise.race deadline.
 * @see https://cursor.com/docs/sdk/typescript
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
} from "@cursor/sdk";
import {
  CURSOR_STALE_MODEL_IDS,
  getAiProvider,
  resolveCursorModelId,
} from "./ai-providers";
import {
  AiTimeoutError,
  getAiTimeoutMs,
  isAiTimeoutError,
  withAiTimeout,
} from "./ai-request";

const requireFromHere = createRequire(import.meta.url);
const CHILD_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "ai-cursor-agent-child.mjs",
);

export type CursorAgentImage = {
  mimeType: string;
  base64: string;
};

export type CallCursorAgentJsonOpts = {
  apiKey: string;
  model: string;
  images?: CursorAgentImage[];
  /** Optional cancel — merged with DOCX_FORM_AI_TIMEOUT_MS processing-time cap. */
  signal?: AbortSignal;
  /** Override DOCX_FORM_AI_TIMEOUT_MS (tests / special routes). */
  timeoutMs?: number;
  /** Structured log context (never secrets / doc body). */
  route?: string;
  requestId?: string;
};

/** Live model ids for the API key (empty on failure / timeout). */
export async function listCursorModelIds(
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = String(apiKey || "").trim();
  if (!key) return [];
  try {
    // Catalog list should not burn the full AI timeout — cap at 15s.
    const listTimeout = Math.min(15_000, getAiTimeoutMs());
    return await withAiTimeout(
      async (gated) => {
        const models = await Cursor.models.list({ apiKey: key });
        if (gated.aborted) return [];
        return (models || [])
          .map((m) => String(m?.id || "").trim())
          .filter(Boolean);
      },
      {
        signal,
        timeoutMs: listTimeout,
        route: "cursor.models.list",
        provider: "cursor",
      },
    );
  } catch {
    return [];
  }
}

function cursorStaticCatalogIds(): string[] {
  const provider = getAiProvider("cursor");
  const ids = (provider?.models || []).map((m) => m.id).filter(Boolean);
  return ids.length ? ids : ["composer-2.5"];
}

/** True when id clearly belongs to another provider family (never send to Cursor Agent). */
export function isCrossFamilyCursorModelId(raw: string | null | undefined): boolean {
  const id = String(raw || "").trim();
  if (!id) return false;
  return /^(gemini|gpt-|o[1-9]|chatgpt|claude|deepseek|grok|mistral|llama|qwen)/i.test(
    id,
  );
}

/**
 * Resolve vault/header model for Agent.create.
 * Stale/gated/cross-family ids remap via static catalog immediately — never wait
 * on a hung models.list, and never pass gemini-* through to Agent.prompt.
 */
export async function resolveCursorModelForCall(
  apiKey: string,
  requested: string | null | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const raw = String(requested || "").trim();
  const catalog = cursorStaticCatalogIds();

  if (!raw || CURSOR_STALE_MODEL_IDS.has(raw) || isCrossFamilyCursorModelId(raw)) {
    return resolveCursorModelId(raw, catalog);
  }

  const available = await listCursorModelIds(apiKey, signal);
  if (available.length) {
    return resolveCursorModelId(raw, available);
  }
  // Live list empty/failed — still bind to static catalog so unknown leftovers
  // (or flaky catalog) cannot hang Agent.prompt on an invalid model id.
  return resolveCursorModelId(raw, catalog);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      if (Array.isArray(parsed)) return { _legacy: parsed };
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(body.slice(start, end + 1));
  return null;
}

async function waitWithOptionalAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    if (isAiTimeoutError(signal.reason)) throw new AiTimeoutError();
    throw new Error("CURSOR_AGENT_CANCELLED");
  }
  // Detach from the provider promise after abort so we never wait past the
  // AbortSignal (Cursor SDK may ignore cancel and keep running for minutes).
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (isAiTimeoutError(signal.reason)) reject(new AiTimeoutError());
      else reject(new Error("CURSOR_AGENT_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function haystackFromUnknown(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const extra =
      "code" in err && (err as { code?: unknown }).code != null
        ? ` ${String((err as { code?: unknown }).code)}`
        : "";
    return `${err.name} ${err.message}${extra}`;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Map SDK / cloud failures to short Thai errors for UI banners. */
export function formatCursorAgentError(err: unknown): Error {
  if (isAiTimeoutError(err)) {
    return err instanceof AiTimeoutError
      ? err
      : new AiTimeoutError(
          err instanceof Error ? err.message : String(err || "AI_TIMEOUT"),
        );
  }
  if (err instanceof Error && err.message.startsWith("Cursor:")) {
    return err;
  }
  const hay = haystackFromUnknown(err);

  if (
    err instanceof Error &&
    (err.message === "CURSOR_AGENT_CANCELLED" ||
      /CURSOR_AGENT_CANCELLED/i.test(hay))
  ) {
    return new Error("Cursor: ยกเลิกแล้ว");
  }

  if (
    err instanceof AuthenticationError ||
    /authentication|unauthorized|invalid.?api.?key|api key/i.test(hay)
  ) {
    return new Error(
      "Cursor: API key ไม่ถูกต้องหรือหมดอายุ — ตรวจคีย์ crsr_… ที่ Dashboard → API Keys",
    );
  }

  if (
    /no-?repo|empty.?repos|repos:\s*\[\]|not enabled|feature not enabled|repository-scoped|unrestricted/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: บัญชียังไม่เปิด no-repo Cloud Agents — ใช้คีย์ผู้ใช้ (ไม่ใช่ repo-scoped) หรือเปิดสิทธิ์ในทีม",
    );
  }

  if (
    /quota|rate.?limit|usage.?limit|spend|billing|insufficient|out of credits|request.?limit|too many requests/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: โควต้าหรือเครดิตไม่พอ — ตรวจ usage ใน Dashboard แล้วลองใหม่ภายหลัง",
    );
  }

  if (
    /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid|unknown model/i.test(
      hay,
    )
  ) {
    return new Error(
      "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
    );
  }

  if (err instanceof ConfigurationError) {
    if (
      /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid/i.test(
        err.message,
      )
    ) {
      return new Error(
        "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
      );
    }
    const detail = err.message.replace(/\s+/g, " ").trim().slice(0, 120);
    return new Error(
      detail
        ? `Cursor: การตั้งค่า SDK ไม่ถูกต้อง — ${detail}`
        : "Cursor: การตั้งค่า SDK ไม่ถูกต้อง",
    );
  }

  if (err instanceof CursorSdkError) {
    if (
      /not available or invalid|Call Cursor\.models\.list|invalid.?model|model.*invalid/i.test(
        err.message,
      )
    ) {
      return new Error(
        "Cursor: โมเดลที่เลือกใช้ไม่ได้กับคีย์นี้ — เปิด「เลือก model」แล้วเลือกใหม่จากรายการ (เช่น Composer 2.5)",
      );
    }
    const detail = err.message.replace(/\s+/g, " ").trim().slice(0, 120);
    return new Error(
      detail ? `Cursor: ${detail}` : "Cursor: Cloud Agent ล้มเหลว",
    );
  }

  const detail = hay.replace(/\s+/g, " ").trim().slice(0, 120);
  return new Error(
    detail
      ? `Cursor: Cloud Agent ล้มเหลว — ${detail}`
      : "Cursor: Cloud Agent ล้มเหลว",
  );
}

/**
 * Local mock modes for CI / VM without a real Cursor key.
 * DOCX_FORM_CURSOR_AGENT_MOCK=ok|hang|401
 */
async function maybeMockCursorAgentJson(
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null | undefined> {
  const mode = String(process.env.DOCX_FORM_CURSOR_AGENT_MOCK || "")
    .trim()
    .toLowerCase();
  if (!mode) return undefined;
  // Hang / never: defer to the killable child (child burns CPU; parent SIGKILLs
  // on AbortSignal). Never hang in-process — that pins the server event loop.
  if (mode === "hang" || mode === "never" || mode === "child-hang") {
    return undefined;
  }
  if (mode === "401" || mode === "auth") {
    throw new AuthenticationError("Invalid API key (mock)", {
      status: 401,
      code: "AUTH_INVALID_API_KEY",
    });
  }
  if (mode === "ok" || mode === "success") {
    return {
      suggestions: [
        {
          name: "ชื่อ",
          kind: "text",
          preview: "ชื่อ",
          reason: "mock",
        },
      ],
      values: { ชื่อ: "ตัวอย่าง" },
      mock: true,
    };
  }
  return undefined;
}

/**
 * Run Cursor Agent.create/send/wait inside a child process. On abort/timeout the
 * parent SIGKILLs the child so SDK reconnect spin cannot pin this event loop.
 */
function runCursorAgentInKillableChild(
  message: string,
  opts: {
    apiKey: string;
    model: string;
    images: CursorAgentImage[];
    signal: AbortSignal;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      if (isAiTimeoutError(opts.signal.reason)) reject(new AiTimeoutError());
      else reject(new Error("CURSOR_AGENT_CANCELLED"));
      return;
    }
    const child = spawn(process.execPath, [CHILD_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    let settled = false;
    let stdout = "";
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const killChild = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => {
      killChild();
      settle(() => {
        if (isAiTimeoutError(opts.signal.reason)) reject(new AiTimeoutError());
        else reject(new Error("CURSOR_AGENT_CANCELLED"));
      });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes("\n")) return;
      const line = stdout.slice(0, stdout.indexOf("\n"));
      let parsed: { type?: string; result?: string; message?: string; name?: string };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.type === "ok") {
        settle(() => resolve(String(parsed.result || "")));
        killChild();
        return;
      }
      if (parsed.type === "err") {
        const err = new Error(String(parsed.message || "Cursor child error"));
        if (parsed.name) err.name = parsed.name;
        settle(() => reject(err));
        killChild();
      }
    });
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settle(() => {
        if (opts.signal.aborted) {
          if (isAiTimeoutError(opts.signal.reason)) reject(new AiTimeoutError());
          else reject(new Error("CURSOR_AGENT_CANCELLED"));
          return;
        }
        reject(
          new Error(
            `Cursor child exited before result (code=${code}, signal=${signal})`,
          ),
        );
      });
    });

    const payload = JSON.stringify({
      type: "run",
      apiKey: opts.apiKey,
      model: opts.model,
      message,
      images: opts.images.map((img) => ({
        mimeType: img.mimeType,
        base64: img.base64,
      })),
    });
    child.stdin?.write(`${payload}\n`);
    child.stdin?.end();
  });
}

/**
 * One-shot cloud no-repo agent → parse assistant text as JSON object.
 * Real calls run in a killable child; mocks stay in-process for unit tests.
 * Always bounded by DOCX_FORM_AI_TIMEOUT_MS / caller timeoutMs (suggest: 120s).
 */
export async function callCursorAgentJson(
  prompt: string,
  opts: CallCursorAgentJsonOpts,
): Promise<Record<string, unknown> | null> {
  const apiKey = String(opts.apiKey || "").trim();
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");

  const message = String(prompt || "").trim();
  if (!message) throw new Error("ไม่มีข้อความให้ส่งไป Cursor Agent");

  const images = (opts.images || [])
    .filter((img) => img?.base64 && img?.mimeType)
    .slice(0, 12);

  try {
    return await withAiTimeout(
      async (signal) => {
        const mockMode = String(process.env.DOCX_FORM_CURSOR_AGENT_MOCK || "")
          .trim()
          .toLowerCase();
        // Hang mocks must run in the killable child so SIGKILL can reclaim CPU.
        // Skipping model catalog avoids in-process work before the child starts.
        if (
          mockMode === "hang" ||
          mockMode === "never" ||
          mockMode === "child-hang"
        ) {
          await runCursorAgentInKillableChild(message, {
            apiKey,
            model: String(opts.model || "composer-2.5").trim() || "composer-2.5",
            images,
            signal,
          });
          return null;
        }

        const mocked = await maybeMockCursorAgentJson(signal);
        if (mocked !== undefined) return mocked;

        const model = await resolveCursorModelForCall(
          apiKey,
          opts.model,
          signal,
        );
        if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");

        // Force child isolation unless explicitly disabled (debug only).
        const forceInProcess =
          String(process.env.DOCX_FORM_CURSOR_AGENT_INPROCESS || "")
            .trim()
            .toLowerCase() === "1";
        let resultText = "";
        if (forceInProcess) {
          const agentOpts = {
            apiKey,
            model: { id: model },
            cloud: { repos: [] as [] },
          };
          const agent = await Agent.create(agentOpts);
          let run: Awaited<ReturnType<typeof agent.send>> | null = null;
          const onAbort = () => {
            void (async () => {
              try {
                if (run && run.status === "running") await run.cancel();
              } catch {
                /* ignore */
              }
              try {
                if (run) {
                  await Agent.cancelRun(run.id, {
                    runtime: "cloud",
                    agentId: run.agentId,
                    apiKey,
                  });
                }
              } catch {
                /* ignore */
              }
              try {
                await agent[Symbol.asyncDispose]();
              } catch {
                try {
                  agent.close();
                } catch {
                  /* ignore */
                }
              }
            })();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            run = await agent.send(
              images.length
                ? {
                    text: message,
                    images: images.map((img) => ({
                      data: img.base64,
                      mimeType: img.mimeType,
                    })),
                  }
                : { text: message },
            );
            const waited = await waitWithOptionalAbort(run.wait(), signal);
            if (waited.status === "error" || waited.status === "cancelled") {
              const code = waited.error?.code ? ` (${waited.error.code})` : "";
              const msg = waited.error?.message || waited.status;
              throw new Error(`${msg}${code}`);
            }
            resultText = String(waited.result || "");
          } finally {
            signal.removeEventListener("abort", onAbort);
            try {
              await agent[Symbol.asyncDispose]();
            } catch {
              try {
                agent.close();
              } catch {
                /* ignore */
              }
            }
          }
        } else {
          // Ensure the child script can resolve @cursor/sdk from this package.
          void requireFromHere.resolve("@cursor/sdk");
          resultText = await runCursorAgentInKillableChild(message, {
            apiKey,
            model,
            images,
            signal,
          });
        }

        return parseJsonObject(resultText);
      },
      {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        route: opts.route || "cursor.agent",
        provider: "cursor",
        model: opts.model,
        requestId: opts.requestId,
      },
    );
  } catch (err) {
    throw formatCursorAgentError(err);
  }
}
