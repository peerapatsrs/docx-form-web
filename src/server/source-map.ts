import type { FormField, ListItemField } from "./docx-engine";
import { lookupCompatValue } from "./field-names";
import { detectKind, type ExtractedSource } from "./source-extract";

export type MapCandidate = {
  value: string | boolean;
  sourceFile: string;
  rule: string;
  confidence: number;
};

export type FieldProposal = {
  path: string;
  candidates: MapCandidate[];
  selectedIndex: number;
  /** When true, draft should skip this path */
  preferSkip?: boolean;
};

export type SourceMapResult = {
  proposals: FieldProposal[];
  values: Record<string, unknown>;
  skip: Record<string, boolean>;
  rowSkip: Record<string, Record<string, boolean>[]>;
  extracted: {
    filename: string;
    kind: string;
    charCount: number;
    warning?: string;
  }[];
};

export function extractedMeta(sources: ExtractedSource[]): SourceMapResult["extracted"] {
  return sources.map((s) => ({
    filename: s.filename,
    kind: s.kind,
    charCount: s.charCount,
    warning: s.warning,
  }));
}

/** Meta for AI path that sends original files (no local OCR / text extract). */
export function sourceFilesMeta(
  files: { filename: string; mimeType?: string; buffer: Buffer }[],
): SourceMapResult["extracted"] {
  return files.map((f) => {
    const kind = detectKind(f.filename, f.mimeType);
    let warning: string | undefined;
    if (kind === "docx") {
      warning = "ส่ง document.xml จากไฟล์ Word (Gemini ไม่รับ .docx โดยตรง)";
    } else if (kind === "unknown") {
      warning = "ชนิดไฟล์ไม่รองรับ";
    }
    return {
      filename: f.filename,
      kind,
      charCount: f.buffer?.length || 0,
      warning,
    };
  });
}

/** Group Gemini hits into FieldProposal[] (one proposal per path). */
export function proposalsFromHits(
  hits: Array<MapCandidate & { path: string }>,
): FieldProposal[] {
  const byPath = new Map<string, FieldProposal>();
  for (const hit of hits) {
    const { path, ...cand } = hit;
    let prop = byPath.get(path);
    if (!prop) {
      prop = { path, candidates: [], selectedIndex: 0, preferSkip: false };
      byPath.set(path, prop);
    }
    const dup = prop.candidates.find(
      (c) => String(c.value) === String(cand.value) && c.rule === cand.rule,
    );
    if (dup) {
      dup.confidence = Math.max(dup.confidence, cand.confidence);
      continue;
    }
    prop.candidates.push(cand);
    prop.candidates.sort((a, b) => b.confidence - a.confidence);
    prop.selectedIndex = 0;
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "th"));
}

const MISS_CAND: MapCandidate = {
  value: "(ไม่พบในเอกสาร)",
  sourceFile: "Google Gemini",
  rule: "gemini-miss",
  confidence: 0,
};

/**
 * Ensure every fillable template path has a proposal entry.
 * Missing paths get a skip-selected placeholder so the map panel lists them all.
 */
export function ensureCompleteProposals(
  fields: FormField[],
  proposals: FieldProposal[],
): FieldProposal[] {
  const byPath = new Map(proposals.map((p) => [p.path, p]));

  const ensure = (path: string, preferSkip = false) => {
    if (byPath.has(path)) return;
    const prop: FieldProposal = {
      path,
      candidates: [{ ...MISS_CAND }],
      selectedIndex: preferSkip ? -1 : 0,
      preferSkip,
    };
    byPath.set(path, prop);
  };

  for (const f of fields) {
    if (f.type === "auto" || f.type === "image") continue;
    if (f.type === "list") {
      const prefix = `${f.name}.`;
      const rowIdxs = new Set<number>();
      for (const p of byPath.keys()) {
        if (!p.startsWith(prefix)) continue;
        const m = /^\S+\.(\d+)\./.exec(p);
        if (m) rowIdxs.add(Number(m[1]));
      }
      // If Gemini found nothing for this list, still expose row 0 cells as skipped
      // so every item variable is visible and can be filled manually after apply.
      const rows = rowIdxs.size ? [...rowIdxs] : [0];
      for (const i of rows) {
        for (const item of f.itemFields) {
          if (item.type === "auto") continue;
          ensure(`${f.name}.${i}.${item.name}`, true);
        }
      }
      continue;
    }
    ensure(f.name, true);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path, "th"));
}

export function buildDraftFromProposals(
  fields: FormField[],
  proposals: FieldProposal[],
): Pick<SourceMapResult, "values" | "skip" | "rowSkip"> {
  const values: Record<string, unknown> = {};
  const skip: Record<string, boolean> = {};
  const rowSkip: Record<string, Record<string, boolean>[]> = {};
  const byPath = new Map(proposals.map((p) => [p.path, p]));

  const pick = (path: string): MapCandidate | null => {
    const p = byPath.get(path);
    if (!p || p.preferSkip || p.selectedIndex < 0 || !p.candidates.length) return null;
    return p.candidates[p.selectedIndex] || null;
  };

  for (const f of fields) {
    if (f.type === "auto" || f.type === "image") {
      skip[f.name] = f.type === "image";
      continue;
    }

    if (f.type === "list") {
      const prefix = `${f.name}.`;
      const rowIdxs = new Set<number>();
      for (const p of proposals) {
        if (!p.path.startsWith(prefix)) continue;
        const rest = p.path.slice(prefix.length);
        const m = /^(\d+)\./.exec(rest);
        if (m) rowIdxs.add(Number(m[1]));
      }
      const maxRow = rowIdxs.size ? Math.max(...rowIdxs) + 1 : 0;
      if (maxRow === 0) {
        skip[f.name] = true;
        values[f.name] = [];
        continue;
      }
      skip[f.name] = false;
      const rows: Record<string, unknown>[] = [];
      const rowSkipArr: Record<string, boolean>[] = [];
      for (let i = 0; i < maxRow; i += 1) {
        const row: Record<string, unknown> = {};
        const rs: Record<string, boolean> = {};
        for (const item of f.itemFields) {
          if (item.type === "auto") {
            row[item.name] = "";
            rs[item.name] = false;
            continue;
          }
          const cand = pick(`${f.name}.${i}.${item.name}`);
          if (!cand) {
            if (item.type === "bool") {
              rs[item.name] = false;
              row[item.name] = false;
            } else {
              rs[item.name] = true;
              row[item.name] = "";
            }
          } else {
            rs[item.name] = false;
            row[item.name] = cand.value;
          }
        }
        rows.push(row);
        rowSkipArr.push(rs);
      }
      values[f.name] = rows;
      rowSkip[f.name] = rowSkipArr;
      continue;
    }

    const cand = pick(f.name);
    if (!cand) {
      // Bool false is a real value — do not auto-skip (keeps control editable).
      if (f.type === "bool") {
        skip[f.name] = false;
        values[f.name] = false;
      } else {
        skip[f.name] = true;
        values[f.name] = "";
      }
    } else {
      skip[f.name] = false;
      values[f.name] = cand.value;
    }
  }

  return { values, skip, rowSkip };
}

/** Same envelope as browser Export JSON / Import JSON. */
export type DocxFormValuesJson = {
  format: "docx-form-values";
  version: 1;
  exportedAt: string;
  template: string;
  fields: { name: string; type: string }[];
  values: Record<string, unknown>;
  skip: Record<string, boolean>;
  rowSkip: Record<string, Record<string, boolean>[]>;
  images: Record<string, unknown>;
};

/**
 * True when a value carries real fill content.
 * Empty / blank / false / nullish containers do not count (nested-aware).
 */
export function isFilledValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value === true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => isFilledValue(item));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      isFilledValue(item),
    );
  }
  return false;
}

/** Count non-empty / non-all-skip values after an AI fill. */
export function countFilledValues(valuesJson: DocxFormValuesJson): {
  total: number;
  filled: number;
  skipped: number;
} {
  const values = (valuesJson?.values || {}) as Record<string, unknown>;
  const skip = (valuesJson?.skip || {}) as Record<string, boolean>;
  const keys = Object.keys(values);
  let filled = 0;
  let skipped = 0;
  for (const k of keys) {
    if (skip[k]) {
      skipped += 1;
      continue;
    }
    if (isFilledValue(values[k])) filled += 1;
    else skipped += 1;
  }
  return { total: keys.length, filled, skipped };
}

export function toDocxFormValuesJson(
  templateFilename: string,
  fields: FormField[],
  draft: Pick<SourceMapResult, "values" | "skip" | "rowSkip">,
): DocxFormValuesJson {
  return {
    format: "docx-form-values",
    version: 1,
    exportedAt: new Date().toISOString(),
    template: templateFilename || "",
    fields: fields.map((f) => ({ name: f.name, type: f.type })),
    values: draft.values,
    skip: draft.skip,
    rowSkip: draft.rowSkip,
    images: {},
  };
}

/**
 * Keep only keys from the skeleton; prefer AI values when present.
 * Ensures Import JSON always receives a valid docx-form-values envelope.
 * Skeleton must be built by the client at Export / send-to-AI time.
 */
export function mergeAiIntoValuesJson(
  skeleton: DocxFormValuesJson,
  aiRaw: Record<string, unknown> | null | undefined,
): DocxFormValuesJson {
  const base = {
    ...skeleton,
    exportedAt: new Date().toISOString(),
    images: {},
  };
  if (!aiRaw || typeof aiRaw !== "object") return base;

  const aiValues =
    aiRaw.values && typeof aiRaw.values === "object" && !Array.isArray(aiRaw.values)
      ? (aiRaw.values as Record<string, unknown>)
      : aiRaw;
  const aiSkip =
    aiRaw.skip && typeof aiRaw.skip === "object" && !Array.isArray(aiRaw.skip)
      ? (aiRaw.skip as Record<string, boolean>)
      : {};
  const aiRowSkip =
    aiRaw.rowSkip && typeof aiRaw.rowSkip === "object" && !Array.isArray(aiRaw.rowSkip)
      ? (aiRaw.rowSkip as Record<string, Record<string, boolean>[]>)
      : {};

  const values: Record<string, unknown> = { ...base.values };
  const skip: Record<string, boolean> = { ...base.skip };
  const rowSkip: Record<string, Record<string, boolean>[]> = {
    ...base.rowSkip,
  };

  for (const key of Object.keys(base.values)) {
    if (!Object.prototype.hasOwnProperty.call(aiValues, key)) continue;
    const v = aiValues[key];
    if (Array.isArray(base.values[key])) {
      values[key] = Array.isArray(v) ? v : base.values[key];
      const empty = !Array.isArray(v) || v.length === 0;
      skip[key] =
        Object.prototype.hasOwnProperty.call(aiSkip, key)
          ? !!aiSkip[key]
          : empty;
      if (Array.isArray(aiRowSkip[key])) rowSkip[key] = aiRowSkip[key];
    } else if (typeof base.values[key] === "boolean") {
      values[key] = !!v;
      skip[key] =
        Object.prototype.hasOwnProperty.call(aiSkip, key) ? !!aiSkip[key] : false;
    } else {
      const str = v == null ? "" : String(v);
      values[key] = str;
      skip[key] =
        Object.prototype.hasOwnProperty.call(aiSkip, key)
          ? !!aiSkip[key]
          : !str.trim();
    }
  }

  return {
    ...base,
    format: "docx-form-values",
    version: 1,
    values,
    skip,
    rowSkip,
    images: {},
  };
}

function writeAliased(
  out: Record<string, unknown>,
  field: { name: string; aliases?: string[] },
  value: unknown,
) {
  out[field.name] = value;
  for (const a of field.aliases || []) out[a] = value;
}

function compatBagValue(
  bag: Record<string, unknown> | null | undefined,
  name: string,
): unknown {
  return lookupCompatValue(bag, name).value;
}

function compatSkipFlag(
  skip: Record<string, boolean> | null | undefined,
  name: string,
): boolean {
  const hit = lookupCompatValue(
    skip as Record<string, unknown> | null | undefined,
    name,
  );
  return hit.hit ? !!hit.value : false;
}

function compatRowSkipFlag(
  rowSkip: Record<string, Record<string, boolean>[]> | null | undefined,
  listName: string,
  idx: number,
  itemName: string,
): boolean {
  const listHit = lookupCompatValue(
    rowSkip as Record<string, unknown> | null | undefined,
    listName,
  );
  const rows = Array.isArray(listHit.value) ? listHit.value : null;
  const row = rows?.[idx];
  if (!row || typeof row !== "object") return false;
  return compatSkipFlag(row as Record<string, boolean>, itemName);
}

/**
 * Convert draft values/skip into the payload shape expected by fillTemplate
 * (bool → trueText/falseText, auto row numbers, skipped → "" / [], nested lists).
 * Mirrors the browser buildValuesPayload(). Legacy NFKC value/skip keys resolve
 * onto current NFC field names via lookupCompatValue.
 */
export function toFillValues(
  fields: FormField[],
  values: Record<string, unknown>,
  skip: Record<string, boolean>,
  rowSkip: Record<string, Record<string, boolean>[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const fillItems = (
    itemFields: ListItemField[],
    row: Record<string, unknown> | undefined,
    idx: number,
    listName: string,
  ): Record<string, unknown> => {
    const rowOut: Record<string, unknown> = {};
    const rowBag = row && typeof row === "object" ? row : undefined;
    for (const item of itemFields) {
      if (item.type === "auto") {
        writeAliased(rowOut, item, String(idx + 1));
      } else if (item.type === "bool") {
        const on =
          !compatRowSkipFlag(rowSkip, listName, idx, item.name) &&
          !!compatBagValue(rowBag, item.name);
        writeAliased(rowOut, item, on ? item.trueText : item.falseText);
      } else if (item.type === "list") {
        if (
          compatSkipFlag(skip, item.name) ||
          compatRowSkipFlag(rowSkip, listName, idx, item.name)
        ) {
          writeAliased(rowOut, item, []);
          continue;
        }
        const nestedRaw = compatBagValue(rowBag, item.name);
        const nestedRows = Array.isArray(nestedRaw)
          ? (nestedRaw as Record<string, unknown>[])
          : [];
        writeAliased(
          rowOut,
          item,
          nestedRows.map((nr, nidx) =>
            fillItems(item.itemFields, nr, nidx, item.name),
          ),
        );
      } else {
        writeAliased(
          rowOut,
          item,
          compatRowSkipFlag(rowSkip, listName, idx, item.name)
            ? ""
            : String(compatBagValue(rowBag, item.name) ?? ""),
        );
      }
    }
    return rowOut;
  };

  for (const f of fields) {
    if (f.type === "text") {
      writeAliased(
        out,
        f,
        compatSkipFlag(skip, f.name)
          ? ""
          : String(compatBagValue(values, f.name) ?? ""),
      );
      continue;
    }
    if (f.type === "bool") {
      const on =
        !compatSkipFlag(skip, f.name) && !!compatBagValue(values, f.name);
      writeAliased(out, f, on ? f.trueText : f.falseText);
      continue;
    }
    if (f.type === "auto") {
      writeAliased(out, f, "1");
      continue;
    }
    if (f.type === "image") {
      writeAliased(out, f, "");
      continue;
    }
    if (f.type === "list") {
      if (compatSkipFlag(skip, f.name)) {
        writeAliased(out, f, []);
        continue;
      }
      const rawRows = compatBagValue(values, f.name);
      const rows = Array.isArray(rawRows)
        ? (rawRows as Record<string, unknown>[])
        : [];
      writeAliased(
        out,
        f,
        rows.map((row, idx) => fillItems(f.itemFields, row, idx, f.name)),
      );
    }
  }

  return out;
}
