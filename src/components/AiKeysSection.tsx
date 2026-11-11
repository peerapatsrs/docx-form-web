"use client";

import { useCallback, useEffect, useState } from "react";

type VaultEntry = {
  id: string;
  provider: string;
  label: string;
  model: string;
  storeOnServer?: boolean;
  maskedKey?: string;
};

type AiKeysModule = {
  openAiKeysDialog: (opts?: {
    onChange?: () => void;
    onBanner?: (msg: string, kind?: string) => void;
  }) => Promise<unknown>;
};

const VAULT_LS = "docx-form-web:aiVault:v1";

function readLocalVault(): VaultEntry[] {
  try {
    const raw = localStorage.getItem(VAULT_LS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { entries?: VaultEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function providerLabel(id: string): string {
  const map: Record<string, string> = {
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
  return map[id] || id || "AI";
}

/**
 * Account-page entry that opens the same public/ai-key-dialog.js manager
 * used by the home status pill — one shared dialog implementation.
 */
export function AiKeysSection() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [banner, setBanner] = useState("");
  const [busy, setBusy] = useState(false);
  const [mod, setMod] = useState<AiKeysModule | null>(null);

  const refresh = useCallback(() => {
    setEntries(readLocalVault());
  }, []);

  useEffect(() => {
    refresh();
    let cancelled = false;
    void (async () => {
      try {
        // Same public module the home shell imports (not part of the Next graph).
        const loaded = (await new Function(
          "return import('/ai-key-dialog.js')",
        )()) as AiKeysModule;
        if (!cancelled) setMod(loaded);
      } catch {
        if (!cancelled) setBanner("โหลดตัวจัดการคีย์ AI ไม่สำเร็จ");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function openManager() {
    if (!mod?.openAiKeysDialog) {
      setBanner("กำลังโหลดตัวจัดการคีย์… ลองอีกครั้งในสักครู่");
      return;
    }
    setBusy(true);
    setBanner("");
    try {
      await mod.openAiKeysDialog({
        onBanner: (msg) => setBanner(msg || ""),
        onChange: refresh,
      });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-panel" id="account-ai-keys">
      <div className="account-panel-head">
        <h2 className="auth-section-title">คีย์ AI</h2>
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          disabled={busy}
          onClick={() => void openManager()}
        >
          {busy ? "กำลังเปิด…" : "จัดการคีย์ AI"}
        </button>
      </div>
      <p className="auth-hint">
        คีย์ที่ซิงก์หรือเก็บในเบราว์เซอร์ — เปิด dialog เดียวกับปุ่มสถานะบนหน้าแรก
        (ไม่แสดงค่าคีย์)
      </p>
      {banner ? (
        <p className="auth-ok" role="status">
          {banner}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="auth-hint">ยังไม่มีคีย์ในเครื่องนี้</p>
      ) : (
        <ul className="account-row-list">
          {entries.map((e) => (
            <li key={e.id} className="account-row-item">
              <div className="account-row-meta">
                <strong>
                  {e.label || providerLabel(e.provider)}
                  {e.storeOnServer ? " · เซิร์ฟเวอร์" : " · เครื่องนี้"}
                </strong>
                <span className="auth-bar-muted">
                  {providerLabel(e.provider)} · {e.model || "—"} ·{" "}
                  {e.maskedKey || "••••"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
