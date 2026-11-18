# API: AI keys + generate skip

Stable Backend contract for Frontend (session user). Never returns or logs API key values.

Base: same origin `/api`. Auth: session cookie (Better Auth). Unauthenticated → `401` + `AI_KEY_UNAUTHORIZED`.

---

## AI status (pill)

### `GET /api/ai/status`

Public-ish snapshot used by the header pill. Same effective provider/model resolver as fill/tag.

**Response 200 (extra fields for truthful pill — F19 / F31)**

```json
{
  "connected": true,
  "keySource": "user",
  "keyId": "k-…",
  "provider": "cursor",
  "effectiveProvider": "cursor",
  "effectiveProviderLabel": "Cursor",
  "model": "composer-2.5",
  "effectiveModel": "composer-2.5",
  "defaultModel": "composer-2.5",
  "adminDefaultModel": "gemini-3.8-flash",
  "adminDefaultProvider": "google",
  "lastTestStatus": "ok",
  "lastTestOk": true,
  "lastTestAt": "2026-11-10T12:00:00.000Z",
  "lastTestCode": "AI_KEY_TEST_OK",
  "lastTestMessage": "คีย์ใช้งานได้",
  "configStore": "database",
  "configStoreLabel": "เก็บบนเซิร์ฟเวอร์ (ฐานข้อมูล)",
  "serverEnvCursorKeySource": "set via server",
  "serverEnvGeminiKeySource": null,
  "aiTimeoutMs": 90000,
  "upgradeUrl": ""
}
```

| Field | Meaning |
|-------|---------|
| `keySource` | `user` (BYOK / vault) · `shared` (server env/DB) · `none` |
| `keyId` | Present only when `keySource=user` and vault id resolved |
| `connected` | `true` when a usable key resolves (personal **or** shared) |
| `byok` | Mirrors `DOCX_FORM_BYOK_ONLY` (default on) |
| `effectiveProvider` / `effectiveModel` | What the server will actually call (same resolver as pill) |
| `lastTest*` | From vault row when `keySource=user`; otherwise null |
| `configStore` | `database` (or `browser` when BYOK-only) — **never** a filesystem path |
| `configStoreLabel` | Human storage label — **never** a filesystem path |
| `serverEnv*KeySource` | `"set via server"` or null — **never** raw env var names |
| `upgradeUrl` | F37 deep link string; **`""` → Frontend hides** the upgrade CTA (**no hardcoded URL**; config-driven) |

### Shared server key (`DOCX_FORM_BYOK_ONLY=0`)

Default web mode is BYOK-only (`DOCX_FORM_BYOK_ONLY` unset/`1`): users must bring a personal key; `connected=false` / `keySource=none` without one.

When **`DOCX_FORM_BYOK_ONLY=0`** (or `false`/`no`) and a shared key exists
(`DOCX_FORM_CURSOR_API_KEY` and/or DB `ai_server` Gemini key / Gemini env), **any
logged-in user without a personal key** resolves to that shared key:

| Surface | Behaviour |
|---------|-----------|
| `GET /api/ai/status` | `connected=true`, `keySource=shared`, `byok=false`, **`effectiveProvider` matches the provider that owns the key** (Cursor key → `cursor`, not admin-default Google) |
| AI suggest / draft / batch-from-source | `resolveRouteAiCredentials` → shared key for **that** provider |
| `GET /api/diagnostics` | Same coalesce + `keySource=shared` (superadmin) |

A Cursor shared key must never be accepted as a Gemini override (and vice versa), or
`resolveEffectiveAiProvider` keeps `google` while calling with a Cursor secret → `AI_AUTH`.

This is **not** a premium/plan gate on the shared key. Plan quotas and
`PREMIUM_ENFORCE` feature gates stay separate (`/api/entitlement`, upload limits).
Frontend pill/draft must treat `keySource=shared` + `connected` as ready when
`byok=false` (do not demand a personal key).

**Not on `/api/ai/status`:** `uploadLimitText` lives on `GET /api/entitlement` / `GET /api/me` (`premium.uploadLimitText`) — see below.

Admin: `GET /api/admin/ai` returns the same effective fields plus `premiumEnforceLabel` (`บังคับแผนพรีเมียม` / `ไม่บังคับ`). No `configPath`, no env var names.

Admin AI default model / optional server Gemini key live in Postgres `app_settings` (`ai`, `ai_server`) — **not** under `/tmp`. Legacy `config.json` (including under `/tmp`) is read once and migrated into `ai_server` when present. Vault secrets stay encrypted in the user key table; list/status/audit responses never include plaintext key values.

---

## Entitlement / upload quota (F02) + upgrade link (F37)

### `GET /api/entitlement`

```json
{
  "premium": {
    "paid": true,
    "plan": "pro",
    "maxMultiTemplates": 10,
    "freeMaxMulti": 2,
    "paidMaxMulti": 10,
    "uploadLimitText": "สูงสุด 10 ไฟล์ต่อครั้ง (จ่ายแล้ว)",
    "upgradeUrl": ""
  }
}
```

`maxMultiTemplates` and `uploadLimitText` come from `getAppLimits()` + the user’s plan — never a fixed “ฟรีสูงสุด 2”.

`upgradeUrl` resolution (first non-empty wins): admin `limits.upgradeUrl` → env `DOCX_FORM_UPGRADE_URL` → `""`. Same field on `GET /api/ai/status`, `GET /api/me` (`premium.upgradeUrl`), and `GET|POST /api/admin/limits`.

---

## AI key choice (system vs own) — FE contract

Shared gate helper: `src/server/ai-key-choice.ts` / `public/ai-key-choice.js`
(`canUseAi`). Frontend settings UI owns presentation; Backend exposes status +
models with `source` for the attach-page picker groups (**คีย์เซิร์ฟเวอร์** /
**คีย์ของฉัน**).

### `GET /api/ai/keys/status`

Exact non-secret status (never includes system key material):

```json
{
  "mode": "server",
  "serverKeyAvailable": true,
  "userKeySet": false,
  "userKeyHint": "••••1234"
}
```

| Field | Meaning |
|-------|---------|
| `mode` | Saved preference: `server` (system key) or `byok` (own key) |
| `serverKeyAvailable` | Shared server key configured and BYOK-only off |
| `userKeySet` | User has at least one vault key |
| `userKeyHint` | Optional masked last-4 of the **first** saved user vault key only (`••••1234`) — never the system key |

`canUseAi(status)` → `mode===server` ? `serverKeyAvailable` : `userKeySet`.

Signed-out → **401** + `AI_KEY_UNAUTHORIZED` (same as other `/ai/keys*` routes).

### `PUT /api/ai/keys/status`

Update command. Body (all optional):

```json
{
  "mode": "byok",
  "apiKey": "…",
  "provider": "google",
  "label": "…",
  "model": "…",
  "deleteKey": false
}
```

- `mode` → persist preference (`AI_KEY_INVALID_MODE` / `AI_SERVER_KEY_UNAVAILABLE` on bad choice).
- `apiKey` (+ optional provider/label/model) → create/replace own vault key (live-validated; existing `POST/PUT /api/ai/keys*` still work).
- `deleteKey: true` → **deletes all** of the user's vault keys (not a single row).
- **200** returns the same status shape as GET.

### `GET /api/ai/keys/models`

Models for the attach picker, derived from the live provider catalog (not a
hardcoded per-model list). Server models only when `serverKeyAvailable` (for
configured server providers). BYOK models are limited to providers the user
**actually has a saved vault key for** — never the whole catalog.

```json
{
  "models": [
    { "id": "composer-2.5", "label": "Composer 2.5", "provider": "cursor", "source": "server" },
    { "id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash", "provider": "google", "source": "byok" }
  ],
  "mode": "server",
  "serverKeyAvailable": true,
  "userKeySet": true,
  "userKeyHint": "••••1234"
}
```

| Field | Meaning |
|-------|---------|
| `models[].id` | Model id |
| `models[].label` | Display label |
| `models[].provider` | Provider id from catalog |
| `models[].source` | `server` \| `byok` — FE groups the picker |

Also echoes the status fields above.

### Fill / suggest — optional `source`

`POST /api/template/suggest-tags`, `POST /api/source-map`, and
`POST /api/batch-from-source` accept optional form/query field:

| Field | Meaning |
|-------|---------|
| `source` | `server` \| `byok` — overrides saved `mode` for this call |
| `aiModel` / `geminiModel` | Chosen model (must belong to that source) |
| `aiProvider` | Optional provider hint |

When `source` is omitted, the saved `mode` from status is used. Server validates
the model belongs to that source and that a matching vault key exists for the
model's provider; otherwise **4xx** with `AI_SERVER_KEY_UNAVAILABLE`,
`AI_KEY_REQUIRED` (signed-in, missing key — never 401), or
`AI_MODEL_SOURCE_MISMATCH` (e.g. `source=byok` + OpenAI model when the user only
has a Google key). **401** is only for not signed in (`AI_KEY_UNAUTHORIZED`).
BYOK calls never silently fall back to a shared server key or non-AI heuristics
on provider rejection — the error is returned to the client.
The credential gate uses the same `canUseAi` rule.

### `GET /api/ai/jobs/:id`

Async AI jobs (`suggest-tags?async=1`, etc.). On `status: "error"`, the payload
includes both `error` (message) and `code` (e.g. `AI_SERVER_KEY_INVALID`,
`AI_KEY_REQUIRED`, `AI_PROVIDER_ERROR`).

---

## AI keys (canonical: plural)

### `GET /api/ai/keys`

List the current user’s saved keys (masked meta only).

**Response 200**

```json
{
  "entries": [
    {
      "id": "k-…",
      "provider": "google",
      "label": "งานหลัก",
      "model": "gemini-3.8-flash",
      "maskedKey": "••••…abcd",
      "hint": "••••…abcd",
      "hasKey": true,
      "storeOnServer": true,
      "createdAt": "2026-11-10T11:00:00.000Z",
      "updatedAt": "2026-11-10T11:00:00.000Z",
      "lastUsedAt": "2026-11-10T12:00:00.000Z",
      "lastTestAt": "2026-11-10T11:30:00.000Z",
      "lastTestOk": true,
      "lastTestCode": "AI_KEY_TEST_OK",
      "lastTestMessage": "คีย์ใช้งานได้",
      "lastTestStatus": "ok"
    }
  ]
}
```

`lastTestStatus`: `ok` | `error` | `untested`.

### `POST /api/ai/keys` — create

```json
{
  "provider": "google",
  "label": "งานหลัก",
  "model": "gemini-3.8-flash",
  "apiKey": "AIza…",
  "id": "k-optional-client-id"
}
```

- `id` optional (server generates `k-…` when omitted).
- **Live validation (F30):** server runs a lightweight provider probe (timeout-capped) **before** encrypting/storing. Fake/invalid keys are rejected and **not stored**.
- **201** `{ ok: true, entry: <public meta> }`
- Errors: `AI_KEY_INVALID`, `AI_KEY_INVALID_PROVIDER`, `AI_KEY_INVALID_VALUE`, `AI_KEY_INVALID_ID`, `AI_KEY_EXISTS`, `AI_KEY_MISSING_FIELDS`, `AI_PROVIDER_TIMEOUT`, …

### `PUT /api/ai/keys` — upsert (compat)

Body: `{ "entry": {…} }` or `{ "entries": […] }` (same fields as create; `id` + `apiKey` required).

Validates each key with the same probe before writing any. Rejected → nothing stored for that request.

**200** `{ ok: true, entries: [<public meta>] }`

### `GET /api/ai/keys/:id`

**200** `{ entry: <public meta> }` · **404** `AI_KEY_NOT_FOUND` (also for other users’ ids — no existence leak)

### `PUT /api/ai/keys/:id` — replace / rotate value

```json
{ "apiKey": "new-secret", "label": "optional", "model": "optional", "provider": "optional" }
```

Same live validation as create. On reject the previous vault value is unchanged.

**200** `{ ok: true, entry }` · **404** `AI_KEY_NOT_FOUND`

### `POST /api/ai/keys/:id/test` — test saved key

Optional body: `{ "timeoutMs": 15000 }` (capped). Runs a minimal live provider call under `DOCX_FORM_AI_TIMEOUT_MS` (default ≤ 20s for tests).

**200** (ok)

```json
{
  "ok": true,
  "code": "AI_KEY_TEST_OK",
  "message": "คีย์ใช้งานได้",
  "provider": "google",
  "durationMs": 123,
  "entry": { "…updated lastTest…": true }
}
```

**400 / 504** when not ok — `code` is one of the provider / key codes below.

Updates `lastTest*` and writes an audit `test` event. On success also refreshes `lastUsedAt`.

### `POST /api/ai/keys/test` — test plaintext before save

```json
{ "provider": "google", "apiKey": "AIza…", "timeoutMs": 15000 }
```

Does **not** persist. Same result shape as saved-key test (no `entry`).

### `DELETE /api/ai/keys/:id`

Ownership enforced in SQL. **200** `{ ok: true, removed: true, code: "AI_KEY_DELETED" }` · **404** `AI_KEY_NOT_FOUND`

### `GET /api/ai/keys/audit`

Own audit events only.

Query: `?keyId=k-…` (optional), `?limit=50` (max 200).

**200**

```json
{
  "events": [
    {
      "id": "1",
      "keyId": "k-…",
      "action": "create",
      "provider": "google",
      "ok": true,
      "code": "AI_KEY_CREATED",
      "message": "สร้างคีย์แล้ว",
      "actorUserId": "user-…",
      "createdAt": "2026-11-10T11:00:00.000Z"
    }
  ]
}
```

`action`: `create` | `test` | `replace` | `delete` | `use`  
Never includes key material.

---

## Singular aliases (FIXES.md §9)

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/api/ai/key` | `?id=` → one entry; else `{ entry: first\|null, entries, connected }` |
| PUT | `/api/ai/key` | create or replace primary / given `id` (also validates before store) |
| POST | `/api/ai/key/test` | saved (`id`) or plaintext |
| DELETE | `/api/ai/key` | `?id=` / body.id / else first key |

Prefer plural endpoints for new UI work.

---

## Error codes (AI keys + provider)

Shared mapper: `classifyProviderError` in `src/server/ai-http-errors.ts` (one place — fill/tag/models/test/save).  
**Credits/quota only when the provider body actually says so** — never the default for 401/429.

| Code | HTTP | Meaning |
|------|------|---------|
| `AI_KEY_UNAUTHORIZED` | 401 | Not logged in |
| `AI_KEY_REQUIRED` | 400 | Signed-in user missing a usable key for the chosen source/provider |
| `AI_MODEL_SOURCE_MISMATCH` | 400 | Model not available for that source / vault provider |
| `AI_SERVER_KEY_UNAVAILABLE` | 400 | Server key path selected but no shared key configured |
| `AI_SERVER_KEY_INVALID` | 400 | Shared server key rejected by provider |
| `AI_KEY_NOT_FOUND` | 404 | Missing or not owned |
| `AI_KEY_INVALID_ID` | 400 | Bad id format |
| `AI_KEY_INVALID_PROVIDER` | 400 | Unknown provider |
| `AI_KEY_INVALID_VALUE` | 400 | Empty / too-short key (what create/rotate/test emit today) |
| `AI_KEY_INVALID` | 400 | Provider rejected key (auth) — **save/rotate does not store** |
| `AI_KEY_MISSING_FIELDS` | 400 | Body incomplete (`entry` / `entries`) |

`AI_KEY_MISSING` is **not** emitted by Backend today. Frontend may still map it for
client-side empty-field checks before the request; treat it as FE-reserved.
| `AI_KEY_EXISTS` | 400 | Create with existing id |
| `AI_KEY_CREATED` | — | Audit only |
| `AI_KEY_REPLACED` | — | Audit only |
| `AI_KEY_DELETED` | 200 | Delete ok / audit |
| `AI_KEY_USED` | — | Audit when vault key used on AI routes |
| `AI_KEY_TEST_OK` | 200 | Probe succeeded |
| `AI_KEY_PROVIDER_AUTH` | 400 | Deprecated alias — prefer `AI_KEY_INVALID` |
| `AI_KEY_PROVIDER_ERROR` | 400 | Legacy other failure — prefer `AI_PROVIDER_ERROR` |
| `AI_KEY_TEST_TIMEOUT` | 504 | Legacy timeout — prefer `AI_PROVIDER_TIMEOUT` |
| `AI_PROVIDER_AUTH` | 400 | Auth failure (alias of invalid key family) |
| `AI_PROVIDER_RATE_LIMIT` | 429/400 | Rate limited (not quota unless body says so) |
| `AI_PROVIDER_QUOTA` | 402/400 | Credits/quota **explicitly** exhausted by provider |
| `AI_PROVIDER_TIMEOUT` | 504 | Probe / call timed out |
| `AI_PROVIDER_UNAVAILABLE` | 502/503 | Provider down / 5xx |
| `AI_PROVIDER_BAD_REQUEST` | 400 | Bad model / endpoint / request |
| `AI_PROVIDER_ERROR` | 400 | Other provider failure |
| `AI_KEY_SERVER_ERROR` | 500 | Unexpected |

Frontend should map these to TH/EN copy (see FIXES.md dialog strings).

Env:

- `DOCX_FORM_BYOK_ONLY` — default `1` (personal keys only). Set `0` to enable shared server key for users without a personal key (see above).
- `DOCX_FORM_CURSOR_API_KEY` — shared Cursor key used when BYOK-only is off (and as vault-auth fallback).
- `DOCX_FORM_AI_TIMEOUT_MS` — shared AI call budget (also caps key tests ≤ 20s)
- `DOCX_FORM_AI_KEY_TEST_MOCK=ok\|401\|auth\|quota\|429\|hang` — local/CI mock for key probe

---

## Template fields — non-loop table cells

`POST /api/template/fields` (with `includeContent=1`) returns:

```json
{
  "fields": [
    {
      "name": "ชื่อผู้ติดต่อ",
      "type": "text",
      "location": { "tableIndex": 0, "rowIndexInTable": 0, "cellIndex": 1 }
    },
    {
      "name": "เบอร์โทร",
      "type": "text",
      "location": { "tableIndex": 0, "rowIndexInTable": 1, "cellIndex": 1 }
    }
  ],
  "layout": [
    {
      "type": "table",
      "headerRows": [],
      "templateCells": [],
      "staticRows": [
        [
          { "text": "ชื่อ" },
          {
            "text": "{{ชื่อผู้ติดต่อ}}",
            "fieldName": "ชื่อผู้ติดต่อ",
            "tags": ["ชื่อผู้ติดต่อ"]
          }
        ]
      ]
    }
  ]
}
```

| Piece | Contract |
|-------|----------|
| `FormField` | `{ name, type, aliases?, location? }` — tags in **any** table cell are normal fields (`text` / `bool` / `auto` / …). No special cell type. |
| `location` | Optional `{ tableIndex, rowIndexInTable, cellIndex }` (0-based; first cell hit wins). |
| `layout[]` table without `listName` | Non-loop → `staticRows[][]`. Each cell: `{ text, fieldName?, tags?, … }`. |
| `layout[]` table with `listName` | Loop table — unchanged (`templateCells` + optional `trailingRows`). |
| FE fill preview | FE tip tokenizes cell text / uses `fieldName`\|`tags[]` for inline blank + ข้าม (`public/doc-table-fields.js`). Falls back to seeding missing fields from layout tags. |
| Fill / skip | Same as other text fields: `values[name]` fills the cell; `skip[name]=true` → `""` → no leftover `{{…}}`. |

Loop tables (`{{#list}}`…`{{/}}`) keep the existing list field + `templateCells` path.

---

## Generate / fill — skipped fields & empty loops

### How the client marks skip

**Preferred (raw values + maps)** — multipart `POST /api/fill`:

| Field | Type | Meaning |
|-------|------|---------|
| `file` | `.docx` | Template |
| `values` | JSON object | Field values as edited (lists are arrays of row objects) |
| `skip` | JSON object | `{ "<fieldName>": true }` — field/table skipped (“ข้าม”) |
| `rowSkip` | JSON object | `{ "<listName>": [ { "<item>": true }, … ] }` — per-cell skip inside rows |
| `image:<name>` | file | Optional; omitted automatically when `skip[name]` |

When `skip` / `rowSkip` are present, the server runs `toFillValues(fields, values, skip, rowSkip)`:

- skipped **text** → `""` (engine removes tag; `skipEmptyTags: false`)
- skipped **list / table** → `[]` (loop body removed; no leftover `{{#…}}` / `{{/}}`)
- skipped **bool** → `falseText`
- empty loop with **no skip map** but `values[listName] = []` (or missing list key) is also accepted and rendered empty

**Legacy:** clients that already send pre-transformed values (empty string / `[]` for skipped fields) may omit `skip` / `rowSkip`. Still supported.

### `POST /api/batch-fill`

Each `items[]` entry may include optional `skip` / `rowSkip` alongside `values` (same semantics).

### Error codes (fill)

| Code | HTTP | Meaning |
|------|------|---------|
| `FILL_MISSING_FILE` | 400 | No template file |
| `FILL_INVALID_FILE` | 400 | Not a usable `.docx` |
| `FILL_MISSING_VALUES` | 400 | No `values` |
| `FILL_BAD_JSON` | 400 | `values` not JSON |
| `FILL_BAD_SKIP` | 400 | `skip` not a JSON object |
| `FILL_BAD_ROW_SKIP` | 400 | `rowSkip` not a JSON object |
| `FILL_LIST_NOT_ARRAY` | 400 | List field value is not an array |
| `FILL_IMAGE_TOO_LARGE` | 400 | Image > 8 MB |
| `FILL_IMAGE_INVALID` | 400 | Non-image upload |

There is **no** server-side “must have ≥1 row” rule. Empty / skipped tables are valid; validation UX is Frontend-only.

### Contract note for Frontend validation

- Ticking **ข้าม** on a field or whole table must set `skip[fieldName]=true` (and ideally still send the field in `values`).
- Tables with only an empty starter row should either be skipped or sent as `[]` once the user confirms skip — Backend will not block generate for empty loops.
