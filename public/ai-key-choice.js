/**
 * Pure AI key choice gate — mirrors src/server/ai-key-choice.ts `canUseAi`.
 * Frontend settings UI owns presentation; fill attach button uses this helper.
 *
 * @typedef {{ mode: 'server'|'byok', serverKeyAvailable: boolean, userKeySet: boolean, userKeyHint?: string }} AiKeyChoiceStatus
 */

/**
 * @param {AiKeyChoiceStatus | null | undefined} state
 * @returns {boolean}
 */
export function canUseAi(state) {
  if (!state || typeof state !== "object") return false;
  if (state.mode === "server") return Boolean(state.serverKeyAvailable);
  if (state.mode === "byok") return Boolean(state.userKeySet);
  return false;
}

/**
 * @param {unknown} raw
 * @returns {'server'|'byok'|null}
 */
export function normalizeAiKeyMode(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "server" || v === "byok") return v;
  return null;
}
