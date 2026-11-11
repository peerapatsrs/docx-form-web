import type { Logger, LogLevel } from "./interfaces.js";

const JWT_RE =
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Redact JWT-like substrings from error messages. */
export function summarizeOidcError(err: unknown): string {
  if (err instanceof Error) {
    return (err.message || "OIDC_ERROR").replace(JWT_RE, "[jwt]");
  }
  return "OIDC_ERROR";
}

export function createConsoleLogger(prefix = "[mw-auth]"): Logger {
  return {
    log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
      const line = meta
        ? `${prefix} ${message} ${JSON.stringify(meta)}`
        : `${prefix} ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    },
  };
}

export const noopLogger: Logger = {
  log() {
    /* no-op */
  },
};
