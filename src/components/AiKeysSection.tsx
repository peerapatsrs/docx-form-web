"use client";

import { useEffect, useId, useState } from "react";
import {
  fetchAiKeySettingsState,
  putAiKeySettings,
  type AiKeySettingsMode,
  type AiKeySettingsState,
} from "@/lib/ai-key-settings-adapter";
import {
  aiKeySettingsCopy,
  mapAiKeySettingsError,
  modeDisplayLabel,
} from "@/components/ai-key-settings-copy";

const INITIAL: AiKeySettingsState = {
  mode: "server",
  serverKeyAvailable: false,
  userKeySet: false,
};

/**
 * Account-page AI key settings — server vs BYOK radio cards.
 * Uses src/lib/ai-key-settings-adapter.ts (never shows system key values).
 */
export function AiKeysSection() {
  const copy = aiKeySettingsCopy();
  const serverRadioId = useId();
  const byokRadioId = useId();
  const keyInputId = useId();

  const [state, setState] = useState<AiKeySettingsState>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");
  const [error, setError] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchAiKeySettingsState();
        if (cancelled) return;
        setState(next);
        setError("");
      } catch (err) {
        if (cancelled) return;
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: string }).code || "")
            : "";
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status?: number }).status || 0)
            : 0;
        setError(
          mapAiKeySettingsError(code, status) || copy.loadError,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [copy.loadError]);

  async function selectMode(mode: AiKeySettingsMode) {
    if (busy) return;
    if (mode === "server" && !state.serverKeyAvailable) {
      return;
    }
    setBusy(true);
    setError("");
    setBanner("");
    try {
      const res = await putAiKeySettings({ mode });
      if (!res.ok) {
        setError(mapAiKeySettingsError(res.code, res.status) || res.error);
        return;
      }
      setState(res.state);
      setReplacing(false);
      setDraftKey("");
      setShowKey(false);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveKey() {
    if (busy) return;
    setBusy(true);
    setError("");
    setBanner("");
    try {
      const res = await putAiKeySettings({
        apiKey: draftKey,
        provider: "google",
        label: "คีย์ของฉัน",
        model: "gemini-3.8-flash",
      });
      if (!res.ok) {
        setError(mapAiKeySettingsError(res.code, res.status) || res.error);
        return;
      }
      setState(res.state);
      setDraftKey("");
      setShowKey(false);
      setReplacing(false);
      setBanner(copy.savedHint);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteKey() {
    if (busy) return;
    if (!window.confirm(copy.deleteConfirm)) return;
    setBusy(true);
    setError("");
    setBanner("");
    try {
      const res = await putAiKeySettings({ deleteKey: true });
      if (!res.ok) {
        setError(mapAiKeySettingsError(res.code, res.status) || res.error);
        return;
      }
      setState(res.state);
      setDraftKey("");
      setReplacing(true);
    } finally {
      setBusy(false);
    }
  }

  const serverDisabled = !state.serverKeyAvailable;
  const showByokEditor =
    state.mode === "byok" && (!state.userKeySet || replacing);

  return (
    <section className="account-panel ai-key-settings" id="account-ai-keys">
      <div className="account-panel-head">
        <h2 className="auth-section-title">{copy.title}</h2>
      </div>

      <p className="ai-key-settings-active" role="status">
        <span className="ai-key-settings-active-badge">
          {copy.activeBadge(modeDisplayLabel(state.mode))}
        </span>
      </p>
      <p className="auth-hint ai-key-settings-privacy">{copy.neverShowSystem}</p>

      {loading ? (
        <p className="auth-hint" aria-busy="true">
          …
        </p>
      ) : (
        <div
          className="ai-key-settings-choices"
          role="radiogroup"
          aria-label={copy.title}
        >
          <label
            className={`ai-key-settings-card${state.mode === "server" ? " is-selected" : ""}${serverDisabled ? " is-disabled" : ""}`}
            htmlFor={serverRadioId}
          >
            <input
              id={serverRadioId}
              type="radio"
              name="ai-key-mode"
              value="server"
              checked={state.mode === "server"}
              disabled={busy || serverDisabled}
              onChange={() => void selectMode("server")}
            />
            <span className="ai-key-settings-card-body">
              <span className="ai-key-settings-card-title">{copy.modeServer}</span>
              <span className="ai-key-settings-card-sub">{copy.modeServerSub}</span>
              {serverDisabled ? (
                <span className="ai-key-settings-card-status is-warn">
                  {copy.modeServerUnavailable}
                </span>
              ) : (
                <span className="ai-key-settings-card-status is-ready">
                  {copy.modeServerReady}
                </span>
              )}
            </span>
          </label>

          <label
            className={`ai-key-settings-card${state.mode === "byok" ? " is-selected" : ""}`}
            htmlFor={byokRadioId}
          >
            <input
              id={byokRadioId}
              type="radio"
              name="ai-key-mode"
              value="byok"
              checked={state.mode === "byok"}
              disabled={busy}
              onChange={() => void selectMode("byok")}
            />
            <span className="ai-key-settings-card-body">
              <span className="ai-key-settings-card-title">{copy.modeByok}</span>
              <span className="ai-key-settings-card-sub">{copy.modeByokSub}</span>
            </span>
          </label>
        </div>
      )}

      {state.mode === "byok" ? (
        <div className="ai-key-settings-byok">
          {state.userKeySet && !replacing ? (
            <div className="ai-key-settings-saved">
              <p className="ai-key-settings-masked">
                <span className="ai-key-masked">{state.userKeyHint || "••••••••"}</span>
                <span className="auth-bar-muted"> · {copy.savedHint}</span>
              </p>
              <div className="ai-key-settings-saved-actions">
                <button
                  type="button"
                  className="admin-btn"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(true);
                    setDraftKey("");
                    setShowKey(false);
                  }}
                >
                  {copy.changeKey}
                </button>
                <button
                  type="button"
                  className="admin-btn admin-btn-danger"
                  disabled={busy}
                  onClick={() => void onDeleteKey()}
                >
                  {busy ? copy.deleting : copy.deleteKey}
                </button>
              </div>
            </div>
          ) : null}

          {showByokEditor ? (
            <div className="ai-key-settings-editor">
              <label className="ai-key-settings-field" htmlFor={keyInputId}>
                <span>{copy.keyLabel}</span>
                <span className="ai-key-settings-input-row">
                  <input
                    id={keyInputId}
                    className="admin-input"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={copy.keyPlaceholder}
                    value={draftKey}
                    disabled={busy}
                    onChange={(e) => setDraftKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="admin-btn ai-key-settings-toggle"
                    disabled={busy}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? copy.hideKey : copy.showKey}
                  </button>
                </span>
              </label>
              <div className="ai-key-settings-editor-actions">
                <button
                  type="button"
                  className="admin-btn admin-btn-primary"
                  disabled={busy || draftKey.trim().length < 8}
                  onClick={() => void onSaveKey()}
                >
                  {busy ? copy.saving : copy.saveKey}
                </button>
                {state.userKeySet ? (
                  <button
                    type="button"
                    className="admin-btn"
                    disabled={busy}
                    onClick={() => {
                      setReplacing(false);
                      setDraftKey("");
                      setShowKey(false);
                    }}
                  >
                    ยกเลิก
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {banner ? (
        <p className="auth-ok" role="status">
          {banner}
        </p>
      ) : null}
      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
