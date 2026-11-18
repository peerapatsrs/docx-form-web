/**
 * Helpers for fill-form table cells that contain {{tags}} (static / non-loop tables).
 * Backend returns these as normal FormField entries; FE must not show raw {{…}} text.
 */

/**
 * @param {string} content
 * @returns {{ type: "text"|"open"|"close"|"self", value?: string, name?: string }[]}
 */
export function tokenizeTemplate(content) {
  const re = /\{\{(\/?#?[^}]*)\}\}/g;
  /** @type {{ type: string, value?: string, name?: string }[]} */
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(String(content || ""))) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", value: content.slice(last, m.index) });
    }
    const raw = m[1].trim();
    if (raw.startsWith("#")) {
      tokens.push({ type: "open", name: raw.slice(1).trim() });
    } else if (raw.startsWith("/")) {
      tokens.push({ type: "close", name: raw.slice(1).trim() });
    } else {
      tokens.push({ type: "self", name: raw });
    }
    last = m.index + m[0].length;
  }
  if (last < String(content || "").length) {
    tokens.push({ type: "text", value: String(content).slice(last) });
  }
  return tokens;
}

/**
 * Collect self-closed tag names from a cell / paragraph string.
 * @param {string} text
 * @returns {string[]}
 */
export function collectSelfTagsFromText(text) {
  /** @type {string[]} */
  const out = [];
  for (const t of tokenizeTemplate(text)) {
    if (t.type === "self" && t.name) out.push(t.name);
  }
  return out;
}

/**
 * Walk layout blocks (especially static table cells) for {{self}} tags.
 * @param {any[]} blocks
 * @returns {string[]}
 */
export function collectSelfTagsFromLayout(blocks) {
  /** @type {Set<string>} */
  const names = new Set();
  const take = (text) => {
    for (const n of collectSelfTagsFromText(text)) names.add(n);
  };
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") take(b.text);
    else if (b.type === "image") {
      if (b.fieldName) names.add(String(b.fieldName).trim());
      take(b.alt || "");
    } else if (b.type === "table") {
      for (const row of b.headerRows || []) {
        for (const c of row || []) take(typeof c === "string" ? c : c?.text || "");
      }
      for (const c of b.templateCells || []) {
        take(typeof c === "string" ? c : c?.text || "");
      }
      for (const row of b.trailingRows || []) {
        for (const c of row || []) take(typeof c === "string" ? c : c?.text || "");
      }
      for (const row of b.staticRows || []) {
        for (const c of row || []) take(typeof c === "string" ? c : c?.text || "");
      }
    }
  }
  return [...names];
}

/**
 * Optional Backend location metadata on a field (when present).
 * @param {any} field
 * @returns {{ tableIndex?: number, rowIndexInTable?: number, cellIndex?: number } | null}
 */
export function fieldTableLocation(field) {
  if (!field || typeof field !== "object") return null;
  const loc =
    field.location && typeof field.location === "object"
      ? field.location
      : field;
  const tableIndex = Number(loc.tableIndex ?? loc.table_index);
  const rowIndexInTable = Number(
    loc.rowIndexInTable ?? loc.row_index_in_table ?? loc.rowIndex,
  );
  const cellIndex = Number(loc.cellIndex ?? loc.cell_index ?? loc.tcIndex);
  const has =
    Number.isFinite(tableIndex) ||
    Number.isFinite(rowIndexInTable) ||
    Number.isFinite(cellIndex);
  if (!has) return null;
  /** @type {{ tableIndex?: number, rowIndexInTable?: number, cellIndex?: number }} */
  const out = {};
  if (Number.isFinite(tableIndex)) out.tableIndex = tableIndex;
  if (Number.isFinite(rowIndexInTable)) out.rowIndexInTable = rowIndexInTable;
  if (Number.isFinite(cellIndex)) out.cellIndex = cellIndex;
  return out;
}

/**
 * If Backend omitted a cell tag from `fields`, add a text field so the preview
 * still binds values / skip maps.
 * @param {any[]} fields
 * @param {string[]} tagNames
 * @returns {{ fields: any[], added: string[] }}
 */
export function mergeMissingTextFields(fields, tagNames) {
  const list = Array.isArray(fields) ? fields.slice() : [];
  /** @type {Set<string>} */
  const known = new Set();
  for (const f of list) {
    if (!f?.name) continue;
    known.add(String(f.name));
    for (const a of f.aliases || []) known.add(String(a));
  }
  /** @type {string[]} */
  const added = [];
  for (const raw of tagNames || []) {
    const name = String(raw || "").trim();
    if (!name || known.has(name)) continue;
    // Skip loop wrappers / bool-ish cores already covered by full tag names.
    if (name.startsWith("#") || name.startsWith("/")) continue;
    list.push({ name, type: "text" });
    known.add(name);
    added.push(name);
  }
  return { fields: list, added };
}

/**
 * Render cell text that may contain {{tags}} into HTML.
 * @param {string} cellText
 * @param {(name: string) => string} renderSelfTag
 * @param {(text: string) => string} formatPlain
 */
export function renderCellTemplateHtml(cellText, renderSelfTag, formatPlain) {
  const tokens = tokenizeTemplate(cellText || "");
  if (!tokens.length) return "";
  return tokens
    .map((t) => {
      if (t.type === "text") {
        const v = String(t.value || "");
        return v ? formatPlain(v) : "";
      }
      if (t.type === "self" && t.name) return renderSelfTag(t.name);
      return "";
    })
    .join("");
}

/** True when a static table is a simple label/value grid (good to stack on mobile). */
export function isStackableStaticTable(block) {
  if (!block || block.type !== "table") return false;
  if (!Array.isArray(block.staticRows) || !block.staticRows.length) return false;
  if (block.listName) return false;
  const cols = block.staticRows[0]?.length || 0;
  return cols > 0 && cols <= 2;
}
