-- New migration (do not edit applied migrations).
-- Applied at runtime by ensureUserAiKeysTable() / ensureUserAiKeyAuditTable().
-- Adds last-used / last-test metadata on user_ai_keys and an audit trail.
-- Never store API key values (or key prefixes beyond the masked hint UI) in audit.

ALTER TABLE user_ai_keys
  ADD COLUMN IF NOT EXISTS "lastUsedAt" timestamptz NULL;

ALTER TABLE user_ai_keys
  ADD COLUMN IF NOT EXISTS "lastTestAt" timestamptz NULL;

ALTER TABLE user_ai_keys
  ADD COLUMN IF NOT EXISTS "lastTestOk" boolean NULL;

ALTER TABLE user_ai_keys
  ADD COLUMN IF NOT EXISTS "lastTestCode" text NULL;

ALTER TABLE user_ai_keys
  ADD COLUMN IF NOT EXISTS "lastTestMessage" text NULL;

CREATE TABLE IF NOT EXISTS user_ai_key_audit (
  id bigserial PRIMARY KEY,
  "userId" text NOT NULL,
  "keyId" text NOT NULL,
  action text NOT NULL,
  provider text NOT NULL DEFAULT '',
  ok boolean NOT NULL DEFAULT false,
  code text NULL,
  message text NULL,
  "actorUserId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_ai_key_audit_user_created_idx
  ON user_ai_key_audit ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS user_ai_key_audit_key_created_idx
  ON user_ai_key_audit ("userId", "keyId", "createdAt" DESC);
