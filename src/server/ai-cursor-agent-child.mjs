#!/usr/bin/env node
/**
 * Killable child for Cursor Agent SDK calls.
 * Parent SIGKILLs this process on timeout so SDK gotoReady spin cannot pin the
 * server event loop. Speaks a tiny JSON IPC protocol on stdin/stdout lines.
 *
 * Parent → child (one line JSON):
 *   { "type":"run", "apiKey":"…", "model":"…", "message":"…", "images":[{mimeType,base64}]? }
 * Child → parent (one line JSON):
 *   { "type":"ok", "result":"…" } | { "type":"err", "message":"…", "name":"…" }
 */
import { Agent, AuthenticationError, ConfigurationError, CursorSdkError } from "@cursor/sdk";

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.off("error", onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onErr = (err) => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onErr);
      reject(err);
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onErr);
  });
}

async function disposeAgent(agent) {
  if (!agent) return;
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

async function runOnce(msg) {
  const apiKey = String(msg.apiKey || "").trim();
  const model = String(msg.model || "").trim();
  const message = String(msg.message || "").trim();
  const images = Array.isArray(msg.images) ? msg.images.slice(0, 12) : [];
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");
  if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");
  if (!message) throw new Error("ไม่มีข้อความให้ส่งไป Cursor Agent");

  // Unit-test hang: burn CPU until parent SIGKILLs (gotoReady spin stand-in).
  const mock = String(process.env.DOCX_FORM_CURSOR_AGENT_MOCK || "")
    .trim()
    .toLowerCase();
  if (mock === "hang" || mock === "never" || mock === "child-hang") {
    for (;;) {
      const end = Date.now() + 25;
      while (Date.now() < end) {
        /* burn */
      }
    }
  }

  const agentOpts = {
    apiKey,
    model: { id: model },
    cloud: { repos: [] },
  };

  const agent = await Agent.create(agentOpts);
  let run = null;
  try {
    if (images.length) {
      run = await agent.send({
        text: message,
        images: images.map((img) => ({
          data: img.base64,
          mimeType: img.mimeType,
        })),
      });
    } else {
      run = await agent.send({ text: message });
    }
    const waited = await run.wait();
    if (waited.status === "error" || waited.status === "cancelled") {
      const code = waited.error?.code ? ` (${waited.error.code})` : "";
      const errMsg = waited.error?.message || waited.status;
      throw new Error(`${errMsg}${code}`);
    }
    return String(waited.result || "");
  } finally {
    if (run) {
      try {
        if (run.status === "running") await run.cancel();
      } catch {
        /* ignore */
      }
      try {
        await Agent.cancelRun(run.id, {
          runtime: "cloud",
          agentId: run.agentId,
          apiKey,
        });
      } catch {
        /* ignore */
      }
    }
    await disposeAgent(agent);
  }
}

const line = await readStdinLine();
let payload;
try {
  payload = JSON.parse(line);
} catch (err) {
  send({ type: "err", message: `bad ipc json: ${err}`, name: "Error" });
  process.exit(1);
}

if (payload?.type !== "run") {
  send({ type: "err", message: "expected type=run", name: "Error" });
  process.exit(1);
}

try {
  const result = await runOnce(payload);
  send({ type: "ok", result });
  process.exit(0);
} catch (err) {
  const name =
    err instanceof AuthenticationError
      ? "AuthenticationError"
      : err instanceof ConfigurationError
        ? "ConfigurationError"
        : err instanceof CursorSdkError
          ? "CursorSdkError"
          : err instanceof Error
            ? err.name || "Error"
            : "Error";
  send({
    type: "err",
    message: err instanceof Error ? err.message : String(err || "error"),
    name,
  });
  process.exit(1);
}
