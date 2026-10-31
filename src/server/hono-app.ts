import { Hono } from "hono";
import { createApi } from "./api";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const startedAt = new Date();

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const app = new Hono().basePath("/api");
app.route("/", createApi({ startedAt, version: readVersion() }));

export default app;
