/**
 * AI key settings dialog — empty / saved / delete-confirm / error states.
 * Matches uploads/ai-key-dialog.html mockup. Uses public/ai-key-client.js.
 */

import {
  AI_KEY_TEST_ENABLED,
  deleteAiKey,
  listAiKeys,
  mapAiKeyError,
  maskAiKeyLocal,
  upsertAiKeys,
} from "./ai-key-client.js";

const AI_VAULT_LS = "docx-form-web:aiVault:v1";
const PROVIDER_DOCS = {
  google: "https://aistudio.google.com/apikey",
  cursor: "https://cursor.com/settings",
};

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function providerLabel(id) {
  const map = {
    google: "Google Gemini",
    openai: "OpenAI",
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
    groq: "Groq",
    xai: "xAI",
    mistral: "Mistral",
    cursor: "Cursor",
  };
  return map[String(id || "").trim()] || String(id || "AI");
}

function emptyVault() {
  return { entries: [], activeId: null };
}

function readVault() {
  try {
    const raw = localStorage.getItem(AI_VAULT_LS);
    if (!raw) return emptyVault();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return emptyVault();
    return {
      entries: parsed.entries.filter((e) => e && e.id && e.provider),
      activeId: parsed.activeId || null,
    };
  } catch {
    return emptyVault();
  }
}

function writeVault(vault) {
  try {
    localStorage.setItem(
      AI_VAULT_LS,
      JSON.stringify({
        entries: vault.entries,
        activeId: vault.activeId,
      }),
    );
  } catch {
    /* private mode */
  }
}

function newEntryId() {
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function getActiveEntry(vault = readVault()) {
  if (!vault.entries.length) return null;
  return (
    vault.entries.find((e) => e.id === vault.activeId) || vault.entries[0] || null
  );
}

function entryHasUsableKey(entry) {
  if (!entry) return false;
  if (String(entry.apiKey || "").trim()) return true;
  if (entry.storeOnServer && entry.hasKey !== false && entry.maskedKey) return true;
  if (entry.maskedKey) return true;
  return false;
}

function formatLastUsed(isoOrDate) {
  try {
    const d = isoOrDate ? new Date(isoOrDate) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    const date = new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    return `ใช้ล่าสุด ${date} เวลา ${time} น. (เขตเวลาเอเชีย/กรุงเทพฯ)`;
  } catch {
    return "";
  }
}

function trapFocus(overlay) {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusables = () =>
    [
      ...overlay.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el instanceof HTMLElement && el.offsetParent !== null);
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  overlay.addEventListener("keydown", onKey);
  return {
    focusFirst: () => queueMicrotask(() => focusables()[0]?.focus()),
    focusSelector: (sel) =>
      queueMicrotask(() => {
        const el = overlay.querySelector(sel);
        if (el instanceof HTMLElement) el.focus();
      }),
    release: () => {
      overlay.removeEventListener("keydown", onKey);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    },
  };
}

function showToast(message) {
  document.getElementById("aiKeyToast")?.remove();
  const el = document.createElement("div");
  el.id = "aiKeyToast";
  el.className = "ai-key-toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 4200);
}

/**
 * @param {{
 *   loggedIn?: boolean,
 *   preferredProvider?: string,
 *   providers?: { id: string, label: string, docsUrl?: string, defaultModel?: string }[],
 *   onChange?: () => void,
 *   onBanner?: (msg: string, kind?: string) => void,
 * }} [opts]
 */
export async function openAiKeyDialog(opts = {}) {
  const loggedIn = !!opts.loggedIn;
  const preferredProvider = String(opts.preferredProvider || "").trim();
  const providers =
    Array.isArray(opts.providers) && opts.providers.length
      ? opts.providers
      : [
          {
            id: "google",
            label: "Google Gemini",
            docsUrl: PROVIDER_DOCS.google,
            defaultModel: "gemini-3.8-flash",
          },
        ];
  // Prefer header/active provider when adding a key (F06).
  if (preferredProvider) {
    const pref = providers.find((p) => p.id === preferredProvider);
    if (pref) {
      providers.splice(0, providers.length, pref, ...providers.filter((p) => p.id !== pref.id));
    }
  }

  if (loggedIn) {
    const remote = await listAiKeys();
    if (remote.ok && remote.entries.length) {
      const vault = readVault();
      const byId = new Map(vault.entries.map((e) => [e.id, e]));
      for (const r of remote.entries) {
        const existing = byId.get(r.id);
        byId.set(r.id, {
          id: r.id,
          provider: r.provider || existing?.provider || "google",
          label: r.label || existing?.label || providerLabel(r.provider),
          model: r.model || existing?.model || "",
          // Never keep / reintroduce plaintext from the server response.
          apiKey: "",
          storeOnServer: true,
          hasKey: r.hasKey !== false,
          maskedKey: r.maskedKey || existing?.maskedKey || "••••",
          lastUsedAt: existing?.lastUsedAt || null,
        });
      }
      vault.entries = [...byId.values()];
      if (!vault.activeId || !byId.has(vault.activeId)) {
        vault.activeId = vault.entries[0]?.id || null;
      }
      writeVault(vault);
    } else if (!remote.ok && remote.error?.status === 401) {
      /* guest path */
    }
  }

  document.getElementById("aiKeyDialog")?.remove();

  return new Promise((resolve) => {
    let mode = entryHasUsableKey(getActiveEntry()) ? "saved" : "empty";
    let replaceMode = false;
    let busy = false;
    let errorMsg = "";

    const overlay = document.createElement("div");
    overlay.id = "aiKeyDialog";
    overlay.className = "dialog-overlay ai-key-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const focus = trapFocus(overlay);

    const finish = (result) => {
      focus.release();
      document.removeEventListener("keydown", onDocKey);
      overlay.remove();
      opts.onChange?.();
      resolve(result);
    };

    const onDocKey = (e) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      if (mode === "delete") {
        mode = "saved";
        paint();
        return;
      }
      finish({ action: "cancel" });
    };
    document.addEventListener("keydown", onDocKey);

    function storageHint() {
      return loggedIn
        ? "คีย์จะถูกเข้ารหัสและผูกกับบัญชีนี้ — ไม่แสดงคีย์เต็มอีกครั้งหลังบันทึก"
        : "คีย์จะเก็บเฉพาะในเครื่องนี้จนกว่าจะเข้าสู่ระบบเพื่อซิงก์ข้ามเครื่อง — ไม่แสดงคีย์เต็มอีกครั้งหลังบันทึก";
    }

    function paint() {
      const entry = getActiveEntry();
      const activeProvider = entry?.provider || providers[0]?.id || "google";
      const docsUrl =
        providers.find((p) => p.id === activeProvider)?.docsUrl ||
        PROVIDER_DOCS[activeProvider] ||
        PROVIDER_DOCS.google;

      if (mode === "saved" || mode === "delete") {
        const mask =
          entry?.maskedKey ||
          (entry?.apiKey ? maskAiKeyLocal(entry.apiKey) : "••••");
        const lastUsed = formatLastUsed(entry?.lastUsedAt) || "ยังไม่เคยทดสอบจากหน้านี้";
        overlay.innerHTML = `
          <div class="dialog-card ai-key-dialog-card">
            <h2 class="dialog-title" id="aiKeyDlgTitle">คีย์ AI ของท่าน</h2>
            <p class="dialog-body" id="aiKeyDlgBody">ใช้คีย์นี้เมื่อกดช่วยกรอกหรือแนะนำช่อง ท่านสามารถ${AI_KEY_TEST_ENABLED ? "ทดสอบ " : ""}เปลี่ยน หรือลบได้ตลอด</p>
            <div class="ai-key-saved-card">
              <div class="ai-key-masked" aria-label="คีย์ที่บังแล้ว">${escapeHtml(mask)}</div>
              <p class="ai-key-meta">ผู้ให้บริการ: ${escapeHtml(providerLabel(entry?.provider))}<br />${escapeHtml(lastUsed)}</p>
            </div>
            <div class="ai-key-row-actions">
              ${
                AI_KEY_TEST_ENABLED
                  ? `<button type="button" class="btn-primary" data-ai-act="test" ${busy ? "disabled" : ""}>ทดสอบ</button>`
                  : ""
              }
              <button type="button" class="btn-secondary" data-ai-act="replace" ${busy ? "disabled" : ""}>เปลี่ยนคีย์</button>
              <button type="button" class="btn-danger-outline" data-ai-act="delete" ${busy ? "disabled" : ""}>ลบคีย์</button>
            </div>
            ${
              mode === "delete"
                ? `<div class="ai-key-confirm" role="alertdialog" aria-labelledby="aiKeyDelTitle" aria-describedby="aiKeyDelDesc">
              <div class="ai-key-confirm-box">
                <h3 id="aiKeyDelTitle">ลบคีย์นี้?</h3>
                <p id="aiKeyDelDesc">เมื่อลบแล้ว ฟังก์ชัน AI จะหยุดทำงานจนกว่าจะเพิ่มคีย์ใหม่ คีย์ที่ลบแล้วกู้คืนไม่ได้</p>
                <div class="ai-key-actions">
                  <button type="button" class="btn-secondary" data-ai-act="cancel-del">ยกเลิก</button>
                  <button type="button" class="btn-danger" data-ai-act="confirm-del" ${busy ? "disabled" : ""}>ลบคีย์</button>
                </div>
              </div>
            </div>`
                : ""
            }
          </div>`;
        overlay.setAttribute("aria-labelledby", "aiKeyDlgTitle");
        overlay.setAttribute("aria-describedby", "aiKeyDlgBody");
        wire();
        if (mode === "delete") focus.focusSelector('[data-ai-act="cancel-del"]');
        else focus.focusFirst();
        return;
      }

      // empty / error / replace
      const options = providers
        .map(
          (p) =>
            `<option value="${escapeAttr(p.id)}" ${p.id === activeProvider ? "selected" : ""}>${escapeHtml(p.label || providerLabel(p.id))}</option>`,
        )
        .join("");
      overlay.innerHTML = `
        <div class="dialog-card ai-key-dialog-card">
          <h2 class="dialog-title" id="aiKeyDlgTitle">ตั้งค่าคีย์ AI</h2>
          <p class="dialog-body" id="aiKeyDlgBody">ใส่คีย์ของท่านเพื่อใช้ช่วยกรอกและแนะนำช่องในเอกสาร ${escapeHtml(storageHint())}</p>
          <label class="ai-key-label" for="aiKeyProvider">ผู้ให้บริการ</label>
          <select id="aiKeyProvider" ${busy ? "disabled" : ""}>${options}</select>
          <label class="ai-key-label" for="aiKeySecret">คีย์ API</label>
          <input id="aiKeySecret" type="password" autocomplete="off" spellcheck="false"
            placeholder="วางคีย์ที่นี่" aria-invalid="${errorMsg ? "true" : "false"}"
            aria-describedby="${errorMsg ? "aiKeyErr" : "aiKeyHint"}" ${busy ? "disabled" : ""} />
          ${
            errorMsg
              ? `<p class="ai-key-err" id="aiKeyErr" role="alert">${escapeHtml(errorMsg)}</p>`
              : ""
          }
          <p class="ai-key-hint" id="aiKeyHint">ยังไม่มีคีย์? <a href="${escapeAttr(docsUrl)}" target="_blank" rel="noopener noreferrer">เปิดหน้าสร้างคีย์ที่ ${escapeHtml(providerLabel(activeProvider))}</a></p>
          <div class="ai-key-actions">
            <button type="button" class="btn-primary" data-ai-act="save" ${busy ? "disabled" : ""}>${busy ? "กำลังบันทึก…" : "บันทึกคีย์"}</button>
            <button type="button" class="btn-ghost" data-ai-act="cancel" ${busy ? "disabled" : ""}>ยกเลิก</button>
          </div>
        </div>`;
      overlay.setAttribute("aria-labelledby", "aiKeyDlgTitle");
      overlay.setAttribute("aria-describedby", "aiKeyDlgBody");
      wire();
      focus.focusSelector("#aiKeySecret");
    }

    function wire() {
      overlay.querySelector('[data-ai-act="cancel"]')?.addEventListener("click", () => {
        if (replaceMode && entryHasUsableKey(getActiveEntry())) {
          replaceMode = false;
          errorMsg = "";
          mode = "saved";
          paint();
          return;
        }
        finish({ action: "cancel" });
      });
      overlay.querySelector('[data-ai-act="replace"]')?.addEventListener("click", () => {
        replaceMode = true;
        errorMsg = "";
        mode = "empty";
        paint();
      });
      overlay.querySelector('[data-ai-act="delete"]')?.addEventListener("click", () => {
        mode = "delete";
        paint();
      });
      overlay.querySelector('[data-ai-act="cancel-del"]')?.addEventListener("click", () => {
        mode = "saved";
        paint();
      });
      overlay.querySelector('[data-ai-act="confirm-del"]')?.addEventListener("click", () => {
        void onDelete();
      });
      overlay.querySelector('[data-ai-act="save"]')?.addEventListener("click", () => {
        void onSave();
      });
      overlay.querySelector("#aiKeyProvider")?.addEventListener("change", () => {
        errorMsg = "";
        // re-paint hint link for provider docs
        const sel = /** @type {HTMLSelectElement | null} */ (
          overlay.querySelector("#aiKeyProvider")
        );
        const secret = /** @type {HTMLInputElement | null} */ (
          overlay.querySelector("#aiKeySecret")
        );
        const keep = secret?.value || "";
        paint();
        const nextSel = /** @type {HTMLSelectElement | null} */ (
          overlay.querySelector("#aiKeyProvider")
        );
        const nextSecret = /** @type {HTMLInputElement | null} */ (
          overlay.querySelector("#aiKeySecret")
        );
        if (nextSel && sel) nextSel.value = sel.value;
        if (nextSecret) nextSecret.value = keep;
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay && !busy) {
          if (mode === "delete") {
            mode = "saved";
            paint();
          } else finish({ action: "cancel" });
        }
      });
    }

    async function onSave() {
      if (busy) return;
      const providerEl = /** @type {HTMLSelectElement | null} */ (
        overlay.querySelector("#aiKeyProvider")
      );
      const secretEl = /** @type {HTMLInputElement | null} */ (
        overlay.querySelector("#aiKeySecret")
      );
      const provider = String(providerEl?.value || "google").trim() || "google";
      const apiKey = String(secretEl?.value || "").trim();
      if (!apiKey || apiKey.length < 8) {
        errorMsg =
          "คีย์นี้ใช้ไม่ได้ — ตรวจว่าคัดลอกครบ และเป็นคีย์ของ " +
          providerLabel(provider) +
          " จากนั้นลองอีกครั้ง";
        mode = "empty";
        paint();
        const again = /** @type {HTMLInputElement | null} */ (
          overlay.querySelector("#aiKeySecret")
        );
        if (again) again.value = apiKey;
        return;
      }

      busy = true;
      errorMsg = "";
      paint();
      const again = /** @type {HTMLInputElement | null} */ (
        overlay.querySelector("#aiKeySecret")
      );
      if (again) again.value = apiKey;

      const existing = getActiveEntry();
      const id = replaceMode && existing?.id ? existing.id : newEntryId();
      const label = providerLabel(provider);
      const model =
        providers.find((p) => p.id === provider)?.defaultModel || "";

      try {
        if (loggedIn) {
          const result = await upsertAiKeys({
            entry: { id, provider, label, model, apiKey },
          });
          // Wipe the input immediately — never leave plaintext in the DOM.
          if (again) again.value = "";
          if (!result.ok) {
            errorMsg = result.error.error || mapAiKeyError({ code: "AI_KEY_INVALID" });
            busy = false;
            mode = "empty";
            paint();
            return;
          }
          const masked =
            result.entries.find((e) => e.id === id) || result.entries[0];
          const vault = readVault();
          const next = {
            id: masked?.id || id,
            provider: masked?.provider || provider,
            label: masked?.label || label,
            model: masked?.model || model,
            apiKey: "",
            storeOnServer: true,
            hasKey: true,
            maskedKey: masked?.maskedKey || maskAiKeyLocal(apiKey),
            lastUsedAt: new Date().toISOString(),
          };
          const idx = vault.entries.findIndex((e) => e.id === next.id);
          if (idx >= 0) vault.entries[idx] = next;
          else vault.entries.push(next);
          vault.activeId = next.id;
          writeVault(vault);
        } else {
          // Local-only guest vault — keep plaintext for AI calls; never show it again.
          if (again) again.value = "";
          const vault = readVault();
          const next = {
            id,
            provider,
            label,
            model,
            apiKey,
            storeOnServer: false,
            hasKey: true,
            maskedKey: maskAiKeyLocal(apiKey),
            lastUsedAt: new Date().toISOString(),
          };
          if (replaceMode && existing?.id) {
            const idx = vault.entries.findIndex((e) => e.id === existing.id);
            if (idx >= 0) vault.entries[idx] = { ...next, id: existing.id };
            else vault.entries = [next];
            vault.activeId = existing.id;
          } else {
            vault.entries = [next];
            vault.activeId = next.id;
          }
          writeVault(vault);
        }
        busy = false;
        replaceMode = false;
        mode = "saved";
        opts.onBanner?.("บันทึกคีย์แล้ว", "success");
        paint();
        opts.onChange?.();
      } catch {
        if (again) again.value = "";
        errorMsg = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ขณะบันทึกคีย์";
        busy = false;
        mode = "empty";
        paint();
      }
    }

    async function onDelete() {
      if (busy) return;
      const entry = getActiveEntry();
      if (!entry) {
        mode = "empty";
        paint();
        return;
      }
      busy = true;
      paint();
      try {
        if (loggedIn && entry.storeOnServer) {
          const result = await deleteAiKey(entry.id);
          if (!result.ok && result.error.status !== 404) {
            busy = false;
            opts.onBanner?.(result.error.error, "error");
            mode = "saved";
            paint();
            return;
          }
        }
        const vault = readVault();
        vault.entries = vault.entries.filter((e) => e.id !== entry.id);
        if (vault.activeId === entry.id) {
          vault.activeId = vault.entries[0]?.id || null;
        }
        writeVault(vault);
        busy = false;
        showToast("ลบคีย์แล้ว — ฟังก์ชัน AI จะใช้ได้อีกเมื่อเพิ่มคีย์ใหม่");
        opts.onChange?.();
        // Keep dialog open so the empty state matches the header pill (F31).
        replaceMode = false;
        errorMsg = "";
        mode = entryHasUsableKey(getActiveEntry()) ? "saved" : "empty";
        paint();
      } catch {
        busy = false;
        opts.onBanner?.("ลบคีย์ไม่สำเร็จ", "error");
        mode = "saved";
        paint();
      }
    }

    document.body.appendChild(overlay);
    paint();
  });
}

/** @deprecated alias used by account / legacy call sites */
export async function openAiKeysDialog(opts = {}) {
  return openAiKeyDialog(opts);
}

export function installAiKeyDialogGlobal(opts = {}) {
  window.__openAiKeyDialog = (extra = {}) =>
    openAiKeyDialog({ ...opts, ...extra });
}
