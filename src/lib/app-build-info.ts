/**
 * Build / deploy identity for the version label in the UI.
 * Prefer a short git commit from the host env; fall back to package.json version.
 */

const DEFAULT_COMMIT_ENV_NAMES = [
  "RENDER_GIT_COMMIT",
  "SOURCE_COMMIT",
  "GIT_SHA",
  "COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

function firstEnv(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of names) {
    const v = String(env[name] || "").trim();
    if (v) return v;
  }
  return undefined;
}

/** Shorten a full SHA / dirty describe to 7 hex chars when possible. */
export function shortCommitSha(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Allow "abc1234" or longer hex; strip optional prefixes.
  const hex = s.replace(/^[^0-9a-f]*/i, "").match(/^[0-9a-f]{7,40}/i);
  if (hex) return hex[0].slice(0, 7).toLowerCase();
  // Non-hex (e.g. "v1.2.3-3-gabcdef") — take trailing hex if present.
  const g = s.match(/g([0-9a-f]{7,40})$/i);
  if (g) return g[1].slice(0, 7).toLowerCase();
  return s.slice(0, 12);
}

/**
 * Resolve build commit from env.
 * Optional `APP_BUILD_COMMIT_ENV` names which env var to prefer (configurable).
 */
export function readBuildCommitSha(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const preferred = String(env.APP_BUILD_COMMIT_ENV || "").trim();
  const names = preferred
    ? [preferred, ...DEFAULT_COMMIT_ENV_NAMES]
    : [...DEFAULT_COMMIT_ENV_NAMES];
  // Also accept a direct override value.
  const direct = String(env.APP_BUILD_SHA || "").trim();
  if (direct) return shortCommitSha(direct);
  const raw = firstEnv(names, env);
  return raw ? shortCommitSha(raw) : null;
}

export function formatPackageVersionLabel(pkgVersion: string): string {
  const raw = String(pkgVersion || "0.0.0").replace(/^v/i, "").trim();
  return raw ? `v${raw}` : "v…";
}

/**
 * UI version label: short commit SHA when available, else `v{package.json}`.
 */
export function formatAppVersionLabel(
  pkgVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sha = readBuildCommitSha(env);
  if (sha) return sha;
  return formatPackageVersionLabel(pkgVersion);
}
