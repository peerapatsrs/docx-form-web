# FE ↔ BE AI Key API contract

Assumed by Frontend branch `fe/ux-confusing-2026-11-10`. Aligns with Backend
`docs/API-AI-KEYS-AND-SKIP.md` on `dev-integration-2026-11-10` / `fix/ai-key-id-credentials`
(code is source of truth).

Session cookie auth; **401** + `AI_KEY_UNAUTHORIZED` when logged out for vault
routes. Frontend never displays or logs the full secret after save. AI feature
calls send **`X-Ai-Key-Id` only** (no raw key header) when the key is stored on
the server. Guest / local-only keys stay on-device until the user logs in and
syncs.

Canonical Backend doc: `docs/API-AI-KEYS-AND-SKIP.md` (Backend branches).  
DEV one-click login: `docs/FE-DEV-TEST-LOGIN.md` + Backend `docs/DEV-TEST-ACCOUNTS.md`.

## Status / entitlement shapes (config-driven; no hardcoded URLs)

### `GET /api/ai/status` (pill)

Includes `keySource` (`user`|`shared`|`none`) and `upgradeUrl` (string; `""` → hide CTA).
Also `effectiveProvider` / `effectiveModel` / `lastTest*` / `configStore`=`database`|`browser`.
Does **not** include `uploadLimitText`.

### `GET /api/entitlement` / `GET /api/me`

`premium.uploadLimitText` (plan-aware Thai quota copy) and `premium.upgradeUrl`
(same resolver: admin `limits.upgradeUrl` → env `DOCX_FORM_UPGRADE_URL` → `""`).

## Key choice (system vs own) — exact status

Helpers: `public/ai-key-choice.js` ↔ `src/server/ai-key-choice.ts` (`canUseAi`).

### `GET /api/ai/keys/status`

```json
{ "mode": "server"|"byok", "serverKeyAvailable": true, "userKeySet": false, "userKeyHint": "••••1234" }
```

`userKeyHint` = masked last-4 of **user** key only — never the system key.
Attach gate: `canUseAi(status)`.

### `PUT /api/ai/keys/status`

Update `mode` and/or save/delete own key (`apiKey`, `deleteKey`). Returns status.

### `GET /api/ai/keys/models`

```json
{ "models": [{ "id", "label", "provider", "source": "server"|"byok" }], "mode", "serverKeyAvailable", "userKeySet", "userKeyHint?" }
```

FE groups the attach-page picker by `source`. Server lists server models only when
`serverKeyAvailable`. BYOK models are limited to providers the user has a saved
vault key for (not the whole catalog). `userKeyHint` is from the first saved key;
`deleteKey: true` on PUT status removes **all** user vault keys.

### Fill optional `source`

Suggest-tags / source-map / batch-from-source accept form/query `source=server|byok`
with the chosen model. Omit → saved `mode`. Mismatch → `AI_MODEL_SOURCE_MISMATCH`;
signed-in missing key → **400** `AI_KEY_REQUIRED` (401 only when not signed in).
Provider rejection on BYOK never silently falls back to shared/non-AI.

## Endpoints (FE uses)

| Method | Path | FE usage |
|--------|------|----------|
| GET | `/api/ai/keys/status` | Mode + availability for settings / attach gate |
| PUT | `/api/ai/keys/status` | Set mode; optional save/delete own key |
| GET | `/api/ai/keys/models` | Model picker rows with `source` |
| GET | `/api/ai/keys` | List masked entries |
| PUT | `/api/ai/keys` | Create / upsert (`{ entry }` or `{ entries }`) — live-validated |
| PUT | `/api/ai/keys/:id` | Replace / rotate value — live-validated |
| DELETE | `/api/ai/keys/:id` | Delete |
| POST | `/api/ai/keys/:id/test` | Test saved vault key (`AI_KEY_TEST_ENABLED=true`) |
| POST | `/api/ai/keys/test` | Test plaintext before save (no persist) |
| GET | `/api/ai/keys/audit` | Own audit events (client helper ready) |
| GET | `/api/ai/status` | Header pill / providers |
| POST | `/api/fill` | Generate — sends `values` + `skip` + `rowSkip` |
| POST | `/api/batch-fill` | Multi generate — each item may include `skip` / `rowSkip` |

Prefer **plural** routes. Singular `/api/ai/key*` aliases exist on Backend but
are not used by the dialog.

### Create / upsert body

```json
{ "entry": { "id": "k-…?", "provider": "google", "label": "…", "model": "…", "apiKey": "…" } }
```

- **201/200** `{ ok: true, entry|entries: <masked> }` — FE clears plaintext.
- Invalid / provider rejection → **400** `{ "error": "…", "code": "AI_KEY_INVALID"|… }` — **not stored**.

### Test saved key

`POST /api/ai/keys/:id/test` optional `{ "timeoutMs": 15000 }`  
**200** `{ ok: true, code: "AI_KEY_TEST_OK", message, entry?, durationMs }`

### Errors & success codes

Bodies are `{ "error": "<message>", "code": "<CODE>" }` (and success/info may
use `message` + `code`). FE maps via `mapAiKeyError` / `mapAiKeySuccess` /
`mapFillError` in `public/ai-key-client.js` (TH default, EN when locale/`navigator` is English).

**AI key / provider (Backend emits):**  
`AI_KEY_UNAUTHORIZED`, `AI_KEY_NOT_FOUND`, `AI_KEY_INVALID_ID`,
`AI_KEY_INVALID_PROVIDER`, `AI_KEY_INVALID_VALUE` (empty / too-short key),
`AI_KEY_INVALID`, `AI_KEY_MISSING_FIELDS`, `AI_KEY_EXISTS`,
`AI_KEY_PROVIDER_AUTH`, `AI_KEY_PROVIDER_ERROR`, `AI_KEY_TEST_TIMEOUT`,
`AI_KEY_SERVER_ERROR`, `AI_PROVIDER_AUTH`, `AI_PROVIDER_RATE_LIMIT`,
`AI_PROVIDER_QUOTA`, `AI_PROVIDER_TIMEOUT`, `AI_PROVIDER_UNAVAILABLE`,
`AI_PROVIDER_BAD_REQUEST`, `AI_PROVIDER_ERROR`

**FE-reserved (client pre-check; Backend does not emit today):** `AI_KEY_MISSING`

**Success / info (toasts):**  
`AI_KEY_CREATED`, `AI_KEY_REPLACED`, `AI_KEY_DELETED`, `AI_KEY_USED`,
`AI_KEY_TEST_OK`

**Fill / generate:**  
`FILL_MISSING_FILE`, `FILL_INVALID_FILE`, `FILL_MISSING_VALUES`, `FILL_BAD_JSON`,
`FILL_BAD_SKIP`, `FILL_BAD_ROW_SKIP`, `FILL_LIST_NOT_ARRAY`,
`FILL_IMAGE_TOO_LARGE`, `FILL_IMAGE_INVALID`

Fallback order: mapped `code` → `error`/`message` text → generic Thai/EN.

## Skip / loop tables on generate

Preferred multipart fields on `POST /api/fill`:

| Field | Meaning |
|-------|---------|
| `file` | Template `.docx` |
| `values` | JSON object (FE currently still sends skip-transformed empties for legacy compat) |
| `skip` | `{ "<field>": true }` |
| `rowSkip` | `{ "<list>": [ { "<item>": true }, … ] }` |
| `image:<name>` | Omitted when `skip[name]` |

`POST /api/batch-fill` items may include the same `skip` / `rowSkip` keys.

Empty / skipped tables are valid server-side — required-row UX stays Frontend-only.

## AI feature calls

When the active vault entry is stored on the server:

```http
X-Ai-Key-Id: <id>
```

Do **not** send `X-Ai-Api-Key` / `X-Gemini-Api-Key` in that case.

## Client modules

- `public/ai-key-client.js` — typed client + mappers (`AI_KEY_TEST_ENABLED = true`)
- `public/ai-key-choice.js` — `canUseAi` / `normalizeAiKeyMode` (mirrors server)
- `public/ai-key-dialog.js` — empty / saved / test / replace / delete UI
  (shim: `public/ai-keys-dialog.js`)

Admin AI settings persist in Postgres `app_settings` (`ai`, `ai_server`), not `/tmp`.
