# DEV test accounts (Backend)

One-click DEV login for Frontend’s panel on `/login`. Passwords never reach the
browser. See also `docs/FE-DEV-TEST-LOGIN.md` (Frontend contract).

## Gates (all default OFF)

| Env | Purpose |
| --- | --- |
| `APP_ENV=dev` | Hard allow. Any other value (incl. sit/uat/prod/unset) refuses seed + expose. |
| `SHOW_TEST_ACCOUNTS=1` | Expose `GET/POST /api/dev/test-*`. |
| `SEED_TEST_USERS=1` | Idempotent seed of the two test users (independent of show). |

Never enable on SIT / UAT / PROD. Setting the flags without `APP_ENV=dev` logs a
warning and does nothing.

## Endpoints

### `GET /api/dev/test-accounts`

- **200** — JSON array (no emails/passwords):

```json
[
  { "key": "user", "label": "ผู้ใช้ทดสอบ", "role": "user" },
  { "key": "admin", "label": "แอดมินทดสอบ", "role": "superadmin" }
]
```

- **404** — feature off (`SHOW_TEST_ACCOUNTS` unset/off or `APP_ENV` ≠ `dev`).
- **429** — rate limited.

### `POST /api/dev/test-login`

Body: `{ "key": "user" }` (opaque key only — not email/password, not arbitrary user ids).

- **200** — Better Auth session via `Set-Cookie` (`better-auth.session_token`). Body includes `{ ok, user }`. Frontend redirects: safe `?next=` → else `/admin` for admin-like roles → else `/`.
- **404** — feature off, unknown key, or account not seeded yet.
- **429** — rate limited.
- **500** — session creation failed (`{ error }`).

Only the configured keys (`user`, `admin`) can log in. This is separate from the
old `DEV_AUTH` login-as plugin (`/api/auth/dev/login-as`).

Audit: successful login writes `dev.test_login` to `admin_audit`.

## Credentials (Backend-only)

```bash
APP_ENV=dev
SHOW_TEST_ACCOUNTS=0
SEED_TEST_USERS=0

# Emails (optional; defaults shown)
TEST_LOGIN_USER_EMAIL=test-user@docx-form.dev
TEST_LOGIN_ADMIN_EMAIL=test-admin@docx-form.dev

# Passwords (optional). If unset at seed time, a random value is generated and
# stored hashed — never logged, never returned to the client.
TEST_LOGIN_USER_PASSWORD=
TEST_LOGIN_ADMIN_PASSWORD=

# Aliases also accepted: SEED_TEST_USER_EMAIL / SEED_TEST_ADMIN_EMAIL /
# SEED_TEST_USER_PASSWORD / SEED_TEST_ADMIN_PASSWORD
```

Never use `NEXT_PUBLIC_*` for these. Never commit passwords.

## Seed

- Automatic during `migrateAuth()` when `SEED_TEST_USERS=1` and `APP_ENV=dev`.
- Manual: `npx tsx --env-file=.env.local scripts/auth-seed-test-users.ts`
  (or `npm run auth:seed-test-users` when that script is configured).

Idempotent: existing users are updated to the expected role/plan; credential
password hashes are refreshed when re-seeded.

### Admin rights (dev-only)

The seeded `admin` account gets **`role=superadmin`** (and `plan=pro`) written on
the `"user"` row through the normal Better Auth role path — same gate as
`/admin` (`requireSuperAdmin`). No `SUPERADMIN_EMAILS` edit is required for this
account. Re-seed is idempotent: an existing `role=admin` row is upgraded to
`superadmin` on every boot when `SEED_TEST_USERS=1` and `APP_ENV=dev`.

- Guard: **`APP_ENV=dev` only**. Outside dev the account is never seeded or
  elevated (flags alone are ignored with a warning).
- Emails/passwords come from seed config env (`TEST_LOGIN_*` / `SEED_TEST_*`);
  never hardcode them in application code.

#### Why `ensureSuperAdmins()` alone looked broken on DEV

`migrateAuth()` order is: `ensureSuperAdmins()` → … → `seedTestUsers()`.

Older DEV seeds wrote the test-admin row as `role=admin`. Even when that email
was listed in `SUPERADMIN_EMAILS`, `ensureSuperAdmins()` would promote it to
`superadmin`, then **`seedTestUsers()` ran afterward and reset `role` back to
`admin`**. Symptom after restart: DB still shows `admin`; admin pages (which
require `superadmin`) stay locked. This change fixes the seed target role to
`superadmin` so the last writer wins correctly. Suggested longer-term fix for
`ensureSuperAdmins` (manager decision; **not** changed here for non-dev): run
it **after** `seedTestUsers`, or make the DEV seed the sole authority for the
test-admin role and keep `SUPERADMIN_EMAILS` for real owner emails only.
