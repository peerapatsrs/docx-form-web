import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Content hash for `/public/…` cache-busting — no manual `?v=webNN` bumps.
 */
export function publicAssetVersion(relFromPublic: string): string {
  const full = path.join(process.cwd(), "public", relFromPublic);
  try {
    const buf = readFileSync(full);
    return createHash("sha1").update(buf).digest("hex").slice(0, 10);
  } catch {
    return "dev";
  }
}

export function publicAssetUrl(relFromPublic: string): string {
  const rel = relFromPublic.replace(/^\//, "");
  return `/${rel}?v=${publicAssetVersion(rel)}`;
}
