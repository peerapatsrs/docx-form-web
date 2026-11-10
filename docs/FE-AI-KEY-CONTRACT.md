# FE ↔ BE AI Key API contract

Assumed by Frontend branch `fe/ux-confusing-2026-11-10`. Aligns with Backend
`fix/ai-key-id-credentials` / integration `dev-integration-2026-11-10`.
Session cookie auth; **401** when logged out for vault routes.

Frontend never displays or logs the full secret after save. AI feature calls
send **`X-Ai-Key-Id` only** (no raw key header) when the key is stored on the
server. Guest / local-only keys stay on-device until the user logs in and syncs.

## Endpoints

### `GET /api/ai/keys`

List the current user's keys (masked only).

**200**

```json
{
  "entries": [
    {
      "id": "k-…",
      "provider": "google",
      "label": "Google Gemini",
      "model": "gemini-3.8-flash",
      "maskedKey": "••••…abcd",
      "hasKey": true,
      "storeOnServer": true
    }
  ]
}
```

- Never includes plaintext `apiKey`.
- **401** `{ "error": "…", "code": "AI_KEY_UNAUTHORIZED" }` when there is no session.

### `PUT /api/ai/keys`

Upsert one or many entries. Body is either:

```json
{ "entry": { "id": "k-…?", "provider": "google", "label": "…", "model": "…", "apiKey": "…" } }
```

or

```json
{ "entries": [ { "id": "…", "provider": "…", "label": "…", "model": "…", "apiKey": "…" } ] }
```

**200**

```json
{ "ok": true, "entries": [ /* same masked shape as GET */ ] }
```

- Missing `entry` / `entries` → **400** `{ "error": "<Thai>", "code": "AI_KEY_MISSING_FIELDS" }`
- Empty / too-short key → **400** `{ "error": "<Thai>", "code": "AI_KEY_INVALID_VALUE" }` (or `AI_KEY_MISSING`)
- Fake / unauthorized key (live probe) → **400** `{ "error": "<Thai>", "code": "AI_KEY_INVALID" }` — **not stored**
- Provider timeout / quota / rate-limit → matching `AI_PROVIDER_*` codes (see `docs/API-AI-KEYS-AND-SKIP.md`)
- **401** `{ "error": "…", "code": "AI_KEY_UNAUTHORIZED" }` when logged out

After a successful PUT the FE clears any in-memory / local plaintext copy for
that id and keeps only the masked metadata (+ `storeOnServer: true`).

### `POST /api/ai/keys/:id/test`

Live probe of a saved vault key. FE shows the button when `AI_KEY_TEST_ENABLED`
is true (`public/ai-key-client.js`).

**200** `{ "ok": true, "code": "AI_KEY_TEST_OK", "message": "…", "entry": {…} }`  
**400/504** `{ "ok": false, "code": "AI_KEY_INVALID" | "AI_PROVIDER_*", "message": "…" }`

### `DELETE /api/ai/keys/:id`

**200** `{ "ok": true, "removed": true, "code": "AI_KEY_DELETED" }`  
**400** bad id (`AI_KEY_INVALID_ID`)  
**404** unknown id or another user's key (`AI_KEY_NOT_FOUND`)  
**401** logged out (`AI_KEY_UNAUTHORIZED`)

### Admin (not used by the AI-key dialog)

`DELETE /api/admin/ai/server-key` — superadmin only (**403** otherwise). The env
key appears on `/admin/ai` as presence-only (“set via server”). Admin AI
settings (`defaultModel`) and optional server Gemini key persist in Postgres
`app_settings` — not under `/tmp`.

## AI feature calls

When the active vault entry is stored on the server, every AI request includes:

```http
X-Ai-Key-Id: <id>
```

and **must not** send `X-Ai-Api-Key` / `X-Gemini-Api-Key`.

Guest / local-only BYOK (not yet synced) may still send the local key header
until Backend rejects that path; the dialog copy tells the user the key lives
on this device until they sign in.

## Errors

All AI-key vault errors use:

```json
{ "error": "<Thai message>", "code": "AI_KEY_INVALID" }
```

FE maps via `mapAiKeyError()` (prefers `code`, falls back to Thai `error`).

Reserved / shipped codes (full table in `docs/API-AI-KEYS-AND-SKIP.md`):

| Code | Typical use |
|------|-------------|
| `AI_KEY_INVALID` | Fake / unauthorized key on save or test |
| `AI_KEY_MISSING` / `AI_KEY_INVALID_VALUE` | Empty / too-short key |
| `AI_KEY_UNAUTHORIZED` | Not logged in |
| `AI_KEY_NOT_FOUND` | Missing or not owned |
| `AI_KEY_MISSING_FIELDS` | Body incomplete |
| `AI_PROVIDER_RATE_LIMIT` | Rate limited |
| `AI_PROVIDER_QUOTA` | Credits/quota **explicitly** exhausted |
| `AI_PROVIDER_TIMEOUT` | Probe timed out |
| `AI_PROVIDER_UNAVAILABLE` | Provider 5xx |
| `AI_PROVIDER_BAD_REQUEST` | Bad model / request |
| `AI_PROVIDER_ERROR` | Other provider failure |

## Upgrade deep link (F37)

`upgradeUrl` on `/api/entitlement`, `/api/ai/status`, `/api/me`, `/api/admin/limits`.
Empty → FE hides the link. Source: admin `limits.upgradeUrl` or env
`DOCX_FORM_UPGRADE_URL`. **No payments UI on Backend; no hardcoded URL.**

## Fill skip / empty loops

Documented in `docs/API-AI-KEYS-AND-SKIP.md` (`skip` / `rowSkip` on
`POST /api/fill` and `POST /api/batch-fill`). Empty tables are valid.

Client module: `public/ai-key-client.js`  
Dialog module: `public/ai-key-dialog.js` (shim: `public/ai-keys-dialog.js`)
