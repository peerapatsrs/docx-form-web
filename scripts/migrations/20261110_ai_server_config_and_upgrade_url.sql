-- Admin AI server config + optional upgrade URL (F37 / no-/tmp storage).
-- Additive only. Runtime also ensures these via ensureAdminSchema().

-- Server-side Gemini key/model (non-BYOK) lives in app_settings, not /tmp.
INSERT INTO app_settings (key, value)
VALUES ('ai_server', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- upgradeUrl is an optional field on the existing limits JSON document.
-- Empty / missing → Frontend hides the upgrade deep link (no hardcoded URL).
UPDATE app_settings
SET value = COALESCE(value, '{}'::jsonb) || '{"upgradeUrl":""}'::jsonb,
    "updatedAt" = NOW()
WHERE key = 'limits'
  AND NOT (value ? 'upgradeUrl');
