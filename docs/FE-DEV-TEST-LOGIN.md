# FE ↔ BE DEV test-login contract

Frontend discovers one-click DEV accounts from Backend. **Passwords never reach
the browser.** The login page shows the panel only when the list endpoint
returns **200** with at least one account; **404** or any error hides it.

Gate on Backend (not a Next public env):

- `SHOW_TEST_ACCOUNTS=1`
- `APP_ENV=dev`

Both must be true or the endpoints return **404**. Off by default; never enable
on SIT / UAT / PROD.

## Endpoints

### `GET /api/dev/test-accounts`

**200** — JSON array (or `{ "accounts": [...] }`):

```json
[
  { "key": "user", "label": "ผู้ใช้ทดสอบ", "role": "user" },
  { "key": "admin", "label": "แอดมินทดสอบ", "role": "admin" }
]
```

- `key` — opaque id for `POST /api/dev/test-login` (not an email/password).
- `label` — Thai (or other) button text shown on `/login`.
- `role` — used only for post-login redirect (`admin` / `superadmin` / `staff` → `/admin` when `?next=` is absent).

**404** — feature off or not `APP_ENV=dev`. FE treats as “no panel”.

### `POST /api/dev/test-login`

Body:

```json
{ "key": "user" }
```

**200** — creates a normal Better Auth session (Set-Cookie). FE then redirects:

1. Safe `?next=` path when present and not `/`
2. Else `/admin` for admin-like roles
3. Else `/`

**404** — feature off. FE hides the panel and shows a short Thai error.

**4xx/5xx** — FE shows `error` from JSON when present, otherwise a generic Thai message.

## FE behaviour

- Panel title: **บัญชีทดสอบ (เฉพาะ DEV)**
- Renders one button per account returned by GET (only keys Backend configured).
- No credential env vars are read or exposed by Frontend.
- Helpers: `src/lib/dev-test-login.ts` · UI: `src/app/login/page.tsx`

## Related Backend env (placeholders — Backend owns these)

```bash
SHOW_TEST_ACCOUNTS=0
APP_ENV=dev
# Backend-only secrets / seed identities — never NEXT_PUBLIC_*, never sent to the client
# TEST_LOGIN_USER_EMAIL=
# TEST_LOGIN_USER_PASSWORD=
# TEST_LOGIN_ADMIN_EMAIL=
# TEST_LOGIN_ADMIN_PASSWORD=
```
