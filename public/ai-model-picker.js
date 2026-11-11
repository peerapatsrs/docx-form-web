/**
 * Grouped AI model picker (system key vs own key).
 * Used by the askDialog select in the AI-fill / key model flow.
 * Never includes system key secret values.
 */

/**
 * @typedef {{ id: string, label: string, source?: 'server'|'byok' }} AiModelOption
 * @typedef {{
 *   id: 'server'|'byok',
 *   label: string,
 *   disabled?: boolean,
 *   reason?: string,
 *   options: AiModelOption[],
 * }} AiModelGroup
 */

/**
 * @param {{
 *   serverKeyAvailable?: boolean,
 *   serverKeyAvailabilityKnown?: boolean,
 *   userKeySet?: boolean,
 *   mode?: 'server'|'byok',
 *   serverModels?: AiModelOption[],
 *   byokModels?: AiModelOption[],
 *   models?: AiModelOption[],
 * }} input
 * @returns {AiModelGroup[]}
 */
export function buildAiModelGroups(input = {}) {
  const serverAvailable =
    typeof input.serverKeyAvailable === "boolean"
      ? input.serverKeyAvailable
      : true;
  const serverKnown = input.serverKeyAvailabilityKnown !== false;
  const userKeySet = !!input.userKeySet;

  /** Prefer explicit lists; else split models[] by source (default byok). */
  let serverModels = Array.isArray(input.serverModels) ? input.serverModels.slice() : [];
  let byokModels = Array.isArray(input.byokModels) ? input.byokModels.slice() : [];
  if (!serverModels.length && !byokModels.length && Array.isArray(input.models)) {
    for (const m of input.models) {
      if (!m?.id) continue;
      const src = m.source === "server" ? "server" : "byok";
      (src === "server" ? serverModels : byokModels).push({
        id: String(m.id),
        label: String(m.label || m.id),
        source: src,
      });
    }
  }

  const serverUnavailable = serverKnown && !serverAvailable;
  const serverEmpty = !serverUnavailable && serverModels.length === 0;
  const serverDisabled = serverUnavailable || serverEmpty;
  const byokNoKey = !userKeySet;
  const byokEmpty = userKeySet && byokModels.length === 0;
  const byokDisabled = byokNoKey || byokEmpty;

  return [
    {
      id: "server",
      label: "คีย์กลางของระบบ",
      disabled: serverDisabled,
      reason: serverUnavailable
        ? "ระบบยังไม่ได้ตั้งคีย์กลาง"
        : serverEmpty
          ? "ยังไม่มีโมเดลจากคีย์กลาง"
          : undefined,
      options: serverDisabled
        ? []
        : serverModels.map((m) => ({
            id: String(m.id),
            label: String(m.label || m.id),
            source: "server",
          })),
    },
    {
      id: "byok",
      label: "คีย์ของฉัน",
      disabled: byokDisabled,
      reason: byokNoKey
        ? "ยังไม่ได้บันทึกคีย์ของฉัน"
        : byokEmpty
          ? "ยังไม่มีโมเดลจากคีย์ของฉัน"
          : undefined,
      options: byokDisabled
        ? []
        : byokModels.map((m) => ({
            id: String(m.id),
            label: String(m.label || m.id),
            source: "byok",
          })),
    },
  ];
}

/**
 * @param {AiModelGroup[]} groups
 * @param {string} selectedId
 */
export function resolveModelSource(groups, selectedId) {
  const id = String(selectedId || "").trim();
  for (const g of groups || []) {
    if (g.options?.some((o) => o.id === id)) return g.id;
  }
  const enabled = (groups || []).find((g) => !g.disabled && g.options?.length);
  return enabled?.id || "server";
}

/**
 * @param {AiModelGroup[]} groups
 * @param {string} selectedId
 * @param {'th'|'en'} [locale]
 */
export function formatModelSourceBadge(groups, selectedId, locale = "th") {
  const source = resolveModelSource(groups, selectedId);
  const model =
    groups
      .flatMap((g) => g.options || [])
      .find((o) => o.id === selectedId)?.label || selectedId || "";
  if (locale === "en") {
    return source === "server"
      ? `Using system key · ${model}`
      : `Using my key · ${model}`;
  }
  return source === "server"
    ? `ใช้คีย์กลางของระบบ · ${model}`
    : `ใช้คีย์ของฉัน · ${model}`;
}

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

/**
 * Render grouped <select> + source badge HTML.
 * @param {{
 *   groups: AiModelGroup[],
 *   selectedId?: string,
 *   label?: string,
 *   selectId?: string,
 *   customInputId?: string,
 *   allowCustom?: boolean,
 *   locale?: 'th'|'en',
 * }} opts
 */
export function renderAiModelPickerHtml(opts) {
  const groups = Array.isArray(opts.groups) ? opts.groups : [];
  const allowCustom = opts.allowCustom !== false;
  const selectId = opts.selectId || "dialogSelect";
  const customInputId = opts.customInputId || `${selectId}Custom`;
  const customWrapId = `${customInputId}Wrap`;
  const selectedId = String(opts.selectedId || "").trim();
  const known = new Set(
    groups.flatMap((g) => (g.options || []).map((o) => o.id)),
  );
  const isCustom = allowCustom && selectedId && !known.has(selectedId);

  let firstEnabledId = "";
  const groupsHtml = groups
    .map((g) => {
      const disabled = !!g.disabled || !(g.options && g.options.length);
      const label = disabled && g.reason ? `${g.label} — ${g.reason}` : g.label;
      if (disabled) {
        return `<optgroup label="${escapeAttr(label)}"></optgroup>`;
      }
      const options = (g.options || [])
        .map((o) => {
          if (!firstEnabledId) firstEnabledId = o.id;
          const sel =
            !isCustom && o.id === (selectedId || firstEnabledId) ? "selected" : "";
          return `<option value="${escapeAttr(o.id)}" data-source="${escapeAttr(g.id)}" ${sel}>${escapeHtml(o.label)}</option>`;
        })
        .join("");
      return `<optgroup label="${escapeAttr(label)}">${options}</optgroup>`;
    })
    .join("");

  const effectiveId = isCustom
    ? selectedId
    : known.has(selectedId)
      ? selectedId
      : firstEnabledId;
  const badge = formatModelSourceBadge(groups, effectiveId, opts.locale || "th");
  const source = resolveModelSource(groups, effectiveId);
  const reasons = groups
    .filter((g) => g.disabled && g.reason)
    .map((g) => escapeHtml(g.reason || ""))
    .join(" · ");

  return `<div class="ai-model-picker" data-ai-model-picker="1">
    <p class="ai-model-picker-source" data-source="${escapeAttr(source)}" id="${escapeAttr(selectId)}Source" role="status">${escapeHtml(badge)}</p>
    <label class="dialog-input-label" for="${escapeAttr(selectId)}">${escapeHtml(opts.label || "โมเดล")}
      <select id="${escapeAttr(selectId)}" class="dialog-input dialog-select ai-model-picker-select">
        ${groupsHtml}
        ${allowCustom ? `<option value="__custom__" ${isCustom ? "selected" : ""}>อื่นๆ (พิมพ์เอง)…</option>` : ""}
      </select>
    </label>
    ${reasons ? `<p class="ai-model-picker-reason">${reasons}</p>` : ""}
    ${
      allowCustom
        ? `<label class="dialog-input-label" for="${escapeAttr(customInputId)}" id="${escapeAttr(customWrapId)}" ${isCustom ? "" : "hidden"}>
      รหัสโมเดล
      <input id="${escapeAttr(customInputId)}" class="dialog-input" type="text"
        placeholder="เช่น gemini-3.8-flash" autocomplete="off" spellcheck="false"
        value="${escapeAttr(isCustom ? selectedId : "")}" />
    </label>`
        : ""
    }
  </div>`;
}

/**
 * Keep the source badge in sync when the select changes.
 * @param {ParentNode} root
 * @param {AiModelGroup[]} groups
 * @param {{ selectId?: string, locale?: 'th'|'en' }} [opts]
 */
export function bindAiModelPicker(root, groups, opts = {}) {
  const selectId = opts.selectId || "dialogSelect";
  const customInputId = opts.customInputId || `${selectId}Custom`;
  const select = root.querySelector(`#${CSS.escape(selectId)}`);
  const badge = root.querySelector(`#${CSS.escape(selectId)}Source`);
  const customWrap = root.querySelector(`#${CSS.escape(customInputId)}Wrap`);
  const custom = root.querySelector(`#${CSS.escape(customInputId)}`);
  if (!(select instanceof HTMLSelectElement)) return () => {};

  const sync = () => {
    let id = select.value;
    if (id === "__custom__") {
      if (customWrap instanceof HTMLElement) customWrap.hidden = false;
      id = String(custom instanceof HTMLInputElement ? custom.value : "").trim();
    } else if (customWrap instanceof HTMLElement) {
      customWrap.hidden = true;
    }
    if (badge instanceof HTMLElement) {
      const source = resolveModelSource(groups, id === "__custom__" ? "" : id);
      badge.dataset.source = source;
      badge.textContent = formatModelSourceBadge(
        groups,
        id === "__custom__" ? id : id,
        opts.locale || "th",
      );
      if (select.value === "__custom__") {
        badge.textContent =
          (opts.locale || "th") === "en"
            ? "Using my key · custom model"
            : "ใช้คีย์ของฉัน · โมเดลกำหนดเอง";
        badge.dataset.source = "byok";
      }
    }
  };

  select.addEventListener("change", sync);
  if (custom instanceof HTMLInputElement) custom.addEventListener("input", sync);
  sync();
  return () => {
    select.removeEventListener("change", sync);
    if (custom instanceof HTMLInputElement) custom.removeEventListener("input", sync);
  };
}
