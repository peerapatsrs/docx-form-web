/**
 * Compatibility shim — one dialog implementation lives in ai-key-dialog.js.
 * Account / legacy imports of /ai-keys-dialog.js keep working.
 */
import {
  openAiKeyDialog,
  openAiKeysDialog,
  installAiKeyDialogGlobal,
} from "./ai-key-dialog.js";

export { openAiKeyDialog, openAiKeysDialog, installAiKeyDialogGlobal };

/** @deprecated use installAiKeyDialogGlobal */
export function installAiKeysDialogGlobal(opts = {}) {
  return installAiKeyDialogGlobal(opts);
}
