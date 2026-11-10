/**
 * Shared AI keys manager dialog — used by the home shell (app.js) and /account.
 * One implementation: list / add / sync / delete-with-confirm. Never shows key values.
 */

const AI_VAULT_LS = "docx-form-web:aiVault:v1";
const FREE_MAX_AI_KEYS = 1;

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
    localStorage.setItem(AI_VAULT_LS, JSON.stringify(vault));
  } catch {
    /* private mode */
  }
}

function newEntryId() {
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function maskKey(key) {
  const k = String(key || "").trim();
  if (!k) return "••••";
  if (k.length <= 4) return "••••";
  return `••••…${k.slice(-4)}`;
}

function maskEntry(entry) {
  if (!entry) return "••••";
  if (entry.maskedKey) return String(entry.maskedKey);
  return maskKey(entry.apiKey);
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

async function fetchJson(url, init) {
  const res = await fetch(url, { credentials: "include", ...init });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function trapFocus(overlay) {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusables = () =>
    [
      ...overlay.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el instanceof HTMLElement);
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
  queueMicrotask(() => focusables()[0]?.focus());
  return () => {
    overlay.removeEventListener("keydown", onKey);
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}

function askConfirm({ title, body, confirmLabel = "ยืนยัน", abortLabel = "ยกเลิก" }) {
  return new Promise((resolve) => {
    const existing = document.getElementById("aiKeysConfirmDialog");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "aiKeysConfirmDialog";
    overlay.className = "dialog-overlay dialog-overlay-confirm";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="dialog-card">
        <h2 class="dialog-title">${escapeHtml(title)}</h2>
        <p class="dialog-body">${escapeHtml(body)}</p>
        <div class="dialog-actions dialog-actions-stack">
          <button type="button" class="btn-primary" data-confirm="ok">${escapeHtml(confirmLabel)}</button>
          <button type="button" class="btn-ghost" data-confirm="abort">${escapeHtml(abortLabel)}</button>
        </div>
      </div>`;
    const release = trapFocus(overlay);
    const finish = (ok) => {
      release();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    overlay.querySelector('[data-confirm="ok"]')?.addEventListener("click", () => finish(true));
    overlay.querySelector('[data-confirm="abort"]')?.addEventListener("click", () => finish(false));
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  });
}

async function pullServerKeys(loggedIn) {
  if (!loggedIn) return;
  const { res, data } = await fetchJson("/api/ai/keys");
  if (!res.ok) return;
  const remote = Array.isArray(data.entries) ? data.entries : [];
  if (!remote.length) return;
  const vault = readVault();
  const byId = new Map(vault.entries.map((e) => [e.id, e]));
  for (const r of remote) {
    if (!r?.id) continue;
    const existing = byId.get(String(r.id));
    byId.set(String(r.id), {
      id: String(r.id),
      provider: String(r.provider || existing?.provider || "google"),
      label: String(r.label || existing?.label || providerLabel(r.provider)),
      apiKey: existing?.apiKey || "",
      model: String(r.model || existing?.model || ""),
      storeOnServer: true,
      maskedKey:
        String(r.maskedKey || existing?.maskedKey || "") ||
        (r.hasKey ? "••••" : ""),
    });
  }
  vault.entries = [...byId.values()];
  if (!vault.activeId || !byId.has(vault.activeId)) {
    vault.activeId = vault.entries[0]?.id || null;
  }
  writeVault(vault);
}

async function pushServerKey(entry) {
  const { res } = await fetchJson("/api/ai/keys", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entry: {
        id: entry.id,
        provider: entry.provider,
        label: entry.label,
        model: entry.model,
        apiKey: entry.apiKey,
      },
    }),
  });
  return res.ok;
}

async function deleteServerKey(id) {
  const { res } = await fetchJson(`/api/ai/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return res.ok;
}

async function loadProviders() {
  const { res, data } = await fetchJson("/api/ai/providers");
  if (!res.ok) return [];
  return Array.isArray(data.providers) ? data.providers : [];
}

async function promptAddKey({ loggedIn, paid, onBanner }) {
  const providers = await loadProviders();
  const options = providers.length
    ? providers
    : [{ id: "google", label: "Google Gemini", defaultModel: "gemini-3.8-flash" }];

  const providerPick = await new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.id = "aiKeysAddProvider";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="dialog-card">
        <h2 class="dialog-title">เลือกผู้ให้บริการ AI</h2>
        <p class="dialog-body">คีย์เก็บในเบราว์เซอร์${loggedIn ? " — ติ๊กซิงก์ตอนใส่คีย์ได้" : ""}</p>
        <label class="dialog-field">
          <span>ผู้ให้บริการ</span>
          <select id="aiKeysProviderSelect" class="dialog-select">
            ${options
              .map(
                (p) =>
                  `<option value="${escapeAttr(p.id)}">${escapeHtml(p.label || p.id)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="dialog-field">
          <span>ชื่อที่แสดง</span>
          <input id="aiKeysLabelInput" class="dialog-input" maxlength="60" placeholder="เช่น งานราชการ" />
        </label>
        <div class="dialog-actions dialog-actions-stack">
          <button type="button" class="btn-primary" data-act="ok">ถัดไป</button>
          <button type="button" class="btn-ghost" data-act="abort">ยกเลิก</button>
        </div>
      </div>`;
    const release = trapFocus(overlay);
    const finish = (v) => {
      release();
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
      const provider =
        /** @type {HTMLSelectElement} */ (overlay.querySelector("#aiKeysProviderSelect"))
          ?.value || "google";
      const label =
        /** @type {HTMLInputElement} */ (overlay.querySelector("#aiKeysLabelInput"))
          ?.value || "";
      finish({ provider, label });
    });
    overlay.querySelector('[data-act="abort"]')?.addEventListener("click", () =>
      finish(null),
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
  });
  if (!providerPick) return false;

  const def = options.find((p) => p.id === providerPick.provider) || options[0];
  const keyPick = await new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.id = "aiKeysAddKey";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="dialog-card">
        <h2 class="dialog-title">API key · ${escapeHtml(def.label || def.id)}</h2>
        <p class="dialog-body">ไม่แสดงค่าคีย์หลังบันทึก — เก็บในเบราว์เซอร์${loggedIn ? " หรือซิงก์ขึ้นเซิร์ฟเวอร์" : ""}</p>
        <label class="dialog-field">
          <span>API key</span>
          <input id="aiKeysSecretInput" class="dialog-input" type="password" autocomplete="off" placeholder="${escapeAttr(def.keyPlaceholder || "…")}" />
        </label>
        ${
          loggedIn
            ? `<label class="dialog-check"><input type="checkbox" id="aiKeysSyncCheck" /> เก็บคีย์นี้บนเซิร์ฟเวอร์ (เข้ารหัส)</label>`
            : ""
        }
        <div class="dialog-actions dialog-actions-stack">
          <button type="button" class="btn-primary" data-act="ok">ดึงรายการโมเดล</button>
          <button type="button" class="btn-ghost" data-act="abort">ยกเลิก</button>
        </div>
      </div>`;
    const release = trapFocus(overlay);
    const finish = (v) => {
      release();
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
      const apiKey =
        /** @type {HTMLInputElement} */ (overlay.querySelector("#aiKeysSecretInput"))
          ?.value || "";
      const sync = loggedIn
        ? Boolean(
            /** @type {HTMLInputElement} */ (overlay.querySelector("#aiKeysSyncCheck"))
              ?.checked,
          )
        : false;
      finish({ apiKey: apiKey.trim(), sync });
    });
    overlay.querySelector('[data-act="abort"]')?.addEventListener("click", () =>
      finish(null),
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
  });
  if (!keyPick || !keyPick.apiKey) {
    onBanner?.("ยังไม่ได้ใส่ API key");
    return false;
  }

  onBanner?.("กำลังดึงรายการโมเดลจาก API…", "progress");
  const { res, data } = await fetchJson("/api/ai/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: providerPick.provider,
      apiKey: keyPick.apiKey,
    }),
  });
  const models = Array.isArray(data.models) && data.models.length
    ? data.models
    : def.models || [{ id: def.defaultModel || "gemini-3.8-flash", label: def.defaultModel || "default" }];
  const defaultModel = data.defaultModel || def.defaultModel || models[0]?.id || "";

  const modelPick = await new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.id = "aiKeysAddModel";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="dialog-card">
        <h2 class="dialog-title">เลือกโมเดล</h2>
        <p class="dialog-body">${escapeHtml(def.label || def.id)}${res.ok ? "" : " · ใช้รายการสำรอง"}</p>
        <label class="dialog-field">
          <span>โมเดล</span>
          <select id="aiKeysModelSelect" class="dialog-select">
            ${models
              .map(
                (m) =>
                  `<option value="${escapeAttr(m.id)}" ${m.id === defaultModel ? "selected" : ""}>${escapeHtml(m.label || m.id)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <div class="dialog-actions dialog-actions-stack">
          <button type="button" class="btn-primary" data-act="ok">บันทึกคีย์</button>
          <button type="button" class="btn-ghost" data-act="abort">ยกเลิก</button>
        </div>
      </div>`;
    const release = trapFocus(overlay);
    const finish = (v) => {
      release();
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
      const model =
        /** @type {HTMLSelectElement} */ (overlay.querySelector("#aiKeysModelSelect"))
          ?.value || defaultModel;
      finish(model);
    });
    overlay.querySelector('[data-act="abort"]')?.addEventListener("click", () =>
      finish(null),
    );
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });
    document.body.appendChild(overlay);
  });
  if (!modelPick) return false;

  const vault = readVault();
  if (!paid && vault.entries.length >= FREE_MAX_AI_KEYS) {
    onBanner?.(`แผนฟรีเก็บได้ ${FREE_MAX_AI_KEYS} คีย์`);
    return false;
  }

  const entry = {
    id: newEntryId(),
    provider: providerPick.provider,
    label:
      String(providerPick.label || "").trim() ||
      providerLabel(providerPick.provider),
    apiKey: keyPick.apiKey,
    model: modelPick,
    storeOnServer: false,
    maskedKey: maskKey(keyPick.apiKey),
  };
  if (keyPick.sync && loggedIn) {
    const ok = await pushServerKey(entry);
    if (ok) {
      entry.storeOnServer = true;
      entry.apiKey = "";
    } else {
      onBanner?.("บันทึกในเบราว์เซอร์แล้ว แต่ซิงก์ขึ้นเซิร์ฟเวอร์ไม่สำเร็จ");
    }
  }
  vault.entries.push(entry);
  vault.activeId = entry.id;
  writeVault(vault);
  onBanner?.(
    entry.storeOnServer
      ? `พร้อมใช้ · ${entry.label} · ${entry.model} · ซิงก์เซิร์ฟเวอร์แล้ว`
      : `พร้อมใช้ · ${entry.label} · ${entry.model}`,
    "success",
  );
  return true;
}

/**
 * Open the shared AI keys dialog.
 * @param {{ onChange?: () => void, onBanner?: (msg: string, kind?: string) => void }} [opts]
 */
export async function openAiKeysDialog(opts = {}) {
  const onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const onBanner =
    typeof opts.onBanner === "function" ? opts.onBanner : () => {};

  const me = await fetchJson("/api/me");
  const loggedIn = Boolean(me.res.ok && me.data?.user);
  const paid = Boolean(me.data?.premium?.paid);
  await pullServerKeys(loggedIn);

  const existing = document.getElementById("aiKeysManagerDialog");
  if (existing) existing.remove();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "aiKeysManagerDialog";
    overlay.className = "dialog-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "aiKeysDialogTitle");
    let releaseFocus = () => {};

    const renderList = () => {
      const vault = readVault();
      if (!vault.entries.length) {
        return `<p class="dialog-body">ยังไม่มีคีย์ — กด «เพิ่มคีย์» เพื่อเลือกผู้ให้บริการ</p>`;
      }
      return `<div class="ai-key-list" role="list">${vault.entries
        .map((e) => {
          const active = e.id === vault.activeId;
          const where = e.storeOnServer ? "เซิร์ฟเวอร์" : "เครื่องนี้";
          const syncBtn = loggedIn
            ? `<button type="button" class="btn-ghost btn-compact ai-key-sync" data-sync="${escapeAttr(e.id)}">${e.storeOnServer ? "เลิกซิงก์" : "ซิงก์"}</button>`
            : "";
          return `<label class="ai-key-row ${active ? "is-active" : ""}" role="listitem">
            <input type="radio" name="aiActiveKeyShared" value="${escapeAttr(e.id)}" ${active ? "checked" : ""} />
            <span class="ai-key-meta">
              <strong>${escapeHtml(e.label || providerLabel(e.provider))} <span class="ai-key-badge">${escapeHtml(where)}</span></strong>
              <small>${escapeHtml(providerLabel(e.provider))} · ${escapeHtml(e.model || "—")} · ${escapeHtml(maskEntry(e))}</small>
            </span>
            ${syncBtn}
            <button type="button" class="btn-ghost btn-compact ai-key-del" data-del="${escapeAttr(e.id)}" title="ลบคีย์นี้">ลบ</button>
          </label>`;
        })
        .join("")}</div>`;
    };

    const paint = () => {
      const vault = readVault();
      const allowAdd = paid || vault.entries.length < FREE_MAX_AI_KEYS;
      const quotaHint = paid
        ? "แผนจ่ายแล้ว · เพิ่มหลายคีย์ได้"
        : `แผนฟรีเก็บได้ ${FREE_MAX_AI_KEYS} คีย์`;
      const syncHint = loggedIn
        ? "ล็อกอินแล้ว · กด「ซิงก์」หรือติ๊กตอนเพิ่มคีย์เพื่อเก็บบนเซิร์ฟเวอร์"
        : "ยังไม่ล็อกอิน · คีย์อยู่แค่เครื่องนี้";
      overlay.innerHTML = `
        <div class="dialog-card dialog-card-wide">
          <h2 class="dialog-title" id="aiKeysDialogTitle">คีย์ AI ของคุณ</h2>
          <p class="dialog-body" id="aiKeysDialogBody">${escapeHtml(quotaHint)} · ${escapeHtml(syncHint)}</p>
          ${renderList()}
          <div class="dialog-actions dialog-actions-stack">
            <button type="button" class="btn-primary" data-ai-act="add">${allowAdd ? "เพิ่มคีย์" : "เพิ่มคีย์ (จ่ายแล้ว)"}</button>
            <button type="button" class="btn-secondary" data-ai-act="use" ${vault.entries.length ? "" : "disabled"}>ใช้คีย์ที่เลือก</button>
            <button type="button" class="btn-ghost" data-ai-act="close">ปิด</button>
          </div>
        </div>`;

      overlay.querySelector('[data-ai-act="close"]')?.addEventListener("click", () => {
        finish("close");
      });
      overlay.querySelector('[data-ai-act="add"]')?.addEventListener("click", () => {
        void (async () => {
          if (!allowAdd) {
            onBanner(`แผนฟรีเก็บได้ ${FREE_MAX_AI_KEYS} คีย์ — อัปเกรดเพื่อเพิ่ม`);
            return;
          }
          finish("add-open");
          const ok = await promptAddKey({ loggedIn, paid, onBanner });
          onChange();
          if (ok || readVault().entries.length) {
            await openAiKeysDialog(opts);
          }
          resolve("add");
        })();
      });
      overlay.querySelector('[data-ai-act="use"]')?.addEventListener("click", () => {
        const selected = /** @type {HTMLInputElement | null} */ (
          overlay.querySelector('input[name="aiActiveKeyShared"]:checked')
        );
        const vaultNow = readVault();
        if (selected?.value) {
          vaultNow.activeId = selected.value;
          writeVault(vaultNow);
          onChange();
          onBanner("ใช้คีย์ที่เลือกแล้ว", "success");
        }
        finish("use");
      });
      overlay.querySelectorAll("[data-sync]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void (async () => {
            const id = btn.getAttribute("data-sync");
            const vaultNow = readVault();
            const entry = vaultNow.entries.find((e) => e.id === id);
            if (!entry) return;
            if (entry.storeOnServer) {
              await deleteServerKey(entry.id);
              entry.storeOnServer = false;
              writeVault(vaultNow);
              onBanner(`เลิกซิงก์「${entry.label}」แล้ว`, "success");
            } else {
              if (!String(entry.apiKey || "").trim()) {
                onBanner("ไม่มีคีย์ในเครื่องให้ซิงก์ — ใส่คีย์ใหม่ก่อน");
                return;
              }
              const ok = await pushServerKey(entry);
              if (!ok) {
                onBanner("ซิงก์ขึ้นเซิร์ฟเวอร์ไม่สำเร็จ");
                return;
              }
              entry.storeOnServer = true;
              entry.maskedKey = maskKey(entry.apiKey);
              entry.apiKey = "";
              writeVault(vaultNow);
              onBanner(`ซิงก์「${entry.label}」ขึ้นเซิร์ฟเวอร์แล้ว`, "success");
            }
            onChange();
            paint();
          })();
        });
      });
      overlay.querySelectorAll("[data-del]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void (async () => {
            const id = btn.getAttribute("data-del");
            const vaultNow = readVault();
            const doomed = vaultNow.entries.find((e) => e.id === id);
            if (!doomed) return;
            const confirmed = await askConfirm({
              title: "ลบคีย์นี้?",
              body: `ลบ「${doomed.label || providerLabel(doomed.provider)}」แล้วกู้คืนไม่ได้ — คีย์อื่นยังอยู่ครบ`,
              confirmLabel: "ลบคีย์",
              abortLabel: "ยกเลิก",
            });
            if (!confirmed) return;
            const latest = readVault();
            const still = latest.entries.find((e) => e.id === id);
            if (!still) {
              paint();
              return;
            }
            if (still.storeOnServer) await deleteServerKey(id);
            latest.entries = latest.entries.filter((e) => e.id !== id);
            if (latest.activeId === id) {
              latest.activeId = latest.entries[0]?.id || null;
            }
            writeVault(latest);
            onChange();
            paint();
          })();
        });
      });
    };

    const finish = (value) => {
      releaseFocus();
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (value !== "add-open") resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (document.getElementById("aiKeysConfirmDialog")) return;
        finish("abort");
      }
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish("abort");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    paint();
    releaseFocus = trapFocus(overlay);
  });
}

/** Bind global opener for React pages (/account) and status-pill. */
export function installAiKeysDialogGlobal(opts = {}) {
  const w = window;
  w.DocxFormAiKeys = {
    open: () => openAiKeysDialog(opts),
  };
  return w.DocxFormAiKeys;
}
