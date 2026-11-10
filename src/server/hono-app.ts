import { Hono } from "hono";
import { createApi } from "./api";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAppVersionLabel } from "@/lib/app-build-info";

const startedAt = new Date();

function readPackageMeta(): {
  packageVersion: string;
  version: string;
  authorName: string;
  authorEmail: string;
} {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as {
      version?: string;
      author?: string | { name?: string; email?: string };
    };
    const author = pkg.author;
    const authorName =
      typeof author === "string"
        ? author
        : String(author?.name || "").trim();
    const authorEmail =
      typeof author === "object" && author
        ? String(author.email || "").trim()
        : "";
    const packageVersion = pkg.version ?? "0.1.0";
    return {
      packageVersion,
      // Prefer short build commit (RENDER_GIT_COMMIT / SOURCE_COMMIT / GIT_SHA / …).
      version: formatAppVersionLabel(packageVersion),
      authorName,
      authorEmail,
    };
  } catch {
    return {
      packageVersion: "0.1.0",
      version: formatAppVersionLabel("0.1.0"),
      authorName: "",
      authorEmail: "",
    };
  }
}

const pkgMeta = readPackageMeta();

const app = new Hono().basePath("/api");
app.route(
  "/",
  createApi({
    startedAt,
    version: pkgMeta.version,
    authorName: pkgMeta.authorName,
    authorEmail: pkgMeta.authorEmail,
  }),
);

export default app;
