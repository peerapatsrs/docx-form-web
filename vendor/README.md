# Vendored shared modules

## `mw-shared/`

Pinned snapshot of https://github.com/peerapatsrs/mw-shared at the commit
recorded in `mw-shared/MW_SHARED_PIN.json`.

**READ-ONLY.** Do not edit files under `vendor/mw-shared/`. Updates come only
from a new pinned snapshot (replace the tree + pin, then re-run
`node scripts/mw-shared-verify.mjs`).

Consume auth via `@mw-shared/auth` → `file:vendor/mw-shared/auth` (see root
`package.json`). Build that package locally/CI **after** verify
(`npm ci && npm run build` inside `vendor/mw-shared/auth`); never fetch the
private mw-shared repo from the DEV VPS or Docker build.
