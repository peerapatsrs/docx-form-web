# FE ↔ BE AI Key API contract

Assumed by Frontend branch `fe/ux-confusing-2026-11-10`. Aligns with Backend
`fix/ai-key-id-credentials` (from `1ea8783`). Session cookie auth; **401** when
logged out for vault routes.

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
- **401** when there is no session.

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

- Missing `entry` / `entries` → **400** `{ "error": "<Thai message>" }`
- Invalid key / provider rejection → **400** `{ "error": "<Thai message>" }`
- **401** when logged out

After a successful PUT the FE clears any in-memory / local plaintext copy for
that id and keeps only the masked metadata (+ `storeOnServer: true`).

### `DELETE /api/ai/keys/:id`

**200** `{ "ok": true, "removed": true }`  
**400** bad id  
**404** unknown id or another user's key  
**401** logged out

### Admin (not used by the AI-key dialog)

`DELETE /api/admin/ai/server-key` — superadmin only (**403** otherwise). The env
key appears on `/admin/ai` as presence-only (“set via server”).

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

Today: `{ "error": "<Thai message>" }` with **no stable `code`**.

FE shows `error` as-is and maps through `mapAiKeyError()` so a future

```json
{ "error": "…", "code": "AI_KEY_INVALID" }
```

can be added without UI rewrites. Known reserved codes (TBD on BE):
`AI_KEY_INVALID`, `AI_KEY_MISSING`, `AI_KEY_UNAUTHORIZED`, `AI_KEY_NOT_FOUND`.

## TBD (hidden behind one FE flag)

`POST` test-key, rotate, and audit are **not** wired. The dialog hides or
disables those controls when `AI_KEY_TEST_ENABLED` is false — no dead buttons.

Client module: `public/ai-key-client.js`  
Dialog module: `public/ai-key-dialog.js`
