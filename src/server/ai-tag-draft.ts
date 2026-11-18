/**
 * AI-assisted draft of {{variable}} replacements for the template tagger.
 * Prefers sending the FULL document so the model decides fields itself:
 * - TAGGER_PLAIN + full word/document.xml (high safety caps only)
 * - Gemini: also attaches the original .docx package when size allows
 * - Optional heuristic hints (empty/sample cells, paragraph lists) are non-authoritative
 *
 * Kinds: text / bool / auto (replace or fill-empty-tc) and list / list-table (wrap / wrap-row).
 * Server validate/enrich still grounds suggestions to exact TAGGER_PLAIN spans.
 */

import {
  CONTACT_TAGGING_EXAMPLE,
  LABEL_VALUE_SPLIT_EXAMPLES,
} from "@/config/ai-tag-draft-prompt-examples";
import { getCursorApiKey, getGeminiApiKey, getGeminiModel } from "./ai-config";
import { callCursorAgentJson } from "./ai-cursor-agent";
import { formatProviderHttpError } from "./ai-http-errors";
import {
  assertFormAiSupported,
  getAiProvider,
  getAnthropicApiBase,
  getGeminiApiBase,
} from "./ai-providers";
import {
  AiTimeoutError,
  createAiTimeoutController,
  isAiTimeoutError,
  isRetryableAiError,
  logAiCall,
} from "./ai-request";
import { VAR_NAME_RE as NAME_RE } from "./field-names";
import {
  extractTaggerPlainText,
  listAllDataTableRows,
  listEmptyTableCellHints,
  listParagraphListHints,
  listPrototypeTableRowSpans,
  listSampleTableCellHints,
  tryPlainSpanOfTableRow,
  validateListCloseTag,
  validateListOpenTag,
  validateTag,
  type DataTableRowInfo,
  type ParagraphListHint,
  type PrototypeTableRowSpan,
  type TableEmptyCellHint,
  type TableSampleCellHint,
} from "./template-tagger";

export type AiTagDraftKind =
  | "text"
  | "bool"
  | "auto"
  | "list"
  | "list-table"
  | "delete-tr";

export type AiTagSuggestion = {
  plainText: string;
  occurrence: number;
  plainStart: number;
  name: string;
  kind: AiTagDraftKind;
  tag: string;
  mode: "replace" | "wrap" | "wrap-row" | "fill-empty-tc" | "delete-tr";
  closeTag?: string;
  trueText?: string;
  falseText?: string;
  /** 0-based <w:tc> index for fill-empty-tc. */
  cellIndex?: number;
  wrapTag?: string;
  wrapOccurrence?: number;
  tableIndex?: number;
  rowIndexInTable?: number;
  /** Column header that motivated an empty-cell suggestion (debug / UI). */
  headerHint?: string;
  /** Full <w:tr> plain span for list-table soft-occupy on the client. */
  rowPlainStart?: number;
  rowPlainEnd?: number;
  /** Nearby form label the model reported (used to anchor plain matching). */
  labelHint?: string;
};

/** Variable-name language for AI draft + enrichment. Product default: Thai. */
export type AiTagNameLanguage = "th" | "en";

export type AiTagDraftOpts = {
  provider?: string | null;
  apiKey?: string | null;
  model?: string | null;
  filename?: string | null;
  /** Prefer Thai (`ลำดับ`) or English snake_case (`defendant_no`) names. Default th. */
  nameLanguage?: AiTagNameLanguage | string | null;
  signal?: AbortSignal;
  /** Per-attempt processing budget (ms); defaults to DOCX_FORM_AI_TIMEOUT_MS. */
  timeoutMs?: number;
};

export function parseAiTagNameLanguage(raw: unknown): AiTagNameLanguage {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "en" || v === "english" || v === "eng" || v === "en-us") return "en";
  return "th";
}

const MAX_SUGGESTIONS = 80;
/** Extra slots reserved so letterhead phones/emails still enrich when AI fills the cap. */
const CONTACT_ENRICH_SLACK = 12;
const MAX_FIELD_PLAIN = 200;
const MAX_LIST_PLAIN = 1200;
/** Safety caps only — prefer sending the full document so the model decides. */
const XML_PROMPT_MAX = 800_000;
const PLAIN_PROMPT_MAX = 800_000;
/** Attach original .docx to Gemini when under this size (bytes). */
const DOCX_ATTACH_MAX_BYTES = 18 * 1024 * 1024;
/**
 * Separators Word may put between a form label and its value: tab, space, NBSP, etc.
 * Many Thai forms use a normal space (no <w:tab/>) e.g. 「มอบหมายให้ บริษัท…」.
 */
const PLAIN_SEP_CLASS = "[\\t \\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000]";
const PLAIN_SEP_RE = /[\t \u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/u;
const SAMPLE_MARKER_RE =
  /\s*[\(（]\s*(?:ตัวอย่าง|sample|example|demo)\s*[\)）]\s*$/iu;
/**
 * Contact-ish stems often glued flush to ANY value (digits OR text):
 * โทร + phone/office name · Tel + Latin token
 */
const GLUED_STEM_RE = /^(โทร\.?|tel\.?|t\.|แฟกซ์\.?|fax\.?)/iu;
const GLUED_STEM_LABELS = [
  "โทร",
  "โทร.",
  "Tel",
  "tel",
  "T.",
  "แฟกซ์",
  "Fax",
  "fax",
] as const;

type OccupiedSpan = {
  start: number;
  end: number;
  /** Wrap ranges allow nested replace fields fully inside; hard for other wraps. */
  soft?: boolean;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = (fenced ? fenced[1] : raw).trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(body.slice(start, end + 1));
  return null;
}

async function docxDocumentXml(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("ไฟล์ .docx ไม่มี word/document.xml");
  }
  return docFile.async("string");
}

function buildTag(
  kind: AiTagDraftKind,
  name: string,
  trueText: string,
  falseText: string,
): string {
  if (kind === "list" || kind === "list-table") return `{{#${name}}}`;
  if (kind === "bool") return `{{${name}?${trueText},${falseText}}}`;
  if (kind === "auto") return `{{+${name}}}`;
  return `{{${name}}}`;
}

function sanitizeName(raw: string): string {
  return String(raw || "")
    .normalize("NFC")
    .trim()
    .replace(/^#+/, "")
    .replace(/^\++/, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/[\\|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\w\u0E00-\u0E7F./-]/gu, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** ASCII-only sanitize for English variable names. */
function sanitizeNameAscii(raw: string): string {
  return String(raw || "")
    .normalize("NFC")
    .trim()
    .replace(/^#+/, "")
    .replace(/^\++/, "")
    .replace(/[\\|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_./-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .toLowerCase();
}

/**
 * English variable name from a label without a language keyword map:
 * prefer Latin tokens already in the label; otherwise a stable short hash
 * of the Unicode label so collisions stay deterministic.
 */
function englishNameFromLabel(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const latin = s.match(/[A-Za-z][A-Za-z0-9_]*/g);
  if (latin?.length) return sanitizeNameAscii(latin.join("_"));
  const ascii = sanitizeNameAscii(s);
  if (ascii && /[A-Za-z]/.test(ascii)) return ascii;
  // Stable non-keyword fallback from code points (no Thai→English dictionary).
  // Prefix `f_` (not `lbl_`) — lbl_* is rejected as unreadable by looksLikeGarbledName.
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return `f_${h.toString(36).slice(0, 8)}`;
}

function resolveVarName(raw: string, lang: AiTagNameLanguage): string {
  const normalized = String(raw || "");
  if (lang === "th") return sanitizeName(normalized);
  const ascii = sanitizeNameAscii(normalized);
  if (ascii && /[A-Za-z]/.test(ascii)) return ascii;
  // Thai-only labels under EN mode → stable ASCII hash (readable Thai kept for th).
  return englishNameFromLabel(normalized);
}

/**
 * Drop model/collision junk like `_2` / `_3` so uniqueness can be rebuilt from
 * nearby labels/headers instead of opaque numeric suffixes.
 */
export function stripJunkNumericSuffix(name: string): string {
  let s = String(name || "").normalize("NFC").trim();
  // Peel trailing _digits and single-letter junk (_2, _ก, _a) repeatedly.
  for (let i = 0; i < 6; i += 1) {
    const next = s
      .replace(/_+\d+$/u, "")
      .replace(/_+[a-zA-Z]$/u, "")
      .replace(/_+[ก-ฮ]$/u, "")
      .replace(/_+$/u, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Reject OCR/garbled identifiers: short repeated syllables, duplicated tokens,
 * or a token repeated inside a part (near-duplication).
 */
export function looksLikeGarbledName(name: string): boolean {
  const s = String(name || "").normalize("NFC").trim().replace(/^\++/, "");
  if (!s) return true;
  // Checkbox arm words / glyphs alone are never field names.
  if (/^[✓√✔☑☐□☒×✖]+$/u.test(s)) return true;
  if (/^(true|false|yes|no|on|off)$/i.test(s)) return true;
  // Stable hash fallback from englishNameFromLabel — not a readable field name.
  if (/^lbl_[a-z0-9]+$/i.test(s)) return true;
  // Structural: single grapheme particle (e.g. "ที่") is never a field id.
  const graphemeCount = (t: string) => {
    try {
      return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)]
        .length;
    } catch {
      return [...t].length;
    }
  };
  if (graphemeCount(s) <= 1 && !/[A-Za-z0-9]/.test(s)) return true;
  // Dotted / numeric structural suffixes (ราคา.2, จำเลยที่.1, foo.id) — not labels.
  if (/\.\d+$/u.test(s) || /\.[A-Za-z]{1,3}$/u.test(s)) return true;
  if (/\./u.test(s) && /\d/u.test(s)) return true;
  // Long full-header copies (joined multi-column captions).
  if (s.length > 24) return true;
  const parts = s.split(/[_/-]+/u).filter(Boolean);
  if (!parts.length) return true;
  if (parts.length >= 4) return true; // full-header join dumps
  // Low grapheme diversity dumps (ที่ทัที่_ที่ → few unique syllables).
  {
    const gs = (() => {
      try {
        return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(parts.join(""))].map(
          (x) => x.segment,
        );
      } catch {
        return [...parts.join("")];
      }
    })();
    if (gs.length >= 3 && new Set(gs).size <= 2) return true;
  }
  // Many tiny parts that are near-duplicates of each other.
  const short = parts.filter((p) => p.length <= 2);
  if (parts.length >= 3 && short.length >= parts.length - 1) return true;
  const joined = parts.join("");
  if (joined.length >= 4) {
    const uniq = new Set([...joined]);
    if (uniq.size <= 2) return true;
  }
  // Exact or near-duplicate tokens across parts (e.g. A_A_..., foo_foo).
  for (let i = 0; i < parts.length; i += 1) {
    const a = parts[i]!;
    // Cut off mid-word: trailing single letter/syllable junk.
    if (i === parts.length - 1 && a.length === 1 && !/^\d$/.test(a)) return true;
    for (let j = i + 1; j < parts.length; j += 1) {
      const b = parts[j]!;
      if (a === b && a.length >= 2) return true;
      // Near-duplicate tokens only when lengths are close (โทร vs โทรศัพท์ is OK
      // for label+model disambiguation; foo vs foofoo still catches OCR junk).
      if (a.length >= 3 && b.length >= 3) {
        const lo = Math.min(a.length, b.length);
        const hi = Math.max(a.length, b.length);
        if (lo >= hi * 0.7 && (a.includes(b) || b.includes(a))) return true;
      }
    }
    // Repeated chunk inside one token (bounded — no catastrophic backtracking).
    if (a.length >= 4 && a.length <= 48) {
      for (let n = 2; n <= Math.min(8, Math.floor(a.length / 2)); n += 1) {
        const chunk = a.slice(0, n);
        if (chunk && a.slice(n, n + n) === chunk) return true;
      }
    }
  }
  // Names that embed long digit runs are sample/amount copies, not labels.
  if (/\d{3,}/.test(s)) return true;
  return false;
}

/** True when a candidate variable name equals the source cell/value text. */
export function nameEqualsSourceValue(name: string, sourceValue: string): boolean {
  const n = String(name || "").normalize("NFC").trim();
  const v = String(sourceValue || "").normalize("NFC").trim();
  if (!n || !v) return false;
  if (n === v) return true;
  const nv = sanitizeName(v);
  const na = sanitizeNameAscii(v);
  return (!!nv && n === nv) || (!!na && n === na);
}

/** Fill-in values (amounts, names, ids) vs short captions used as demoted fields. */
export function looksLikeFillValue(plain: string): boolean {
  const t = String(plain || "").normalize("NFC").trim();
  if (!t) return false;
  if (t.length >= 16) return true;
  if (/\d/.test(t)) return true;
  if (/@/.test(t)) return true;
  if (/\s/.test(t) && t.length >= 8) return true;
  // CamelCase / mixed Latin sample tokens (e.g. AlphaWidget).
  if (/[A-Za-z]{3,}/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) return true;
  return false;
}

/**
 * Name from header/label only — never from cell/sample content.
 * Returns null when nothing usable remains.
 */
export function nameFromHeaderOrLabel(
  header: string | null | undefined,
  label: string | null | undefined,
  lang: AiTagNameLanguage,
  sourceValue?: string | null,
): string | null {
  const raw = String(header || "").trim() || String(label || "").trim();
  if (!raw) return null;
  const n = resolveVarName(raw, lang);
  if (!n || looksLikeGarbledName(n)) return null;
  if (sourceValue && nameEqualsSourceValue(n, sourceValue)) return null;
  return n;
}

/**
 * Prefer a richer label/header when the model name is empty, numeric-junked,
 * or only a short segment of a longer contextual name (generic — no denylist).
 */
export function preferContextualNameSource(
  modelName: string,
  label: string,
  extraContext: string[] = [],
): string {
  const cleanedModel = stripJunkNumericSuffix(String(modelName || "").trim());
  const labelTrim = String(label || "").trim();
  if (!cleanedModel) return labelTrim || extraContext.find((c) => String(c || "").trim()) || "";
  if (!labelTrim && !extraContext.length) return cleanedModel;

  const candidates = [labelTrim, ...extraContext.map((c) => String(c || "").trim())].filter(
    Boolean,
  );
  const norm = (s: string) =>
    s
      .normalize("NFC")
      .replace(/[\s/_-]+/gu, "")
      .toLowerCase();
  const modelNorm = norm(cleanedModel);
  // If any context string properly extends the model token, use the longest.
  let best = cleanedModel;
  for (const c of candidates) {
    const cNorm = norm(c);
    if (!cNorm) continue;
    if (
      c.length >= cleanedModel.length &&
      (c.includes(cleanedModel) ||
        cNorm.includes(modelNorm) ||
        // Model is a proper substring of context (not the reverse — avoids
        // short names like 「ชื่อ」stealing unrelated long context).
        (modelNorm.length >= 2 && cNorm.includes(modelNorm)))
    ) {
      if (c.length > best.length || (best === cleanedModel && cNorm !== modelNorm)) {
        best = c;
      }
    }
  }
  // Model name that is only a trailing/leading segment of a multi-part label.
  if (labelTrim) {
    const labelParts = labelTrim.split(/[\s/_-]+/u).filter(Boolean);
    if (
      labelParts.length >= 2 &&
      (labelParts.includes(cleanedModel) ||
        labelParts.some((p) => modelNorm.includes(norm(p)) && norm(p).length >= 2)) &&
      cleanedModel.length < labelTrim.length
    ) {
      return labelTrim;
    }
  }
  return best === cleanedModel ? cleanedModel : best;
}

/** Default unchecked glyph when the model omits falseText. */
export const DEFAULT_BOOL_FALSE_TEXT = "☐";
export const DEFAULT_BOOL_TRUE_TEXT = "√";

const CHECKED_ARM_RE = /^[√✓✔☑]$/u;
const UNCHECKED_ARM_RE = /^[☐□☒×✖]$/u;

export function normalizeBoolArms(
  trueRaw: unknown,
  falseRaw: unknown,
): { trueText: string; falseText: string } {
  let trueText = String(trueRaw ?? DEFAULT_BOOL_TRUE_TEXT).slice(0, 40);
  let falseText = String(falseRaw ?? "").slice(0, 40);
  // Model sometimes inverts arms (☐ as true, √ as false) — put checked first.
  if (
    UNCHECKED_ARM_RE.test(trueText.trim()) &&
    CHECKED_ARM_RE.test(falseText.trim())
  ) {
    const swap = trueText;
    trueText = falseText;
    falseText = swap;
  }
  if (!trueText.trim() || UNCHECKED_ARM_RE.test(trueText.trim())) {
    trueText = DEFAULT_BOOL_TRUE_TEXT;
  }
  // Empty false arm is the common defect that leaves √ visible when unchecked.
  if (!falseText.trim()) falseText = DEFAULT_BOOL_FALSE_TEXT;
  // If both arms somehow match, force a distinct unchecked glyph.
  if (falseText === trueText) falseText = DEFAULT_BOOL_FALSE_TEXT;
  return { trueText, falseText };
}

/**
 * True when column cell values across body rows form a short integer run
 * (1,2,3… or 0,1,2…). Detects numbering from the data itself — not from
 * caption keywords.
 */
export function columnLooksLikeRunSequence(
  rows: ReadonlyArray<{ cells: ReadonlyArray<{ text: string }> }>,
  cellIndex: number,
): boolean {
  if (cellIndex < 0 || !rows.length) return false;
  const nums: number[] = [];
  for (const row of rows) {
    const raw = String(row.cells[cellIndex]?.text ?? "").trim();
    if (!raw) continue;
    if (!/^\d{1,4}$/.test(raw)) return false;
    nums.push(Number(raw));
  }
  if (nums.length < 2) return false;
  const sorted = [...nums].sort((a, b) => a - b);
  // Must be unique consecutive integers (allow start at 0 or 1).
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] !== sorted[i - 1]! + 1) return false;
  }
  return sorted[0] === 0 || sorted[0] === 1;
}

/**
 * Detect run-sequence column indexes for a table from its body rows.
 */
export function detectRunSequenceColumns(
  rows: ReadonlyArray<{ cells: ReadonlyArray<{ text: string }> }>,
): Set<number> {
  const out = new Set<number>();
  if (!rows.length) return out;
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  for (let ci = 0; ci < width; ci += 1) {
    if (columnLooksLikeRunSequence(rows, ci)) out.add(ci);
  }
  return out;
}

/**
 * auto / {{+name}} only for real running numbers.
 * Prefer data-driven {@link isRunColumn} (sequential integers across rows).
 * Latin generic markers (#/No/seq) are weak signals only when column evidence
 * is unknown. Never key off language-specific caption words.
 */
export function looksLikeRunSequence(opts: {
  header?: string | null;
  cellIndex?: number | null;
  cellText?: string | null;
  /** True when this column's body values are sequential integers. */
  isRunColumn?: boolean | null;
}): boolean {
  const text = String(opts.cellText ?? "").trim();
  // Non-digit payloads (prices-as-text, labels) are never {{+}}.
  if (text && !/^\d{1,4}$/.test(text)) return false;
  if (opts.isRunColumn === true) return true;
  if (opts.isRunColumn === false) return false;
  // No caption-keyword shortcuts. When column evidence is unknown, only the
  // first short digit column is a weak structural fallback.
  if (
    typeof opts.cellIndex === "number" &&
    opts.cellIndex === 0 &&
    (!text || /^\d{1,3}$/.test(text))
  ) {
    return true;
  }
  return false;
}

function collectExistingTagRanges(plain: string): OccupiedSpan[] {
  const ranges: OccupiedSpan[] = [];
  const re = /\{\{[^{}]+\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function spanContains(outer: OccupiedSpan, innerStart: number, innerEnd: number): boolean {
  return innerStart >= outer.start && innerEnd <= outer.end;
}

function findOccurrenceStarts(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + Math.max(1, needle.length);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type PlainHit = {
  start: number;
  end: number;
  /** Index among hits from the strategy that produced this hit. */
  occurrence: number;
  matchedPlain: string;
};

/** Skip Word tab / space / NBSP runs between a label and its value. */
function skipPlainSeparators(haystack: string, from: number): number {
  let p = from;
  while (p < haystack.length && PLAIN_SEP_RE.test(haystack[p]!)) p += 1;
  return p;
}

/** Strip one layer of wrapping parentheses if the whole value is wrapped. */
function stripOuterParens(s: string): string {
  const t = String(s || "").trim();
  if (/^[\(（].+[\)）]$/u.test(t)) return t.slice(1, -1).trim();
  return t;
}

/**
 * Value variants to try when AI omits/includes 「(ตัวอย่าง)」 / parens / glued stems.
 * Body after a stem may be digits OR arbitrary text (ชื่อบริษัท, ที่อยู่, …).
 */
function valueMatchVariants(value: string): string[] {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const preferred: string[] = [];
  const rest: string[] = [];
  const add = (v: string, first = false) => {
    const t = String(v || "").trim();
    if (!t) return;
    if (preferred.includes(t) || rest.includes(t)) return;
    if (first) preferred.push(t);
    else rest.push(t);
  };
  add(raw);
  add(raw.replace(SAMPLE_MARKER_RE, ""));
  add(raw.replace(/\s+/g, " "));

  const noParen = stripOuterParens(raw);
  add(noParen);
  add(noParen.replace(SAMPLE_MARKER_RE, ""));

  // โทร02-… / โทรสำนักงานใหญ่ / (TelACME) → prefer the value body (any text).
  for (const base of [raw, noParen]) {
    const m = GLUED_STEM_RE.exec(base);
    if (!m) continue;
    const body = base
      .slice(m[0].length)
      .replace(new RegExp(`^${PLAIN_SEP_CLASS}*`, "u"), "");
    if (body) add(body, true);
  }
  return [...preferred, ...rest];
}

/**
 * When the model forgets label but plainText still starts with โทร/Tel/แฟกซ์,
 * also try those stems so the VALUE (digits or text) can be located flush after them.
 */
function implicitGluedStemLabels(value: string, explicitLabel: string): string[] {
  if (String(explicitLabel || "").trim()) return [];
  const variants = valueMatchVariants(value);
  if (!variants.some((v) => GLUED_STEM_RE.test(v))) return [];
  return [...GLUED_STEM_LABELS];
}

/**
 * Find value spans that sit immediately after a label (+ tabs/spaces/NBSP, or flush).
 * Handles both: ประเภทหนี้\\t\\tกู้ยืม  and  มอบหมายให้ บริษัท กฎหมาย…
 */
function findLabelAnchoredValueHits(
  haystack: string,
  label: string,
  value: string,
): PlainHit[] {
  const lab = String(label || "").trim();
  const variants = valueMatchVariants(value);
  if (!lab || !variants.length || !haystack) return [];
  const labelStarts = findOccurrenceStarts(haystack, lab);
  const out: PlainHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < labelStarts.length; i += 1) {
    const afterLabel = skipPlainSeparators(
      haystack,
      labelStarts[i]! + lab.length,
    );
    for (const val of variants) {
      if (!haystack.startsWith(val, afterLabel)) continue;
      if (!plainDigitMatchAllowed(haystack, afterLabel, val)) continue;
      const end = afterLabel + val.length;
      const key = `${afterLabel}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ start: afterLabel, end, occurrence: i, matchedPlain: val });
      break; // prefer first (longest-ish) variant that fits this label hit
    }
  }
  return out;
}

/**
 * Match a multi-token needle where AI used spaces but the doc uses tabs (or vice versa).
 * Returns the exact document slice for each hit.
 */
function findFlexibleSeparatorHits(haystack: string, needle: string): PlainHit[] {
  const parts = String(needle || "")
    .trim()
    .split(new RegExp(`${PLAIN_SEP_CLASS}+`, "u"))
    .filter(Boolean);
  if (parts.length <= 1) return [];
  const re = new RegExp(
    parts.map(escapeRegExp).join(`${PLAIN_SEP_CLASS}+`),
    "gu",
  );
  const out: PlainHit[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(haystack)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    out.push({
      start,
      end,
      occurrence: i,
      matchedPlain: haystack.slice(start, end),
    });
    i += 1;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/**
 * Peel "Label\\tValue" / "Label Value" / "LabelValue" / "(LabelValue)" into value-only.
 */
function peelValueFromLabeledPlain(plain: string, label: string): string {
  const lab = String(label || "").trim();
  const raw = String(plain || "").trim();
  if (!lab || !raw) return raw;
  const tryPeel = (s: string): string | null => {
    if (!s.startsWith(lab)) return null;
    const rest = s
      .slice(lab.length)
      .replace(new RegExp(`^${PLAIN_SEP_CLASS}+`, "u"), "");
    return rest || null;
  };
  const direct = tryPeel(raw);
  if (direct) return direct;
  const inner = tryPeel(stripOuterParens(raw));
  if (inner) return inner;
  return raw;
}

/**
 * Resolve where a field suggestion lands in TAGGER_PLAIN.
 * Prefer label-anchored value hits (tab / space / flush), then exact, then flexible separators.
 */
function resolveFieldPlainHits(
  docPlain: string,
  plainRaw: string,
  labelRaw: string,
  preferredOcc: unknown,
): PlainHit[] {
  const label = String(labelRaw || "").trim();
  let value = String(plainRaw || "").trim();
  if (!value || !docPlain) return [];
  if (label) value = peelValueFromLabeledPlain(value, label);
  const variants = valueMatchVariants(value);
  if (!variants.length) return [];
  const stemLabels = label
    ? [label]
    : implicitGluedStemLabels(value, label);

  const byKey = new Map<string, PlainHit>();
  const addAll = (hits: PlainHit[]) => {
    for (const h of hits) {
      const key = `${h.start}:${h.end}`;
      if (!byKey.has(key)) byKey.set(key, h);
    }
  };

  for (const v of variants) {
    for (const stem of stemLabels) {
      addAll(findLabelAnchoredValueHits(docPlain, stem, v));
      addAll(findFlexibleSeparatorHits(docPlain, `${stem} ${v}`));
      addAll(findFlexibleSeparatorHits(docPlain, `${stem}\t${v}`));
      // Flush / no separator: stem+value as one contiguous needle → value span only.
      addAll(
        findOccurrenceStarts(docPlain, `${stem}${v}`).map((start, occurrence) => ({
          start: start + stem.length,
          end: start + stem.length + v.length,
          occurrence,
          matchedPlain: v,
        })),
      );
    }
    // Avoid exact-matching "โทร02-…" / "โทรสำนักงาน…" when a peeled body variant exists —
    // tag the value body only (digits OR text), keep stem in label.
    const gluedWithBody =
      GLUED_STEM_RE.test(v) &&
      variants.some((x) => x !== v && v.endsWith(x) && x.length > 0);
    // "-" / punctuation must NEVER exact-scan the whole doc (shatters phone numbers).
    const weakSep = /^[\-–—_.…·•/|,;:]+$/u.test(v);
    // Short digits: prefer label/stem anchors; if none, keep only the preferred occurrence.
    const shortDigit = /^\d{1,2}$/.test(v);
    if (gluedWithBody || weakSep) continue;
    if (shortDigit) {
      if (!(label || stemLabels.length)) {
        const exactStarts = findOccurrenceStarts(docPlain, v);
        const preferred = Number(preferredOcc ?? 0);
        const pick =
          Number.isFinite(preferred) &&
          preferred >= 0 &&
          preferred < exactStarts.length
            ? preferred
            : 0;
        const start = exactStarts[pick];
        if (start != null) {
          addAll([
            {
              start,
              end: start + v.length,
              occurrence: pick,
              matchedPlain: v,
            },
          ]);
        }
      }
      continue;
    }
    const exactStarts = findOccurrenceStarts(docPlain, v);
    addAll(
      exactStarts.map((start, occurrence) => ({
        start,
        end: start + v.length,
        occurrence,
        matchedPlain: v,
      })),
    );
  }
  addAll(findFlexibleSeparatorHits(docPlain, plainRaw));

  // Prefer the primary peeled value when shrinking label+value flexible hits.
  const primaryValue = variants[0]!;

  // When a flexible hit covered label+value, shrink to the value suffix if possible.
  const shrinkStem = stemLabels[0] || label;
  const shrunk: PlainHit[] = [];
  for (const h of byKey.values()) {
    if (
      shrinkStem &&
      h.matchedPlain !== primaryValue &&
      variants.some((v) => h.matchedPlain.includes(v))
    ) {
      const local = findLabelAnchoredValueHits(
        docPlain.slice(h.start, h.end),
        shrinkStem,
        primaryValue,
      );
      if (local.length) {
        const loc = local[0]!;
        shrunk.push({
          start: h.start + loc.start,
          end: h.start + loc.end,
          occurrence: h.occurrence,
          matchedPlain: loc.matchedPlain,
        });
        continue;
      }
      let shrunkHit: PlainHit | null = null;
      for (const v of variants) {
        const vAt = docPlain.lastIndexOf(v, h.end - 1);
        if (vAt >= h.start && vAt + v.length <= h.end) {
          shrunkHit = {
            start: vAt,
            end: vAt + v.length,
            occurrence: h.occurrence,
            matchedPlain: v,
          };
          break;
        }
      }
      if (shrunkHit) {
        shrunk.push(shrunkHit);
        continue;
      }
    }
    shrunk.push(h);
  }

  const uniq = new Map<string, PlainHit>();
  for (const h of shrunk) {
    const key = `${h.start}:${h.end}`;
    if (!uniq.has(key)) uniq.set(key, h);
  }
  const hits = [...uniq.values()].sort((a, b) => a.start - b.start);
  const preferred = Number(preferredOcc ?? 0);
  if (!Number.isFinite(preferred) || preferred < 0 || hits.length <= 1) {
    return hits;
  }
  // Re-order so preferred occurrence (among label-anchored / exact) is tried first.
  const order: PlainHit[] = [];
  if (preferred < hits.length) order.push(hits[preferred]!);
  for (const h of hits) {
    if (!order.includes(h)) order.push(h);
  }
  return order;
}

/**
 * Claim a unique variable name. Never invent `_2` / `_3` / `_ก` / `_a`
 * disambiguators — prefer contextual suffixes from labels/headers.
 * Never reuse a reserved loop/wrap name for a scalar field.
 * If no contextual candidate is free, drop the suggestion (return null).
 */
function uniqueName(
  base: string,
  usedNames: Set<string>,
  contextParts: string[] = [],
  lang: AiTagNameLanguage = "th",
  reservedLoopNames: ReadonlySet<string> = new Set(),
): string | null {
  const cleaned = stripJunkNumericSuffix(base);
  if (!cleaned || !NAME_RE.test(cleaned) || looksLikeGarbledName(cleaned)) return null;
  const blocked = (n: string) =>
    usedNames.has(n) || reservedLoopNames.has(n) || looksLikeGarbledName(n);
  if (!blocked(cleaned)) return cleaned;

  const ctxNames: string[] = [];
  for (const raw of contextParts) {
    // Never treat sample/fill values as naming context.
    if (looksLikeFillValue(String(raw || ""))) continue;
    const n = resolveVarName(String(raw || ""), lang);
    if (!n || n === cleaned || looksLikeGarbledName(n)) continue;
    // Reserved loop names are fine as JOIN suffixes (ชื่อ_จำเลยที่) — blocked()
    // still refuses them as the final bare name.
    if (!ctxNames.includes(n)) ctxNames.push(n);
  }
  const candidates: string[] = [];
  for (const ctx of ctxNames) {
    const last = ctx.split(/[_/-]/u).filter(Boolean).pop() || ctx;
    // Do not offer bare `ctx` alone — that reuses another field/loop's name.
    for (const cand of [`${cleaned}_${ctx}`, `${ctx}_${cleaned}`, `${cleaned}_${last}`]) {
      const s = (lang === "en" ? sanitizeNameAscii(cand) : sanitizeName(cand)).slice(0, 40);
      if (s && NAME_RE.test(s) && !candidates.includes(s) && !looksLikeGarbledName(s)) {
        candidates.push(s);
      }
    }
  }
  for (const cand of candidates) {
    if (!blocked(cand)) return cand;
  }
  // No opaque letter/digit suffixes — skip rather than invent junk.
  return null;
}

function parseKind(raw: unknown): AiTagDraftKind | null {
  let kindRaw = String(raw ?? "text")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (kindRaw === "checkbox" || kindRaw === "boolean") kindRaw = "bool";
  if (kindRaw === "number" || kindRaw === "run" || kindRaw === "runno") kindRaw = "auto";
  if (
    kindRaw === "list-para" ||
    kindRaw === "list-paragraph" ||
    kindRaw === "paragraph-list" ||
    kindRaw === "wrap"
  ) {
    kindRaw = "list";
  }
  if (
    kindRaw === "table-list" ||
    kindRaw === "listtable" ||
    kindRaw === "row-list" ||
    kindRaw === "wrap-row"
  ) {
    kindRaw = "list-table";
  }
  if (
    kindRaw === "text" ||
    kindRaw === "bool" ||
    kindRaw === "auto" ||
    kindRaw === "list" ||
    kindRaw === "list-table"
  ) {
    return kindRaw;
  }
  return null;
}

function isListKind(kind: AiTagDraftKind): boolean {
  return kind === "list" || kind === "list-table";
}

function formatEmptyCellHintsForPrompt(hints: TableEmptyCellHint[]): string {
  if (!hints.length) return "(none)";
  const lines = hints.slice(0, 24).map((h) => {
    const anchor =
      h.rowAnchor.length > 48 ? `${h.rowAnchor.slice(0, 48)}…` : h.rowAnchor;
    return `- plainText:${JSON.stringify(anchor)} occurrence:${h.occurrence} cellIndex:${h.cellIndex} header:${JSON.stringify(h.header)} tableIndex:${h.tableIndex} rowIndexInTable:${h.rowIndexInTable}`;
  });
  return lines.join("\n");
}

function formatSampleCellHintsForPrompt(hints: TableSampleCellHint[]): string {
  if (!hints.length) return "(none)";
  const lines = hints.slice(0, 32).map((h) => {
    const anchor =
      h.rowAnchor.length > 48 ? `${h.rowAnchor.slice(0, 48)}…` : h.rowAnchor;
    const sample =
      h.cellText.length > 40 ? `${h.cellText.slice(0, 40)}…` : h.cellText;
    return `- cellText:${JSON.stringify(sample)} plainText:${JSON.stringify(sample)} occurrence:row cellIndex:${h.cellIndex} header:${JSON.stringify(h.header)} rowAnchor:${JSON.stringify(anchor)} tableIndex:${h.tableIndex} rowIndexInTable:${h.rowIndexInTable}`;
  });
  return lines.join("\n");
}

function formatParagraphListHintsForPrompt(hints: ParagraphListHint[]): string {
  if (!hints.length) return "(none)";
  const lines = hints.slice(0, 12).map((h) => {
    const sample =
      h.plainText.length > 120 ? `${h.plainText.slice(0, 120)}…` : h.plainText;
    return `- stem:${JSON.stringify(h.stem)} unitCount:${h.unitCount} suggestedNameTh:${JSON.stringify(h.suggestedNameTh)} suggestedNameEn:${JSON.stringify(h.suggestedNameEn)} plainText:${JSON.stringify(sample)} (FIRST unit only — wrap this exact span; do NOT wrap/tag units 2…${h.unitCount})`;
  });
  return lines.join("\n");
}

function nameLanguagePromptRule(lang: AiTagNameLanguage): string {
  if (lang === "en") {
    return `- name (REQUIRED language: English snake_case): ASCII letters, digits, underscore, dot, hyphen only — NO Thai characters.
  Derive snake_case from the nearby label/role in THIS document (no canned example names).
  Prefer short descriptive English identifiers grounded in the nearby label.
  Never use numeric/letter collision suffixes (_2/_3/_a). Never emit bare generics when a label/role is available.`;
  }
  return `- name (REQUIRED language: Thai identifiers preferred): Thai and/or Latin letters, digits, underscore, dot, hyphen only (no spaces).
  Derive names from the nearby label/role in THIS document (no canned example names).
  Prefer short descriptive names grounded in the nearby label/role.
  Never use numeric/letter collision suffixes (_2/_3/_ก). Never emit bare one-token names when the caption gives more context.`;
}

function buildSuggestPrompt(opts: {
  filename: string;
  plainText: string;
  xmlSnippet: string;
  includeXmlInline: boolean;
  emptyCellHints: TableEmptyCellHint[];
  sampleCellHints: TableSampleCellHint[];
  paragraphListHints: ParagraphListHint[];
  nameLanguage: AiTagNameLanguage;
  plainTruncated?: boolean;
  xmlTruncated?: boolean;
  docxAttached?: boolean;
}): string {
  const plain = opts.plainText.slice(0, PLAIN_PROMPT_MAX);
  const xmlNote = opts.includeXmlInline
    ? [
        "SOURCE ATTACHMENTS (read these — they are the real Word file contents):",
        opts.docxAttached
          ? `- The original .docx package is attached (${opts.filename}).`
          : null,
        "- word/document.xml is attached as XML (full OOXML body).",
        "Use attachments + TAGGER_PLAIN together; prefer the document over any heuristic hints.",
      ]
        .filter(Boolean)
        .join("\n")
    : `Word document.xml (FULL body structure${opts.xmlTruncated ? " — truncated only because of size safety cap" : ""}):\n${opts.xmlSnippet}`;
  const emptyBlock = formatEmptyCellHintsForPrompt(opts.emptyCellHints);
  const sampleBlock = formatSampleCellHintsForPrompt(opts.sampleCellHints);
  const paraListBlock = formatParagraphListHintsForPrompt(opts.paragraphListHints);
  const nameExample =
    opts.nameLanguage === "en"
      ? '{"plainText":"1","name":"seq","kind":"auto","mode":"replace"}'
      : '{"plainText":"1","name":"seq","kind":"auto","mode":"replace"}';
  const listNameExample =
    opts.nameLanguage === "en" ? "row_group" : "กลุ่มแถว";
  const outsideDigitExample =
    opts.nameLanguage === "en"
      ? '{"plainText":"1","name":"code","kind":"text","mode":"replace"}'
      : '{"plainText":"1","name":"รหัส","kind":"text","mode":"replace"}';
  const truncNotes = [
    opts.plainTruncated
      ? `TAGGER_PLAIN was truncated to ${PLAIN_PROMPT_MAX} chars (safety cap).`
      : null,
    opts.xmlTruncated && !opts.includeXmlInline
      ? `document.xml in this prompt was truncated to ${XML_PROMPT_MAX} chars (safety cap).`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return `You draft Word form placeholders for a Thai/English .docx template.

DETERMINISM (required): treat this as temperature 0. Same document MUST yield the same suggestions. Be complete — cover letterhead/header fill-ins, case/document numbers, party blocks, table prototype cells (every non-empty cell + meaningful blanks), totals on distinct rows, and label-followed values. Do not under-suggest.

You receive the FULL document (TAGGER_PLAIN + document.xml${opts.docxAttached ? " + original .docx" : ""}). Read all of it and decide yourself what should become form fields / list wraps. Heuristic hint blocks below are OPTIONAL aids only — they may be incomplete or wrong; override them when the document says otherwise.

Return ONLY valid JSON:
{"suggestions":[{"plainText":"exact VALUE span to replace","label":"nearby field label if any","name":"var_name","kind":"text"|"bool"|"auto"|"list"|"list-table","mode":"replace"|"wrap"|"wrap-row"|"fill-empty-tc","cellIndex":null,"trueText":"optional for bool","falseText":"optional for bool","occurrence":0}]}

Grounding (must stay true so the app can apply your tags):
- plainText MUST be an exact contiguous substring of TAGGER_PLAIN (same characters, including spaces/tabs) — EXCEPT blank table cells: mode "fill-empty-tc" with plainText = a row-anchor substring that exists in TAGGER_PLAIN (hints may suggest anchors; you may choose another valid anchor from the same prototype row if clearer).
- Do NOT invent prose that is not in TAGGER_PLAIN. Do NOT suggest text that already contains {{…}} tags.
- Max ${MAX_SUGGESTIONS} suggestions. Skip duplicates / unsafe overlaps (fields may nest fully inside a list wrap; fill-empty-tc may share a row anchor with its list-table wrap).
- occurrence is 0-based among identical plainText matches in document order (omit or 0 if unsure).
- Cover the document: emit a suggestion for every distinct fill-in VALUE you want tagged (different names/companies/phones/addresses/emails each need their own row). If the exact same VALUE string repeats in several safe places, one row is enough — the system expands it to every matching location. Do not under-suggest unique fields.
- Letterhead / footer contacts are required when present: after 「โทร」/「Tel」/「เบอร์โทรศัพท์」 tag the phone number or comma-list (${CONTACT_TAGGING_EXAMPLE}. Never tag a single digit inside a phone number.

How to split label vs value (use your judgment on the real text):
- When a fill-in VALUE follows a short caption/stem, set "label" to that caption exactly as in TAGGER_PLAIN and plainText to the VALUE only. VALUE may be ANY text (names, companies, addresses, amounts, phones, ids) — not only digits.
- Separators vary: Word tabs (\\t), spaces, NBSP, OR flush with NO separator. Do not assume tabs.
  Examples:
  ${LABEL_VALUE_SPLIT_EXAMPLES}
- Prefer omitting instructional tails like 「(ตัวอย่าง)」 and usually omit wrapping 「()」.

Kinds / modes (schema the app understands — pick what fits the document):
- "text" — one-off sample → {{name}} (replace), OR blank table cell (fill-empty-tc). Digits outside loops are text (e.g. ${outsideDigitExample}), never {{+name}} there. Prices, quantities, page refs, and other non-sequence numbers are text even inside loops.
- "bool" — checkbox-like √/✓/☑ → always emit BOTH arms: {{name?√,☐}} (true glyph, unchecked glyph). Never leave falseText empty. Unchecked must render ☐ (or ×), never √.
- "auto" — ONLY a running sequence number INSIDE an accepted list/list-table wrap when the column's body values are sequential integers (1,2,3…) → {{+name}}. Forbidden for prices, rates, quantities, page refs, amounts, and other non-sequence numbers. Digits outside loops are never auto.
- "list" — repeating prose OUTSIDE tables: wrap the FIRST unit only (mode "wrap"). Name like "${listNameExample}". MUST also emit inner replace fields for every fill-in inside that first unit (name, address, ids, …). Leave later units untagged.
- "list-table" — repeating TABLE rows: wrap ONLY the first body/data row (mode "wrap-row"). Skip headers and later sample rows. MUST emit replace/auto/bool for each non-empty sample cell on that prototype row (incl. first column), e.g. ${nameExample}. Empty meaningful cells → fill-empty-tc with cellIndex (name from the column header only — never from cell sample text).
- Prefer sample fill-in spots over headings/boilerplate as the replaced span (captions go in "label").
- Distinct meanings → distinct names even when values look alike: role A vs role B address/tax id/phone, document date vs document number. Derive names from the nearby label/role. NEVER disambiguate with _2/_3/_ก letter/digit suffixes — use role/context words instead. Never emit bare one-word names when a nearby caption gives more context.
- Leave fixed logos/seals as plain text, BUT DO tag fillable letterhead/header values: document numbers, party names, phones, emails, addresses, and dates when they are user-fillable samples.
- Cover typical fill blanks: letterhead/header fields, end dates, signature lines, name lines, amounts, repeating-row inners, and empty table cells. Tag unique footer/total figures when they are fill-ins. If you intentionally skip a blank, omit it only when it is clearly instructional/boilerplate.
- Repeating table body rows MUST use kind "list-table" (wrap-row on the first data row). Do not emit a flat text tag per cell across every sample row. Later sample rows are removed by the app after the prototype is tagged.
- Nested lists are unsupported — one wrap level only. One wrap per repeating sample group / table.
${nameLanguagePromptRule(opts.nameLanguage)}
${truncNotes ? `\nNOTE: ${truncNotes}\n` : ""}
FILE: ${opts.filename}

OPTIONAL_HEURISTIC_HINTS (not authoritative — verify against the full document):
PARAGRAPH_LIST_HINTS:
${paraListBlock}

EMPTY_TABLE_CELLS (heuristic blank cells on first data row):
${emptyBlock}

SAMPLE_TABLE_CELLS (heuristic non-empty cells on first data row):
${sampleBlock}

TAGGER_PLAIN (document order; <w:tab/> → \\t; no paragraph separators):
${plain || "(empty)"}

${xmlNote}`;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type SuggestCallResult = {
  parsed: Record<string, unknown> | null;
  rawText: string;
};

async function callGeminiSuggest(
  prompt: string,
  xml: string,
  opts: {
    apiKey: string;
    model: string;
    docxBuffer?: Buffer;
    filename?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<SuggestCallResult> {
  const url = `${getGeminiApiBase()}/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const xmlBuf = Buffer.from(xml, "utf8");
  const parts: GeminiPart[] = [
    { text: prompt },
    { text: "SOURCE_FILE_NAME: word/document.xml" },
    {
      inlineData: {
        mimeType: "text/xml",
        data: xmlBuf.toString("base64"),
      },
    },
  ];
  const docx = opts.docxBuffer;
  if (docx && docx.byteLength > 0 && docx.byteLength <= DOCX_ATTACH_MAX_BYTES) {
    const name = String(opts.filename || "document.docx").replace(/[^\w.\-()+ ]+/g, "_");
    parts.push({ text: `SOURCE_FILE_NAME: ${name} (original .docx package — read fully)` });
    parts.push({
      inlineData: {
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data: docx.toString("base64"),
      },
    });
  }
  const { withAiTimeout } = await import("./ai-request");
  return withAiTimeout(
    async (signal) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
          },
        }),
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          formatProviderHttpError(
            "Google AI",
            res.status,
            errText || res.statusText,
          ),
        );
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const rawText =
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("") || "";
      return { parsed: parseJsonObject(rawText), rawText };
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      route: "suggest-tags.gemini",
      provider: "google",
      model: opts.model,
    },
  );
}

async function callOpenAiSuggest(
  providerId: string,
  prompt: string,
  opts: {
    apiKey: string;
    model: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<SuggestCallResult> {
  const provider = getAiProvider(providerId);
  if (!provider || provider.apiFamily !== "openai" || !provider.baseUrl) {
    throw new Error(`ผู้ให้บริการ ${providerId} ไม่รองรับ OpenAI-compatible API`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    ...(provider.defaultHeaders || {}),
  };
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  };
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const { withAiTimeout } = await import("./ai-request");
  return withAiTimeout(
    async (signal) => {
      let res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok && res.status === 400) {
        delete body.response_format;
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          formatProviderHttpError(
            provider.label,
            res.status,
            errText || res.statusText,
          ),
        );
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | unknown } }[];
      };
      const raw = data.choices?.[0]?.message?.content;
      const rawText =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw
                .map((p) =>
                  p && typeof p === "object" && "text" in p
                    ? String((p as { text?: string }).text || "")
                    : "",
                )
                .join("")
            : "";
      return { parsed: parseJsonObject(rawText), rawText };
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      route: "suggest-tags.openai",
      provider: providerId,
      model: opts.model,
    },
  );
}

async function callAnthropicSuggest(
  prompt: string,
  opts: {
    apiKey: string;
    model: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<SuggestCallResult> {
  const { withAiTimeout } = await import("./ai-request");
  return withAiTimeout(
    async (signal) => {
      const res = await fetch(`${getAnthropicApiBase()}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 8192,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
        signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          formatProviderHttpError(
            "Anthropic",
            res.status,
            errText || res.statusText,
          ),
        );
      }
      const data = (await res.json()) as {
        content?: { type?: string; text?: string }[];
      };
      const rawText = (data.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");
      return { parsed: parseJsonObject(rawText), rawText };
    },
    {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      route: "suggest-tags.anthropic",
      provider: "anthropic",
      model: opts.model,
    },
  );
}

function normalizeRawSuggestions(
  parsed: Record<string, unknown> | null,
): Record<string, unknown>[] {
  if (!parsed) return [];
  const list = parsed.suggestions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (x): x is Record<string, unknown> =>
      !!x && typeof x === "object" && !Array.isArray(x),
  );
}

function pickOccurrenceOrder(
  starts: number[],
  preferredRaw: unknown,
): number[] {
  const preferred = Number(preferredRaw ?? 0);
  const order: number[] = [];
  if (Number.isFinite(preferred) && preferred >= 0 && preferred < starts.length) {
    order.push(preferred);
  }
  for (let i = 0; i < starts.length; i += 1) {
    if (!order.includes(i)) order.push(i);
  }
  return order;
}

/**
 * Field replace may nest fully inside a soft wrap span; anything else colliding is unsafe.
 * Reject fields that consume the entire wrap span — that fights the list prototype
 * (e.g. tagging a whole numbered party block as one scalar instead of {{#list}}).
 */
function fieldSpanAllowed(
  start: number,
  end: number,
  occupied: OccupiedSpan[],
): boolean {
  for (const r of occupied) {
    if (!spansOverlap(start, end, r.start, r.end)) continue;
    if (r.soft && spanContains(r, start, end)) {
      if (start === r.start && end === r.end) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Wraps must not overlap any existing span (hard or soft). */
function wrapSpanAllowed(
  start: number,
  end: number,
  occupied: OccupiedSpan[],
): boolean {
  for (const r of occupied) {
    if (spansOverlap(start, end, r.start, r.end)) return false;
  }
  return true;
}

type PendingRow = {
  raw: Record<string, unknown>;
  kind: AiTagDraftKind;
  listLike: boolean;
  fillEmpty: boolean;
};

type SoftWrapSpan = OccupiedSpan & {
  wrapTag: string;
  wrapOccurrence: number;
  name: string;
  tableIndex?: number;
};

function parseFillEmptyMode(raw: Record<string, unknown>): boolean {
  const mode = String(raw.mode ?? raw.replaceMode ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (
    mode === "fill-empty-tc" ||
    mode === "fill-empty" ||
    mode === "empty-tc" ||
    mode === "empty-cell"
  ) {
    return true;
  }
  if (mode === "replace" || mode === "wrap" || mode === "wrap-row") return false;
  // Require an explicit numeric cellIndex (ignore null/"" from JSON schemas).
  const rawCi = raw.cellIndex ?? raw.cell_index ?? raw.tcIndex;
  if (rawCi == null || rawCi === "") return false;
  const ci = Number(rawCi);
  return Number.isFinite(ci) && ci >= 0;
}

function cellKey(tableIndex: number, rowIndexInTable: number, cellIndex: number): string {
  return `${tableIndex}:${rowIndexInTable}:${cellIndex}`;
}

function matchEmptyHint(
  hints: TableEmptyCellHint[],
  plain: string,
  start: number,
  end: number,
  cellIndex: number,
): TableEmptyCellHint | null {
  for (const h of hints) {
    if (h.cellIndex !== cellIndex) continue;
    if (h.rowAnchor === plain && start >= h.plainStart && end <= h.plainEnd) {
      return h;
    }
    if (start >= h.plainStart && end <= h.plainEnd) return h;
  }
  // Fall back: same cellIndex + row overlap by plainStart alone.
  for (const h of hints) {
    if (h.cellIndex !== cellIndex) continue;
    if (start >= h.plainStart && start < h.plainEnd) return h;
  }
  return null;
}

function findParentWrap(
  wraps: SoftWrapSpan[],
  start: number,
  end: number,
): SoftWrapSpan | null {
  for (const w of wraps) {
    if (start >= w.start && end <= w.end) return w;
  }
  for (const w of wraps) {
    if (spansOverlap(start, end, w.start, w.end)) return w;
  }
  return null;
}

/**
 * auto / {{+name}} is only valid inside an accepted list or list-table soft wrap
 * AND only when the span looks like a real run/sequence number.
 * Stray or misused auto → text.
 */
function coerceFieldKindForWrap(
  kind: AiTagDraftKind,
  wraps: SoftWrapSpan[],
  start: number,
  end: number,
  opts?: {
    header?: string | null;
    cellIndex?: number | null;
    cellText?: string | null;
    isRunColumn?: boolean | null;
  },
): AiTagDraftKind {
  if (kind !== "auto") return kind;
  if (!findParentWrap(wraps, start, end)) return "text";
  const text = String(opts?.cellText ?? "").trim();
  // Mis-tagged non-digit values must not keep {{+}}.
  if (text && !/^\d{1,4}$/.test(text)) return "text";
  if (/^\d{1,4}$/.test(text)) {
    if (opts?.header || typeof opts?.cellIndex === "number") {
      return looksLikeRunSequence({
        header: opts.header,
        cellIndex: opts.cellIndex,
        cellText: text,
        isRunColumn: opts.isRunColumn,
      })
        ? "auto"
        : "text";
    }
    // Paragraph-list run index inside a wrap (no column header).
    return "auto";
  }
  // Empty fill-empty-tc: only sequence columns.
  return looksLikeRunSequence({
    header: opts?.header,
    cellIndex: opts?.cellIndex,
    cellText: null,
    isRunColumn: opts?.isRunColumn,
  })
    ? "auto"
    : "text";
}

/**
 * Pure-digit needles must be a complete token — not a shard of a phone/id.
 * Rejects short digits mid-phone / mid-id, and 1–2 digit markers flush to Thai.
 * Allows longer digit cells flush to Thai when Word tables omit separators.
 */
function plainDigitMatchAllowed(haystack: string, idx: number, needle: string): boolean {
  if (!/^\d+$/.test(needle)) return true;
  const end = idx + needle.length;
  const next = haystack[end] || "";
  const prev = idx > 0 ? haystack[idx - 1]! : "";
  if (/\d/.test(next)) return false;
  if (needle.length <= 2 && /[\u0E00-\u0E7F]/u.test(next)) return false;
  // Mid phone / account: digit or separator on the left (02-0[3]-2599).
  if (/[\d\-/.]/.test(prev)) return false;
  // Any hyphen/slash after a pure digit is unsafe ("02-02[3]-2599", "บางคูวัด[3]-สืบ").
  if (/[\-/.]/.test(next)) return false;
  return true;
}

/**
 * Reject only mid-token continuations. A complete phone before a list comma is OK
 * (first number alone). Still blocks Latin glue and mid-hyphen digits
 * (handled mainly in plainDigitMatchAllowed).
 */
function plainValueTailOk(haystack: string, idx: number, needle: string): boolean {
  const end = idx + needle.length;
  if (end >= haystack.length) return true;
  const next = haystack[end]!;
  const last = needle[needle.length - 1] || "";
  // Mid-number only (not a list comma): "02-02" + "-" + "3…"
  if (/[\-/.]/.test(next) && /\d/.test(haystack[end + 1] || "")) return false;
  if (/[A-Za-z]/.test(last) && /[A-Za-z0-9]/.test(next)) return false;
  return true;
}

function findCellTextInRow(
  plainText: string,
  cellText: string,
  rowStart: number,
  rowEnd: number,
): { start: number; end: number; occurrence: number } | null {
  if (!cellText) return null;
  const starts = findOccurrenceStarts(plainText, cellText);
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = start + cellText.length;
    if (start < rowStart || end > rowEnd) continue;
    if (!plainDigitMatchAllowed(plainText, start, cellText)) continue;
    return { start, end, occurrence: i };
  }
  return null;
}

function inferSampleFieldKind(
  cellText: string,
  opts?: {
    header?: string | null;
    cellIndex?: number | null;
    isRunColumn?: boolean | null;
  },
): AiTagDraftKind {
  if (/^[✓√✔☑]$/u.test(cellText)) return "bool";
  if (
    /^\d+$/.test(cellText) &&
    looksLikeRunSequence({
      header: opts?.header,
      cellIndex: opts?.cellIndex,
      cellText,
      isRunColumn: opts?.isRunColumn,
    })
  ) {
    return "auto";
  }
  return "text";
}

/** Clean stem borrowed from a parent loop name when a cell has no header. */
function parentNameStem(
  parentName: string | null | undefined,
  lang: AiTagNameLanguage,
): string | null {
  const raw = String(parentName || "").trim();
  if (!raw) return null;
  const parts = raw.split(/[_/-]+/u).filter((p) => p.length >= 2);
  // Prefer shorter parts (e.g. rows over defendant) for readable auto/cell names.
  const ordered = [...parts].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const p of ordered) {
    const n = resolveVarName(p, lang);
    // Never return the whole loop name as a scalar stem.
    if (n && n !== raw && !looksLikeGarbledName(n) && n.length <= 16) return n;
  }
  return null;
}

/**
 * Structural inner-field name from column header (preferred) or a sibling
 * header joined with the parent stem. Never invents dotted/numeric suffixes.
 */
function structuralCellName(
  parentName: string | null | undefined,
  cellIndex: number,
  lang: AiTagNameLanguage,
  header?: string | null,
  siblingHeaders: ReadonlyArray<string> = [],
): string | null {
  void cellIndex;
  const fromHeader = nameFromHeaderOrLabel(header, null, lang, null);
  if (fromHeader && !looksLikeGarbledName(fromHeader) && NAME_RE.test(fromHeader)) {
    return fromHeader;
  }
  const stem = parentNameStem(parentName, lang);
  for (const raw of siblingHeaders) {
    const h = String(raw || "").trim();
    if (!h || h === String(header || "").trim()) continue;
    const hn = nameFromHeaderOrLabel(h, null, lang, null);
    if (!hn || looksLikeGarbledName(hn)) continue;
    // Always join with parent stem — never steal a bare sibling column header.
    if (stem && hn !== stem) {
      const joined = (
        lang === "en" ? sanitizeNameAscii(`${stem}_${hn}`) : sanitizeName(`${stem}_${hn}`)
      ).slice(0, 40);
      if (joined && NAME_RE.test(joined) && !looksLikeGarbledName(joined)) {
        return joined;
      }
    }
  }
  // No document-derived label — refuse rather than invent dotted/numeric junk.
  return null;
}

/**
 * Prefer a readable list name from column headers only (never sample cell text).
 * Skip the first header when multiple exist — it is often an ordinal / typo that
 * would collide with an inner field name.
 */
function inventListTableName(
  samples: TableSampleCellHint[],
  empties: TableEmptyCellHint[],
  tableIndex: number,
  lang: AiTagNameLanguage,
): string {
  const headers = [...samples, ...empties]
    .map((h) => String(h.header || "").trim())
    .filter((h) => !!h);
  const unique: string[] = [];
  for (const h of headers) {
    if (!unique.includes(h)) unique.push(h);
  }
  // Prefer headers after the first when several columns exist.
  const stemSrc = unique.length > 1 ? unique.slice(1) : unique;
  const fromHeaders = stemSrc
    .map((h) => resolveVarName(h, lang))
    .filter((h) => h && h.length >= 2 && !looksLikeGarbledName(h))
    .slice(0, 2);
  if (lang === "en") {
    if (fromHeaders.length) {
      const joined = sanitizeNameAscii(fromHeaders.join("_")).slice(0, 24);
      if (joined && !looksLikeGarbledName(joined)) return joined;
    }
    return `rows_${tableIndex + 1}`;
  }
  if (fromHeaders.length) {
    const joined = sanitizeName(fromHeaders.join("_")).slice(0, 24);
    if (joined && !looksLikeGarbledName(joined)) return joined;
  }
  // Structural index only when no usable header context exists.
  return `loop_${tableIndex + 1}`;
}

/** True when [start,end) lies fully inside a first-data/prototype table row. */
function isInsidePrototypeRow(
  start: number,
  end: number,
  prototypes: PrototypeTableRowSpan[],
): boolean {
  for (const p of prototypes) {
    if (start >= p.plainStart && end <= p.plainEnd) return true;
  }
  return false;
}

/**
 * Table-row role of a plain span for AI draft gating.
 * - outside: not in a <w:tr> (paragraph list / free text OK)
 * - prototype: first body/data row of that table
 * - other: header or later sample/footer row — reject *duplicate* sample tags
 */
function tableRowRoleForSpan(
  xml: string,
  start: number,
  end: number,
  prototypes: PrototypeTableRowSpan[],
): "outside" | "prototype" | "other" {
  if (!xml) return "outside";
  const rowSpan = tryPlainSpanOfTableRow(xml, start, end);
  if (!rowSpan) return "outside";
  if (
    isInsidePrototypeRow(rowSpan.start, rowSpan.end, prototypes) ||
    isInsidePrototypeRow(start, end, prototypes)
  ) {
    return "prototype";
  }
  // Exact row-span match against prototype bounds.
  for (const p of prototypes) {
    if (rowSpan.start === p.plainStart && rowSpan.end === p.plainEnd) {
      return "prototype";
    }
  }
  return "other";
}

/**
 * True when `value` already appears as a safe token inside any prototype data row.
 * Used to skip later sample-row duplicates while still allowing unique footer/totals
 * (e.g. รวมทั้งสิ้น 1,116) that never occur on the first data row.
 */
function valueAppearsInPrototypeRows(
  plainText: string,
  value: string,
  prototypes: PrototypeTableRowSpan[],
): boolean {
  if (!value || !prototypes.length) return false;
  for (const p of prototypes) {
    const slice = plainText.slice(p.plainStart, p.plainEnd);
    let from = 0;
    while (from <= slice.length) {
      const rel = slice.indexOf(value, from);
      if (rel < 0) break;
      const abs = p.plainStart + rel;
      if (
        plainDigitMatchAllowed(plainText, abs, value) &&
        plainValueTailOk(plainText, abs, value)
      ) {
        return true;
      }
      from = rel + 1;
    }
  }
  return false;
}

/**
 * Structural cell-shape for a table row (empty / short-int / amount / bool / text).
 * Used to tell sample clones from distinct fixed rows without keyword lists.
 */
export function tableRowShapeSignature(
  cells: ReadonlyArray<{ text: string }>,
): string {
  return cells
    .map((c) => {
      const t = String(c.text ?? "").trim();
      if (!t) return "E";
      if (/^[✓√✔☑☐□☒×✖]$/u.test(t)) return "B";
      if (/^\d{1,4}$/.test(t)) return "N";
      if (/^\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(t) || /^\d{4,}$/.test(t)) return "A";
      if (t.length <= 2) return "S";
      const lead = t.match(/^(\d{1,4})(?!\d)/);
      const leadOrd = lead ? "o" : "x";
      const rest = lead ? t.slice(lead[0].length) : t;
      const restDigitRuns = Math.min(3, (rest.match(/\d[\d,.]*/g) || []).length);
      const bucket = t.length < 24 ? "s" : t.length < 64 ? "m" : "l";
      return `T${leadOrd}${restDigitRuns}${bucket}`;
    })
    .join("|");
}

/** True when two row shapes match as sample clones (same column roles). */
export function tableRowsSameSampleShape(
  a: ReadonlyArray<{ text: string }>,
  b: ReadonlyArray<{ text: string }>,
): boolean {
  const sa = tableRowShapeSignature(a);
  const sb = tableRowShapeSignature(b);
  if (!sa || !sb || sa !== sb) return false;
  // Require at least one filled sample token so blank-vs-blank is not a clone.
  return /[NBATS]/.test(sa);
}

export function countFilledCells(
  cells: ReadonlyArray<{ text: string }>,
): number {
  return cells.filter((c) => String(c.text ?? "").trim().length > 0).length;
}

function cellLooksLikeAmount(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(t)) return true;
  if (/^\d{4,}$/.test(t)) return true;
  if (/^\d+$/.test(t) && Number(t) >= 100) return true;
  // Small money / VAT figures (e.g. 63) — not 1–9 lone runnos.
  if (/^\d{2,3}$/.test(t) && Number(t) >= 10) return true;
  if (/^\d+[.,]\d+$/.test(t)) return true;
  return false;
}

/**
 * Summary-like row: fewer filled cells and a spanning/merged label, near table end.
 * Keyword-free structural test (no totals word lists).
 */
export function isSummaryLikeRow(
  proto: ReadonlyArray<{ text: string }>,
  row: ReadonlyArray<{ text: string }>,
  opts: { isAtTableEnd: boolean; isNearEnd?: boolean },
): boolean {
  // Trailing block (totals / VAT / notes) — caller marks isNearEnd for the whole trailer.
  if (!opts.isAtTableEnd && !opts.isNearEnd) return false;
  const pf = countFilledCells(proto);
  const rf = countFilledCells(row);
  if (!(rf > 0 && rf <= pf) && !(row.length > 0 && row.length < proto.length)) {
    return false;
  }
  const filled = row.filter((c) => String(c.text ?? "").trim());
  const hasLabel = filled.some((c) => {
    const t = String(c.text ?? "").trim();
    return t.length >= 2 && !/^\d[\d,.\s]*$/.test(t) && !/^[✓√✔☑☐□☒×✖]$/u.test(t);
  });
  const hasAmount = filled.some((c) => cellLooksLikeAmount(String(c.text ?? "")));
  // Leading ordinal only — short ints that are NOT amounts (totals often use 3+ digit figures).
  const hasLeadOrd = filled.some((c) => {
    const t = String(c.text ?? "").trim();
    return /^\d{1,3}$/.test(t) && !cellLooksLikeAmount(t);
  });
  // Sample clones keep a leading ordinal; summary rows usually do not.
  if (hasLeadOrd) return false;
  // Merged/spanning label, label + amount, or sparse note row in the trailer.
  return (
    filled.length === 1 ||
    (filled.length <= 2 && rf <= Math.max(1, pf - 1)) ||
    (hasLabel && hasAmount && rf <= 4) ||
    (hasLabel && rf <= Math.max(2, pf - 1) && !tableRowsSameSampleShape(proto, row))
  );
}

/** Blank / ordinal-only later rows are sample clones, not totals/notes. */
export function isBlankSampleCloneRow(
  proto: ReadonlyArray<{ text: string }>,
  row: ReadonlyArray<{ text: string }>,
): boolean {
  const rf = countFilledCells(row);
  if (rf === 0) return true;
  const filled = row.filter((c) => String(c.text ?? "").trim());
  if (
    filled.length === 1 &&
    /^\d{1,2}$/.test(String(filled[0]!.text ?? "").trim()) &&
    !cellLooksLikeAmount(String(filled[0]!.text ?? ""))
  ) {
    return true;
  }
  // Same column count, all empty or only matching proto empties — blank template clone.
  if (row.length === proto.length && rf <= 1 && !isSummaryLikeRow(proto, row, {
    isAtTableEnd: true,
    isNearEnd: true,
  })) {
    return tableRowsSameSampleShape(proto, row) || rf === 0;
  }
  return false;
}

/**
 * Index of the first trailing fixed row (subtotal/VAT/total/note block) after the
 * last sample-shaped clone. Returns Infinity when there is no trailing block.
 */
export function findTrailingFixedRowStart(
  proto: ReadonlyArray<{ text: string }>,
  laterRows: ReadonlyArray<{ rowIndexInTable: number; cells: ReadonlyArray<{ text: string }> }>,
): number {
  if (!laterRows.length) return Number.POSITIVE_INFINITY;
  const ordered = [...laterRows].sort(
    (a, b) => a.rowIndexInTable - b.rowIndexInTable,
  );
  let startIdx = ordered.length;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const row = ordered[i]!;
    // Blank template clones are deleted with samples — never part of the trailer.
    if (isBlankSampleCloneRow(proto, row.cells)) break;
    const opts = {
      isAtTableEnd: i === ordered.length - 1,
      isNearEnd: true,
    };
    const summary = isSummaryLikeRow(proto, row.cells, opts);
    const sampleLike =
      rowHasSampleLikeValues(proto, row.cells) ||
      tableRowsSameSampleShape(proto, row.cells);
    if (summary || !sampleLike) {
      startIdx = i;
      continue;
    }
    break;
  }
  if (startIdx >= ordered.length) return Number.POSITIVE_INFINITY;
  return ordered[startIdx]!.rowIndexInTable;
}

/**
 * True when a later row still looks like a sample clone (shared non-amount values
 * or continuing ordinals). Amount-only digits on a totals line are NOT sample-like.
 */
export function rowHasSampleLikeValues(
  proto: ReadonlyArray<{ text: string }>,
  row: ReadonlyArray<{ text: string }>,
): boolean {
  const protoVals = new Set(
    proto.map((c) => String(c.text ?? "").trim()).filter((t) => t.length > 0),
  );
  for (const c of row) {
    const t = String(c.text ?? "").trim();
    if (!t) continue;
    if (protoVals.has(t)) return true;
  }
  // Ordinal continuation only for small run numbers (not VAT/amounts like 63/900).
  const isOrd = (raw: string) => {
    const t = String(raw || "").trim();
    if (!/^\d{1,2}$/.test(t) || cellLooksLikeAmount(t)) return false;
    const n = Number(t);
    return Number.isFinite(n) && n >= 1 && n <= 40;
  };
  const protoDig = proto.find((c) => isOrd(String(c.text ?? "")));
  const rowDig = row.find((c) => isOrd(String(c.text ?? "")));
  if (protoDig && rowDig) {
    const a = Number(String(protoDig.text).trim());
    const b = Number(String(rowDig.text).trim());
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return true;
  }
  return tableRowsSameSampleShape(proto, row);
}

/**
 * Delete every later data row except summary-like rows, and except distinct fixed
 * rows that carry no sample-like values.
 */
export function shouldDeleteLaterSampleRow(
  proto: ReadonlyArray<{ text: string }>,
  row: ReadonlyArray<{ text: string }>,
  opts: { isAtTableEnd: boolean; isNearEnd?: boolean },
): boolean {
  if (isBlankSampleCloneRow(proto, row)) return true;
  if (isSummaryLikeRow(proto, row, opts)) return false;
  if (
    !rowHasSampleLikeValues(proto, row) &&
    !tableRowsSameSampleShape(proto, row)
  ) {
    return false;
  }
  return true;
}

/**
 * Kept later rows (summary / distinct fixed) may host unique fill values.
 */
function isDistinctNonSampleTableField(
  xml: string,
  start: number,
  end: number,
  prototypes: PrototypeTableRowSpan[],
  allDataRows: DataTableRowInfo[],
): boolean {
  if (!xml) return false;
  const rowSpan = tryPlainSpanOfTableRow(xml, start, end);
  if (!rowSpan) return false;
  const hit = allDataRows.find(
    (r) => r.plainStart === rowSpan.start && r.plainEnd === rowSpan.end,
  );
  if (!hit) return false;
  const proto = prototypes.find((p) => p.tableIndex === hit.tableIndex);
  if (!proto) return false;
  if (hit.rowIndexInTable <= proto.rowIndexInTable) return false;
  const protoRow = allDataRows.find(
    (r) =>
      r.tableIndex === hit.tableIndex &&
      r.rowIndexInTable === proto.rowIndexInTable,
  );
  if (!protoRow) return false;
  const tableRows = allDataRows.filter((r) => r.tableIndex === hit.tableIndex);
  const maxRi = Math.max(...tableRows.map((r) => r.rowIndexInTable));
  // Tagable when we would KEEP the row (not delete it).
  const later = allDataRows.filter(
    (r) =>
      r.tableIndex === hit.tableIndex &&
      r.rowIndexInTable > proto.rowIndexInTable,
  );
  const trailStart = findTrailingFixedRowStart(protoRow.cells, later);
  const inTrailer = hit.rowIndexInTable >= trailStart;
  return (
    inTrailer ||
    !shouldDeleteLaterSampleRow(protoRow.cells, hit.cells, {
      isAtTableEnd: hit.rowIndexInTable === maxRi,
      isNearEnd: inTrailer || hit.rowIndexInTable >= maxRi - 1,
    })
  );
}

/**
 * When a paragraph-list wrap touches a detected repeating group: expand/clamp to
 * the FIRST unit only (same product model as list-table first row). Reject wraps
 * that start on a later sample unit.
 */
function resolveParagraphListWrapSpan(
  start: number,
  end: number,
  hints: ParagraphListHint[],
): { start: number; end: number; hint: ParagraphListHint | null } | null {
  for (const h of hints) {
    if (end <= h.plainStart || start >= h.groupEnd) continue;
    // Starts inside a later sample unit of this group → reject.
    if (start >= h.plainEnd && start < h.groupEnd) return null;
    // Any overlap with the prototype → snap to the full first unit.
    if (start < h.plainEnd && end > h.plainStart) {
      return { start: h.plainStart, end: h.plainEnd, hint: h };
    }
  }
  return { start, end, hint: null };
}

/**
 * Validate AI rows against tagger plain: exact match, no unsafe overlaps.
 * List wraps are soft-occupied so nested text/bool/auto may sit fully inside.
 * Empty cells use mode fill-empty-tc (cellIndex + row anchor); XML hints enrich
 * blanks AND non-empty sample cells under headers inside accepted list-table rows.
 * Table tags (list-table / fill-empty-tc / cell fields) only on the first data row
 * per <w:tbl>. Paragraph lists: wrap the first unit; later units stay taggable.
 */
export function validateAiTagSuggestions(
  plainText: string,
  rawRows: Record<string, unknown>[],
  documentXml?: string | null,
  nameLanguage: AiTagNameLanguage = "th",
): AiTagSuggestion[] {
  const occupied = collectExistingTagRanges(plainText);
  const usedNames = new Set<string>();
  /** Loop/wrap names — scalars must never share these (avoids [object Object] fills). */
  const reservedLoopNames = new Set<string>();
  const out: AiTagSuggestion[] = [];
  const softWraps: SoftWrapSpan[] = [];
  const usedCells = new Set<string>();
  const xml = typeof documentXml === "string" && documentXml ? documentXml : "";
  const emptyHints = xml ? listEmptyTableCellHints(xml) : [];
  const sampleHints = xml ? listSampleTableCellHints(xml) : [];
  const prototypes = xml ? listPrototypeTableRowSpans(xml) : [];
  const paraListHints = xml ? listParagraphListHints(xml) : [];
  const allDataRows = xml ? listAllDataTableRows(xml) : [];
  /** tableIndex → first trailing fixed row index (subtotal/VAT/total/note). */
  const trailingFixedStart = new Map<number, number>();
  {
    const byTable = new Map<number, DataTableRowInfo[]>();
    for (const row of allDataRows) {
      const list = byTable.get(row.tableIndex) || [];
      list.push(row);
      byTable.set(row.tableIndex, list);
    }
    for (const [ti, rows] of byTable) {
      const proto = prototypes.find((p) => p.tableIndex === ti);
      if (!proto) continue;
      const protoRow = rows.find((r) => r.rowIndexInTable === proto.rowIndexInTable);
      if (!protoRow) continue;
      const later = rows.filter((r) => r.rowIndexInTable > proto.rowIndexInTable);
      trailingFixedStart.set(
        ti,
        findTrailingFixedRowStart(protoRow.cells, later),
      );
    }
  }
  /** tableIndex → column indexes whose body values are sequential integers. */
  const runColsByTable = new Map<number, Set<number>>();
  {
    const byTable = new Map<number, DataTableRowInfo[]>();
    for (const row of allDataRows) {
      const list = byTable.get(row.tableIndex) || [];
      list.push(row);
      byTable.set(row.tableIndex, list);
    }
    for (const [ti, rows] of byTable) {
      runColsByTable.set(ti, detectRunSequenceColumns(rows));
    }
  }
  const isRunCol = (tableIndex: number | null | undefined, cellIndex: number | null | undefined): boolean | null => {
    if (typeof tableIndex !== "number" || typeof cellIndex !== "number") return null;
    const rowsForTable = allDataRows.filter((r) => r.tableIndex === tableIndex);
    // Fewer than 2 body rows → cannot prove sequence from data.
    if (rowsForTable.length < 2) return null;
    const set = runColsByTable.get(tableIndex) || new Set<number>();
    return set.has(cellIndex);
  };
  const usedPrototypeTables = new Set<number>();
  const usedParaListStems = new Set<string>();
  const lang = nameLanguage === "en" ? "en" : "th";

  const pending: PendingRow[] = [];
  for (const raw of rawRows) {
    const kind = parseKind(raw.kind ?? raw.type);
    if (!kind) continue;
    const fillEmpty = !isListKind(kind) && parseFillEmptyMode(raw);
    pending.push({ raw, kind, listLike: isListKind(kind), fillEmpty });
  }

  // Seed list-table wrap-row for every detected prototype table row.
  // Prefer sample/empty hints when present; otherwise use the prototype span
  // itself so headerless repeating tables still get a loop suggestion.
  if (xml && prototypes.length) {
    const tablesNeedingWrap = new Set<number>();
    for (const p of prototypes) tablesNeedingWrap.add(p.tableIndex);
    for (const h of sampleHints) tablesNeedingWrap.add(h.tableIndex);
    for (const h of emptyHints) tablesNeedingWrap.add(h.tableIndex);
    for (const ti of tablesNeedingWrap) {
      const samples = sampleHints.filter((h) => h.tableIndex === ti);
      const empties = emptyHints.filter((h) => h.tableIndex === ti);
      const proto = prototypes.find((p) => p.tableIndex === ti);
      const pick = samples[0] || empties[0];
      const protoAnchor =
        proto && proto.plainEnd > proto.plainStart
          ? plainText.slice(proto.plainStart, proto.plainEnd)
          : "";
      const anchor = pick?.rowAnchor || protoAnchor;
      const occurrence = pick?.occurrence ?? 0;
      if (!anchor) continue;
      pending.push({
        raw: {
          plainText: anchor,
          occurrence,
          name: inventListTableName(samples, empties, ti, lang),
          kind: "list-table",
          mode: "wrap-row",
        },
        kind: "list-table",
        listLike: true,
        fillEmpty: false,
      });
    }
  }

  // Seed paragraph-list wraps for consecutive numbered prose blocks.
  // Skip any hint that overlaps a table row — those belong to list-table wraps
  // (avoids a stray paragraph loop beside a blank repeating table).
  if (xml && paraListHints.length) {
    const overlapsTable = (start: number, end: number) =>
      allDataRows.some((r) => start < r.plainEnd && end > r.plainStart) ||
      prototypes.some((p) => start < p.plainEnd && end > p.plainStart);
    const paraSeeds: PendingRow[] = [];
    for (const h of paraListHints) {
      if (!h.plainText || !(h.plainEnd > h.plainStart)) continue;
      if (overlapsTable(h.plainStart, h.groupEnd || h.plainEnd)) continue;
      paraSeeds.push({
        raw: {
          plainText: h.plainText,
          occurrence: 0,
          name: lang === "en" ? h.suggestedNameEn : h.suggestedNameTh,
          kind: "list",
          mode: "wrap",
        },
        kind: "list",
        listLike: true,
        fillEmpty: false,
      });
    }
    if (paraSeeds.length) pending.unshift(...paraSeeds);
  }

  // Wraps first, then fill-empty-tc, then normal replaces.
  // Among scalar replaces: longer VALUE first (list phones before a short prefix),
  // then prefer rows that already have an explicit label (avoid glued-stem rows
  // stealing the locus). Keep wrap/fill order stable.
  const scalarValueKey = (
    p: PendingRow,
  ): { len: number; labeled: number; amount: number } => {
    const label = String(
      p.raw.label ?? p.raw.fieldLabel ?? p.raw.field_label ?? p.raw.caption ?? "",
    ).trim();
    let value = String(p.raw.plainText ?? p.raw.text ?? "").trim();
    if (label && value.startsWith(label)) {
      value = value
        .slice(label.length)
        .replace(new RegExp(`^${PLAIN_SEP_CLASS}+`, "u"), "");
    }
    const stem = GLUED_STEM_RE.exec(value);
    if (stem) {
      value = value
        .slice(stem[0].length)
        .replace(new RegExp(`^${PLAIN_SEP_CLASS}*`, "u"), "");
    }
    if (/^[\(（].+[\)）]$/u.test(value)) value = value.slice(1, -1).trim();
    return {
      len: value.length,
      labeled: label ? 1 : 0,
      // Amounts claim the clean label before long baht-text siblings.
      amount: cellLooksLikeAmount(value) ? 1 : 0,
    };
  };
  pending.sort((a, b) => {
    const rank = (p: PendingRow) => (p.listLike ? 2 : p.fillEmpty ? 1 : 0);
    const rd = rank(b) - rank(a);
    if (rd) return rd;
    if (rank(a) !== 0) return 0;
    const ka = scalarValueKey(a);
    const kb = scalarValueKey(b);
    if (kb.amount !== ka.amount) return kb.amount - ka.amount;
    if (kb.len !== ka.len) return kb.len - ka.len;
    return kb.labeled - ka.labeled;
  });

  const markSampleCellUsed = (start: number, end: number) => {
    for (const h of sampleHints) {
      if (start >= h.plainStart && end <= h.plainEnd) {
        const loc = findCellTextInRow(plainText, h.cellText, h.plainStart, h.plainEnd);
        if (loc && loc.start === start && loc.end === end) {
          usedCells.add(cellKey(h.tableIndex, h.rowIndexInTable, h.cellIndex));
        }
      }
    }
  };

  const prototypeForSpan = (
    start: number,
    end: number,
  ): PrototypeTableRowSpan | null => {
    for (const p of prototypes) {
      if (start >= p.plainStart && end <= p.plainEnd) return p;
    }
    return null;
  };

  for (const { raw: row, kind: kindIn, fillEmpty } of pending) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const plain = String(row.plainText ?? row.text ?? "").trim();
    if (!plain) continue;
    const maxPlain = isListKind(kindIn) ? MAX_LIST_PLAIN : MAX_FIELD_PLAIN;
    if (plain.length > maxPlain) continue;
    if (/\{\{[^{}]+\}\}/.test(plain)) continue;

    const kind: AiTagDraftKind = kindIn;
    // Prompt schema: `label` = nearby form caption in TAGGER_PLAIN; `name` = variable id.
    const anchorLabel = String(
      row.label ?? row.fieldLabel ?? row.field_label ?? row.caption ?? "",
    ).trim();
    const headerHintEarly = String(
      row.headerHint ?? row.header ?? row.columnHeader ?? "",
    ).trim();
    // Prefer header/label for stable cross-run naming — never let the model
    // override a header/label-derived name (Jaccard stability across runs).
    // Never derive scalar names from sample/fill cell text.
    const fromHeaderOrLabel = nameFromHeaderOrLabel(
      headerHintEarly,
      anchorLabel,
      lang,
      isListKind(kind) ? null : plain,
    );
    const nameSource = preferContextualNameSource(
      String(row.name ?? "").trim(),
      anchorLabel,
      [headerHintEarly].filter(Boolean),
    );
    const modelResolved =
      resolveVarName(String(row.name ?? "").trim(), lang) ||
      resolveVarName(nameSource, lang) ||
      "";
    // Header/label wins for cross-run stability. Allow a model name only when it
    // is a strict extension of that label (amount vs baht-text disambiguation).
    let baseName = fromHeaderOrLabel || modelResolved || "";
    if (
      fromHeaderOrLabel &&
      modelResolved &&
      modelResolved !== fromHeaderOrLabel &&
      !looksLikeGarbledName(modelResolved) &&
      (modelResolved.includes(fromHeaderOrLabel) ||
        modelResolved.startsWith(fromHeaderOrLabel))
    ) {
      baseName = modelResolved;
    }
    if (baseName && looksLikeGarbledName(baseName)) baseName = fromHeaderOrLabel || "";
    if (!isListKind(kind) && looksLikeFillValue(plain)) {
      if (baseName && nameEqualsSourceValue(baseName, plain)) {
        baseName = fromHeaderOrLabel || "";
      }
      if (!baseName || nameEqualsSourceValue(baseName, plain)) continue;
    }
    // Reject names that embed sample digit runs (not long label-derived ids).
    if (!isListKind(kind) && baseName && /\d{3,}/.test(baseName)) {
      baseName = fromHeaderOrLabel || "";
    }
    if (!baseName || looksLikeGarbledName(baseName)) continue;
    // Never tag rate/caption labels (e.g. text with % that is not an amount).
    if (
      !isListKind(kind) &&
      /%/.test(plain) &&
      !cellLooksLikeAmount(plain)
    ) {
      continue;
    }
    const name = uniqueName(
      baseName,
      usedNames,
      [anchorLabel, headerHintEarly, modelResolved].filter(Boolean),
      lang,
      isListKind(kind) ? undefined : reservedLoopNames,
    );
    if (!name) continue;
    if (
      !isListKind(kind) &&
      looksLikeFillValue(plain) &&
      nameEqualsSourceValue(name, plain)
    ) {
      continue;
    }
    if (!isListKind(kind) && reservedLoopNames.has(name)) continue;

    const boolArms =
      kind === "bool"
        ? normalizeBoolArms(row.trueText ?? row.true_text, row.falseText ?? row.false_text)
        : { trueText: "", falseText: "" };
    const trueText = boolArms.trueText;
    const falseText = boolArms.falseText;

    let accepted: AiTagSuggestion | null = null;
    /** Scalar replace may match many locations from one AI row. */
    const acceptedMany: AiTagSuggestion[] = [];

    if (isListKind(kind)) {
      const starts = findOccurrenceStarts(plainText, plain);
      if (!starts.length) continue;
      for (const occ of pickOccurrenceOrder(starts, row.occurrence ?? row.occ)) {
        const start = starts[occ]!;
        const end = start + plain.length;
        // list branch (unchanged body below uses start/end/occ/plain)
        const rowSpan = xml ? tryPlainSpanOfTableRow(xml, start, end) : null;
        let resolvedKind: AiTagDraftKind;
        let occupyStart = start;
        let occupyEnd = end;
        let wrapPlain = plain;
        let wrapPlainStart = start;
        let matchedParaHint: ParagraphListHint | null = null;

        if (rowSpan) {
          // In a table row → must be list-table on the prototype row only.
          if (tableRowRoleForSpan(xml, start, end, prototypes) !== "prototype") {
            continue;
          }
          const proto = prototypeForSpan(rowSpan.start, rowSpan.end);
          if (proto && usedPrototypeTables.has(proto.tableIndex)) continue;
          resolvedKind = "list-table";
          occupyStart = rowSpan.start;
          occupyEnd = rowSpan.end;
          // Always wrap the WHOLE row — never leave plainText as a lone "1".
          wrapPlain = plainText.slice(occupyStart, occupyEnd);
          wrapPlainStart = occupyStart;
        } else if (kind === "list-table") {
          // Claimed table row but not in <w:tr> — skip (don't silently become paragraph list).
          continue;
        } else {
          // Never turn a table-row span into a stray paragraph-list wrap.
          if (
            allDataRows.some((r) => start < r.plainEnd && end > r.plainStart) ||
            prototypes.some((p) => start < p.plainEnd && end > p.plainStart)
          ) {
            continue;
          }
          // Paragraph / bullet list — first repeating unit only (hint-clamped).
          const resolved = resolveParagraphListWrapSpan(start, end, paraListHints);
          if (!resolved) continue;
          const stemBlocked =
            (resolved.hint && usedParaListStems.has(resolved.hint.stem)) ||
            paraListHints.some(
              (h) =>
                usedParaListStems.has(h.stem) &&
                start >= h.plainStart &&
                start < h.groupEnd,
            );
          if (stemBlocked) continue;

          occupyStart = resolved.start;
          occupyEnd = resolved.end;
          matchedParaHint = resolved.hint;
          if (occupyStart !== start || occupyEnd !== end) {
            wrapPlain = plainText.slice(occupyStart, occupyEnd);
            wrapPlainStart = occupyStart;
            if (!wrapPlain) continue;
          }
          resolvedKind = "list";
        }

        if (!wrapSpanAllowed(occupyStart, occupyEnd, occupied)) continue;

        const tag = buildTag(resolvedKind, name, "", "");
        const closeTag = "{{/}}";
        if (validateListOpenTag(tag) || validateListCloseTag(closeTag)) continue;

        const wrapOccurrence = softWraps.filter((w) => w.wrapTag === tag).length;
        // Recompute occurrence when we clamped to a different plain span.
        let wrapOcc = occ;
        if (wrapPlain !== plain || wrapPlainStart !== start) {
          const wrapStarts = findOccurrenceStarts(plainText, wrapPlain);
          const idx = wrapStarts.indexOf(wrapPlainStart);
          wrapOcc = idx >= 0 ? idx : 0;
        }
        {
          const protoForWrap =
            resolvedKind === "list-table" && rowSpan
              ? prototypeForSpan(rowSpan.start, rowSpan.end)
              : null;
          accepted = {
            plainText: wrapPlain,
            occurrence: wrapOcc,
            plainStart: wrapPlainStart,
            name,
            kind: resolvedKind,
            tag,
            mode: resolvedKind === "list-table" ? "wrap-row" : "wrap",
            closeTag,
            ...(rowSpan
              ? { rowPlainStart: rowSpan.start, rowPlainEnd: rowSpan.end }
              : {}),
            ...(protoForWrap
              ? {
                  tableIndex: protoForWrap.tableIndex,
                  rowIndexInTable: protoForWrap.rowIndexInTable,
                }
              : {}),
          };
          occupied.push({ start: occupyStart, end: occupyEnd, soft: true });
          softWraps.push({
            start: occupyStart,
            end: occupyEnd,
            soft: true,
            wrapTag: tag,
            wrapOccurrence,
            name,
            ...(protoForWrap ? { tableIndex: protoForWrap.tableIndex } : {}),
          });
          if (protoForWrap) usedPrototypeTables.add(protoForWrap.tableIndex);
        }
        if (resolvedKind === "list") {
          const hint =
            matchedParaHint ||
            paraListHints.find(
              (h) => occupyStart === h.plainStart && occupyEnd === h.plainEnd,
            ) ||
            paraListHints.find(
              (h) => occupyStart >= h.plainStart && occupyEnd <= h.plainEnd,
            ) ||
            null;
          if (hint) {
            usedParaListStems.add(hint.stem);
            // Do NOT hard-occupy later units — deterministic enrich must still
            // tag fill-ins in defendants/parties 2…n when AI output is partial.
          }
        }
        break;
      }
    } else if (fillEmpty) {
      if (kind === "text" || kind === "bool" || kind === "auto") {
        const starts = findOccurrenceStarts(plainText, plain);
        for (const occ of pickOccurrenceOrder(starts, row.occurrence ?? row.occ)) {
          const start = starts[occ]!;
          const end = start + plain.length;
          const ci = Number(row.cellIndex ?? row.cell_index ?? row.tcIndex);
          if (!Number.isFinite(ci) || ci < 0) continue;
          const rowSpan = xml ? tryPlainSpanOfTableRow(xml, start, end) : null;
          if (!rowSpan) continue;
          // fill-empty-tc only on the first data/prototype row.
          if (tableRowRoleForSpan(xml, rowSpan.start, rowSpan.end, prototypes) !== "prototype") {
            continue;
          }
          const hint =
            matchEmptyHint(emptyHints, plain, start, end, ci) ||
            matchEmptyHint(emptyHints, plain, rowSpan.start, rowSpan.end, ci);
          if (!hint) {
            // AI pointed at a cellIndex with a row anchor but hint scan missed
            // (headerless / non-empty sample) — still allow if inside a list-table soft wrap.
            const parent = findParentWrap(softWraps, rowSpan.start, rowSpan.end);
            if (!parent) continue;
            const key = `wrap:${parent.wrapTag}:${parent.wrapOccurrence}:${ci}`;
            if (usedCells.has(key)) continue;
            const wrapTi =
              typeof parent.tableIndex === "number"
                ? parent.tableIndex
                : prototypes.find(
                    (pr) =>
                      rowSpan.start >= pr.plainStart &&
                      rowSpan.end <= pr.plainEnd,
                  )?.tableIndex;
            const fieldKind = coerceFieldKindForWrap(
              kind,
              softWraps,
              rowSpan.start,
              rowSpan.end,
              {
                cellIndex: ci,
                // Empty cell — run detection uses column evidence / index.
                cellText: null,
                header: headerHintEarly || null,
                isRunColumn: isRunCol(wrapTi, ci),
              },
            );
            const tag = buildTag(fieldKind, name, trueText, falseText);
            if (validateTag(tag)) continue;
            accepted = {
              plainText: plain,
              occurrence: occ,
              plainStart: start,
              name,
              kind: fieldKind,
              tag,
              mode: "fill-empty-tc",
              cellIndex: ci,
              wrapTag: parent.wrapTag,
              wrapOccurrence: parent.wrapOccurrence,
              ...(fieldKind === "bool" ? { trueText, falseText } : {}),
            };
            usedCells.add(key);
            break;
          }
          const key = cellKey(hint.tableIndex, hint.rowIndexInTable, hint.cellIndex);
          if (usedCells.has(key)) continue;
          const parent = findParentWrap(softWraps, hint.plainStart, hint.plainEnd);
          const fieldKind = coerceFieldKindForWrap(
            kind,
            softWraps,
            hint.plainStart,
            hint.plainEnd,
            {
              cellIndex: hint.cellIndex,
              cellText: null,
              header: hint.header || headerHintEarly || null,
              isRunColumn: isRunCol(hint.tableIndex, hint.cellIndex),
            },
          );
          const tag = buildTag(fieldKind, name, trueText, falseText);
          if (validateTag(tag)) continue;
          accepted = {
            plainText: hint.rowAnchor,
            occurrence: hint.occurrence,
            plainStart: hint.plainStart,
            name,
            kind: fieldKind,
            tag,
            mode: "fill-empty-tc",
            cellIndex: hint.cellIndex,
            tableIndex: hint.tableIndex,
            rowIndexInTable: hint.rowIndexInTable,
            headerHint: hint.header,
            ...(parent
              ? { wrapTag: parent.wrapTag, wrapOccurrence: parent.wrapOccurrence }
              : {}),
            ...(fieldKind === "bool" ? { trueText, falseText } : {}),
          };
          usedCells.add(key);
          break;
        }
      }
    } else {
      // Scalar replace — apply EVERY safe hit (AI may emit one row for a VALUE that
      // appears in several places). Still skip later table sample rows / overlaps.
      const hits = resolveFieldPlainHits(
        plainText,
        plain,
        anchorLabel,
        row.occurrence ?? row.occ,
      );
      const orderedHits = [...hits].sort((a, b) => a.start - b.start);
      /** One claimed name per wrap scope — multi-occ outside wraps share one id. */
      const nameByWrapScope = new Map<string, string>();
      for (const hit of orderedHits) {
        if (out.length + acceptedMany.length >= MAX_SUGGESTIONS) break;
        const start = hit.start;
        const end = hit.end;
        const matchPlain = hit.matchedPlain;
        if (!fieldSpanAllowed(start, end, occupied)) continue;
        if (!plainDigitMatchAllowed(plainText, start, matchPlain)) continue;
        if (!plainValueTailOk(plainText, start, matchPlain)) continue;
        // Reject over-wide AI replaces of whole later paragraph-list units
        // (stem + ordinal + body). Fill-ins inside those units are enriched later.
        {
          let skipLaterUnit = false;
          for (const h of paraListHints) {
            if (!(h.groupEnd > h.plainEnd)) continue;
            if (start < h.plainEnd || start >= h.groupEnd) continue;
            if (h.stem && matchPlain.includes(h.stem)) {
              skipLaterUnit = true;
              break;
            }
            // Near-full later span is a unit dump, not a fill-in.
            if (end - start >= Math.floor((h.groupEnd - h.plainEnd) / Math.max(1, h.unitCount - 1)) * 0.75) {
              skipLaterUnit = true;
              break;
            }
          }
          if (skipLaterUnit) continue;
        }
        const role = tableRowRoleForSpan(xml, start, end, prototypes);
        // Later sample data rows stay blocked. Unique footer/total cells in the
        // same <w:tbl> (e.g. รวมทั้งสิ้น 1,116) may still tag when labeled/row
        // looks like a summary — and the value is not a prototype duplicate.
        if (role === "other") {
          // Only keep unique fill values on distinct (non-sample-shape) rows.
          if (
            !isDistinctNonSampleTableField(
              xml,
              start,
              end,
              prototypes,
              allDataRows,
            ) ||
            valueAppearsInPrototypeRows(plainText, matchPlain, prototypes)
          ) {
            continue;
          }
        }
        const parent = findParentWrap(softWraps, start, end);
        const sampleMeta = sampleHints.find(
          (h) =>
            start >= h.plainStart &&
            end <= h.plainEnd &&
            h.cellText === matchPlain,
        );
        const fieldKind = coerceFieldKindForWrap(kind, softWraps, start, end, {
          header: sampleMeta?.header || headerHintEarly || anchorLabel || null,
          cellIndex: sampleMeta?.cellIndex ?? null,
          cellText: matchPlain,
          isRunColumn: sampleMeta
            ? isRunCol(sampleMeta.tableIndex, sampleMeta.cellIndex)
            : null,
        });
        const scopeKey = parent
          ? `${parent.wrapTag}|${parent.wrapOccurrence}`
          : "";
        let hitName = nameByWrapScope.get(scopeKey);
        if (!hitName) {
          // Qualify with wrap stem so the same header across loops stays unique.
          const claimed = uniqueName(
            name,
            usedNames,
            [anchorLabel, headerHintEarly, parent?.name || ""].filter(Boolean),
            lang,
            reservedLoopNames,
          );
          if (!claimed || reservedLoopNames.has(claimed)) continue;
          hitName = claimed;
          nameByWrapScope.set(scopeKey, hitName);
          usedNames.add(hitName);
        }
        const tag = buildTag(fieldKind, hitName, trueText, falseText);
        if (validateTag(tag)) continue;

        // occurrence among identical matchPlain spans in document order
        const allStarts = findOccurrenceStarts(plainText, matchPlain);
        const occIdx = Math.max(0, allStarts.indexOf(start));
        acceptedMany.push({
          plainText: matchPlain,
          occurrence: occIdx,
          plainStart: start,
          name: hitName,
          kind: fieldKind,
          tag,
          mode: "replace",
          ...(anchorLabel ? { labelHint: anchorLabel } : {}),
          ...(parent
            ? { wrapTag: parent.wrapTag, wrapOccurrence: parent.wrapOccurrence }
            : {}),
          ...(fieldKind === "bool" ? { trueText, falseText } : {}),
        });
        occupied.push({ start, end });
        markSampleCellUsed(start, end);
      }
    }

    if (acceptedMany.length) {
      out.push(...acceptedMany);
      continue;
    }
    if (!accepted) continue;
    usedNames.add(name);
    if (isListKind(kind)) reservedLoopNames.add(name);
    out.push(accepted);
  }

  // Enrich: blank cells under meaningful headers on accepted prototype list-table rows.
  if (xml && softWraps.length && out.length < MAX_SUGGESTIONS) {
    for (const hint of emptyHints) {
      if (out.length >= MAX_SUGGESTIONS) break;
      const key = cellKey(hint.tableIndex, hint.rowIndexInTable, hint.cellIndex);
      if (usedCells.has(key)) continue;
      const parent = findParentWrap(softWraps, hint.plainStart, hint.plainEnd);
      if (!parent) continue;
      const rowHeaders = emptyHints
        .filter(
          (h) =>
            h.tableIndex === hint.tableIndex &&
            h.rowIndexInTable === hint.rowIndexInTable,
        )
        .map((h) => String(h.header || "").trim())
        .filter(Boolean);
      const baseName =
        nameFromHeaderOrLabel(hint.header, null, lang, null) ||
        structuralCellName(
          parent.name,
          hint.cellIndex,
          lang,
          hint.header,
          rowHeaders,
        );
      if (!baseName) continue;
      const name = uniqueName(
        baseName,
        usedNames,
        [hint.header, ...rowHeaders].filter(Boolean),
        lang,
        reservedLoopNames,
      );
      if (!name || reservedLoopNames.has(name)) continue;
      const tag = buildTag("text", name, "", "");
      if (validateTag(tag)) continue;
      usedNames.add(name);
      usedCells.add(key);
      out.push({
        plainText: hint.rowAnchor,
        occurrence: hint.occurrence,
        plainStart: hint.plainStart,
        name,
        kind: "text",
        tag,
        mode: "fill-empty-tc",
        cellIndex: hint.cellIndex,
        tableIndex: hint.tableIndex,
        rowIndexInTable: hint.rowIndexInTable,
        wrapTag: parent.wrapTag,
        wrapOccurrence: parent.wrapOccurrence,
        headerHint: hint.header,
      });
    }
  }

  // Enrich: non-empty prototype cells (incl. first column) under headers inside list-table.
  // wrap-row leaves cell values intact by design — tag them like the manual list-table dialog.
  if (xml && softWraps.length && out.length < MAX_SUGGESTIONS) {
    for (const hint of sampleHints) {
      if (out.length >= MAX_SUGGESTIONS) break;
      // Blank-template placeholders (—, -, •) are not sample values — leave for
      // fill-empty-tc / prototype cell walk so every column gets a distinct tag.
      if (!hint.cellText || /^[✓√✖×xX\-–—·.•]+$/u.test(hint.cellText)) continue;
      const key = cellKey(hint.tableIndex, hint.rowIndexInTable, hint.cellIndex);
      if (usedCells.has(key)) continue;
      const parent = findParentWrap(softWraps, hint.plainStart, hint.plainEnd);
      if (!parent) continue;

      const loc = findCellTextInRow(
        plainText,
        hint.cellText,
        hint.plainStart,
        hint.plainEnd,
      );
      if (loc && !fieldSpanAllowed(loc.start, loc.end, occupied)) {
        usedCells.add(key);
        continue;
      }

      const fieldKind = inferSampleFieldKind(hint.cellText, {
        header: hint.header,
        cellIndex: hint.cellIndex,
        isRunColumn: isRunCol(hint.tableIndex, hint.cellIndex),
      });
      const fieldKindFinal: AiTagDraftKind = fieldKind;
      const siblingHeaders = sampleHints
        .filter(
          (h) =>
            h.tableIndex === hint.tableIndex &&
            h.rowIndexInTable === hint.rowIndexInTable,
        )
        .map((h) => String(h.header || "").trim())
        .filter(Boolean);
      let nameBase =
        nameFromHeaderOrLabel(hint.header, null, lang, hint.cellText) ||
        structuralCellName(
          parent.name,
          hint.cellIndex,
          lang,
          hint.header,
          siblingHeaders,
        );
      if (!nameBase) continue;
      // Auto/ordinal: keep {{+}} but swap long/garbled labels for a short stem.
      if (fieldKindFinal === "auto") {
        if (looksLikeGarbledName(nameBase) || nameBase.length > 6) {
          const stem = parentNameStem(parent.name, lang);
          if (stem && !looksLikeGarbledName(stem) && stem.length <= 6) {
            nameBase = stem;
          } else {
            nameBase =
              structuralCellName(
                parent.name,
                hint.cellIndex,
                lang,
                hint.header,
                siblingHeaders,
              ) || "";
          }
        }
      }
      if (!nameBase || looksLikeGarbledName(nameBase)) continue;
      const name = uniqueName(
        nameBase,
        usedNames,
        [hint.header, ...siblingHeaders].filter(Boolean),
        lang,
        reservedLoopNames,
      );
      if (!name || reservedLoopNames.has(name)) continue;
      if (nameEqualsSourceValue(name, hint.cellText)) continue;
      if (looksLikeGarbledName(name)) continue;
      const boolArms =
        fieldKindFinal === "bool"
          ? normalizeBoolArms(hint.cellText || DEFAULT_BOOL_TRUE_TEXT, "")
          : { trueText: "", falseText: "" };
      const trueText = boolArms.trueText;
      const falseText = boolArms.falseText;
      const tag = buildTag(fieldKindFinal, name, trueText, falseText);
      if (validateTag(tag)) continue;

      // Prefer plain replace when the sample span is unique/safe; else set by cell index
      // (same fallback the manual list-table confirm uses for short "1" collisions).
      if (loc && fieldSpanAllowed(loc.start, loc.end, occupied)) {
        usedNames.add(name);
        usedCells.add(key);
        occupied.push({ start: loc.start, end: loc.end });
        out.push({
          plainText: hint.cellText,
          occurrence: loc.occurrence,
          plainStart: loc.start,
          name,
          kind: fieldKindFinal,
          tag,
          mode: "replace",
          wrapTag: parent.wrapTag,
          wrapOccurrence: parent.wrapOccurrence,
          cellIndex: hint.cellIndex,
          tableIndex: hint.tableIndex,
          rowIndexInTable: hint.rowIndexInTable,
          headerHint: hint.header,
          ...(fieldKindFinal === "bool" ? { trueText, falseText } : {}),
        });
        continue;
      }

      usedNames.add(name);
      usedCells.add(key);
      out.push({
        plainText: hint.rowAnchor,
        occurrence: hint.occurrence,
        plainStart: hint.plainStart,
        name,
        kind: fieldKindFinal,
        tag,
        mode: "fill-empty-tc",
        cellIndex: hint.cellIndex,
        tableIndex: hint.tableIndex,
        rowIndexInTable: hint.rowIndexInTable,
        wrapTag: parent.wrapTag,
        wrapOccurrence: parent.wrapOccurrence,
        headerHint: hint.header,
        ...(fieldKindFinal === "bool" ? { trueText, falseText } : {}),
      });
    }
  }

  // Coverage repair: force every prototype sample/empty cell under an accepted
  // soft wrap to be tagged (deterministic, no AI). Runs whenever any cell is
  // still missing — not only when the ratio is low.
  if (xml && softWraps.length) {
    const expectedCells = sampleHints.length + emptyHints.length;
    const taggedCells = out.filter(
      (s) =>
        (s.mode === "replace" || s.mode === "fill-empty-tc") &&
        typeof s.cellIndex === "number",
    ).length;
    if (expectedCells > 0 && taggedCells < expectedCells) {
      for (const hint of [...sampleHints, ...emptyHints]) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        const key = cellKey(hint.tableIndex, hint.rowIndexInTable, hint.cellIndex);
        if (usedCells.has(key)) continue;
        const parent = findParentWrap(softWraps, hint.plainStart, hint.plainEnd);
        if (!parent) continue;
        const rawSample =
          "cellText" in hint ? String((hint as TableSampleCellHint).cellText || "") : "";
        // Placeholder glyphs in blank templates → treat as empty (fill-empty-tc).
        const sampleText =
          rawSample && !/^[✓√✖×xX\-–—·.•]+$/u.test(rawSample) ? rawSample : "";
        const fieldKind = sampleText
          ? inferSampleFieldKind(sampleText, {
              header: hint.header,
              cellIndex: hint.cellIndex,
              isRunColumn: isRunCol(hint.tableIndex, hint.cellIndex),
            })
          : "text";
        const fieldKindFinal: AiTagDraftKind = fieldKind;
        const siblingHeaders = [...sampleHints, ...emptyHints]
          .filter(
            (h) =>
              h.tableIndex === hint.tableIndex &&
              h.rowIndexInTable === hint.rowIndexInTable,
          )
          .map((h) => String(h.header || "").trim())
          .filter(Boolean);
        let baseName =
          nameFromHeaderOrLabel(hint.header, null, lang, sampleText || null) ||
          structuralCellName(
            parent.name,
            hint.cellIndex,
            lang,
            hint.header,
            siblingHeaders,
          );
        if (!baseName) continue;
        if (
          fieldKindFinal === "auto" &&
          (looksLikeGarbledName(baseName) || baseName.length > 6)
        ) {
          const stem = parentNameStem(parent.name, lang);
          baseName =
            stem && !looksLikeGarbledName(stem) && stem.length <= 6
              ? stem
              : structuralCellName(
                  parent.name,
                  hint.cellIndex,
                  lang,
                  hint.header,
                  siblingHeaders,
                ) || "";
        }
        if (!baseName || looksLikeGarbledName(baseName)) continue;
        const name = uniqueName(
          baseName,
          usedNames,
          [hint.header, ...siblingHeaders].filter(Boolean),
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name)) continue;
        if (sampleText && nameEqualsSourceValue(name, sampleText)) continue;
        if (looksLikeGarbledName(name)) continue;
        const boolArms =
          fieldKindFinal === "bool"
            ? normalizeBoolArms(sampleText || DEFAULT_BOOL_TRUE_TEXT, "")
            : { trueText: "", falseText: "" };
        const tag = buildTag(fieldKindFinal, name, boolArms.trueText, boolArms.falseText);
        if (validateTag(tag)) continue;
        usedNames.add(name);
        usedCells.add(key);
        if (sampleText) {
          const loc = findCellTextInRow(
            plainText,
            sampleText,
            hint.plainStart,
            hint.plainEnd,
          );
          if (loc && fieldSpanAllowed(loc.start, loc.end, occupied)) {
            occupied.push({ start: loc.start, end: loc.end });
            out.push({
              plainText: sampleText,
              occurrence: loc.occurrence,
              plainStart: loc.start,
              name,
              kind: fieldKindFinal,
              tag,
              mode: "replace",
              wrapTag: parent.wrapTag,
              wrapOccurrence: parent.wrapOccurrence,
              cellIndex: hint.cellIndex,
              tableIndex: hint.tableIndex,
              rowIndexInTable: hint.rowIndexInTable,
              headerHint: hint.header,
              ...(fieldKindFinal === "bool"
                ? { trueText: boolArms.trueText, falseText: boolArms.falseText }
                : {}),
            });
            continue;
          }
        }
        out.push({
          plainText: hint.rowAnchor,
          occurrence: hint.occurrence,
          plainStart: hint.plainStart,
          name,
          kind: fieldKindFinal,
          tag,
          mode: "fill-empty-tc",
          cellIndex: hint.cellIndex,
          tableIndex: hint.tableIndex,
          rowIndexInTable: hint.rowIndexInTable,
          wrapTag: parent.wrapTag,
          wrapOccurrence: parent.wrapOccurrence,
          headerHint: hint.header,
          ...(fieldKindFinal === "bool"
            ? { trueText: boolArms.trueText, falseText: boolArms.falseText }
            : {}),
        });
      }
    }
  }

  // Ensure EVERY prototype cell under an accepted list-table wrap is tagged
  // (blank templates often lack header hints — walk the row cells directly).
  if (xml && softWraps.length) {
    /** Dash / bullet placeholders in blank templates are not real fill values. */
    const cellIsPlaceholder = (t: string) =>
      !t || /^[✓√✖×xX\-–—·.•]+$/u.test(t);
    for (const wrap of softWraps) {
      if (typeof wrap.tableIndex !== "number") continue;
      const proto = prototypes.find((p) => p.tableIndex === wrap.tableIndex);
      if (!proto) continue;
      const protoRow = allDataRows.find(
        (r) =>
          r.tableIndex === wrap.tableIndex &&
          r.rowIndexInTable === proto.rowIndexInTable,
      );
      if (!protoRow) continue;
      const rowHeaders = protoRow.headers.map((h) => String(h || "").trim());
      /** Never reuse one name for two cells in the same prototype row. */
      const usedInRow = new Set<string>();
      for (let ci = 0; ci < protoRow.cells.length; ci += 1) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        const key = cellKey(wrap.tableIndex, proto.rowIndexInTable, ci);
        if (usedCells.has(key)) continue;
        const rawCell = String(protoRow.cells[ci]?.text || "").trim();
        const placeholder = cellIsPlaceholder(rawCell);
        const cellText = placeholder ? "" : rawCell;
        const header = rowHeaders[ci] || "";
        const fieldKind = cellText
          ? inferSampleFieldKind(cellText, {
              header,
              cellIndex: ci,
              isRunColumn: isRunCol(wrap.tableIndex, ci),
            })
          : "text";
        const fieldKindFinal: AiTagDraftKind = fieldKind;
        const siblingHeaders = rowHeaders.filter((h, i) => h && i !== ci);
        let baseName =
          nameFromHeaderOrLabel(header, null, lang, cellText || null) ||
          structuralCellName(wrap.name, ci, lang, header, siblingHeaders);
        if (!baseName) continue;
        if (
          fieldKindFinal === "auto" &&
          (looksLikeGarbledName(baseName) || baseName.length > 6)
        ) {
          baseName =
            structuralCellName(wrap.name, ci, lang, header, siblingHeaders) ||
            baseName;
        }
        if (looksLikeGarbledName(baseName)) continue;
        const rowBlocked = new Set([...usedNames, ...usedInRow]);
        const name = uniqueName(
          baseName,
          rowBlocked,
          [header, ...siblingHeaders].filter(Boolean),
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name) || usedInRow.has(name)) {
          continue;
        }
        if (cellText && nameEqualsSourceValue(name, cellText)) continue;
        const boolArms =
          fieldKindFinal === "bool"
            ? normalizeBoolArms(cellText || DEFAULT_BOOL_TRUE_TEXT, "")
            : { trueText: "", falseText: "" };
        const tag = buildTag(
          fieldKindFinal,
          name,
          boolArms.trueText,
          boolArms.falseText,
        );
        if (validateTag(tag)) continue;
        usedNames.add(name);
        usedInRow.add(name);
        usedCells.add(key);
        if (cellText) {
          const loc = findCellTextInRow(
            plainText,
            cellText,
            protoRow.plainStart,
            protoRow.plainEnd,
          );
          if (loc && fieldSpanAllowed(loc.start, loc.end, occupied)) {
            occupied.push({ start: loc.start, end: loc.end });
            out.push({
              plainText: cellText,
              occurrence: loc.occurrence,
              plainStart: loc.start,
              name,
              kind: fieldKindFinal,
              tag,
              mode: "replace",
              wrapTag: wrap.wrapTag,
              wrapOccurrence: wrap.wrapOccurrence,
              cellIndex: ci,
              tableIndex: wrap.tableIndex,
              rowIndexInTable: proto.rowIndexInTable,
              headerHint: header || undefined,
              ...(fieldKindFinal === "bool"
                ? {
                    trueText: boolArms.trueText,
                    falseText: boolArms.falseText,
                  }
                : {}),
            });
            continue;
          }
        }
        out.push({
          plainText: protoRow.rowAnchor || plainText.slice(proto.plainStart, proto.plainEnd),
          occurrence: protoRow.occurrence >= 0 ? protoRow.occurrence : 0,
          plainStart: protoRow.plainStart,
          name,
          kind: fieldKindFinal,
          tag,
          mode: "fill-empty-tc",
          cellIndex: ci,
          tableIndex: wrap.tableIndex,
          rowIndexInTable: proto.rowIndexInTable,
          wrapTag: wrap.wrapTag,
          wrapOccurrence: wrap.wrapOccurrence,
          headerHint: header || undefined,
          ...(fieldKindFinal === "bool"
            ? { trueText: boolArms.trueText, falseText: boolArms.falseText }
            : {}),
        });
      }
    }
  }

  // After list-table wraps: delete every later row except the trailing fixed
  // block (subtotal / VAT / total / note) and other distinct non-sample rows.
  if (xml && usedPrototypeTables.size) {
    const protoRowByTable = new Map(
      prototypes.map((pr) => [pr.tableIndex, pr.rowIndexInTable]),
    );
    for (const row of allDataRows) {
      if (!usedPrototypeTables.has(row.tableIndex)) continue;
      const protoRi = protoRowByTable.get(row.tableIndex);
      if (typeof protoRi !== "number") continue;
      if (row.rowIndexInTable <= protoRi) continue;
      const protoRow = allDataRows.find(
        (r) =>
          r.tableIndex === row.tableIndex && r.rowIndexInTable === protoRi,
      );
      if (!protoRow) continue;
      const tableRows = allDataRows.filter((r) => r.tableIndex === row.tableIndex);
      const maxRi = Math.max(...tableRows.map((r) => r.rowIndexInTable));
      const trailStart =
        trailingFixedStart.get(row.tableIndex) ?? Number.POSITIVE_INFINITY;
      const inTrailer = row.rowIndexInTable >= trailStart;
      if (
        !shouldDeleteLaterSampleRow(protoRow.cells, row.cells, {
          isAtTableEnd: row.rowIndexInTable === maxRi,
          isNearEnd: inTrailer || row.rowIndexInTable >= maxRi - 1,
        })
      ) {
        continue;
      }
      // Never delete the trailing totals/VAT/note block.
      if (inTrailer) continue;
      const rowText = plainText.slice(row.plainStart, row.plainEnd);
      out.push({
        plainText: row.rowAnchor || rowText.slice(0, 80) || `row_${row.rowIndexInTable}`,
        occurrence: row.occurrence >= 0 ? row.occurrence : 0,
        plainStart: row.plainStart >= 0 ? row.plainStart : 0,
        name: `delete_tr_${row.tableIndex}_${row.rowIndexInTable}`,
        kind: "delete-tr",
        tag: "",
        mode: "delete-tr",
        tableIndex: row.tableIndex,
        rowIndexInTable: row.rowIndexInTable,
      });
    }
  }

  // Tag unique amounts / fill values on kept later rows (summary / distinct fixed).
  if (xml && prototypes.length && out.length < MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) {
    const protoRowByTable = new Map(
      prototypes.map((pr) => [pr.tableIndex, pr.rowIndexInTable]),
    );
    const deletedKeys = new Set(
      out
        .filter((s) => s.mode === "delete-tr")
        .map((s) => `${s.tableIndex}:${s.rowIndexInTable}`),
    );
    for (const row of allDataRows) {
      const protoRi = protoRowByTable.get(row.tableIndex);
      if (typeof protoRi !== "number" || row.rowIndexInTable <= protoRi) continue;
      if (deletedKeys.has(`${row.tableIndex}:${row.rowIndexInTable}`)) continue;
      const protoRow = allDataRows.find(
        (r) =>
          r.tableIndex === row.tableIndex && r.rowIndexInTable === protoRi,
      );
      if (!protoRow) continue;
      const tableRows = allDataRows.filter((r) => r.tableIndex === row.tableIndex);
      const maxRi = Math.max(...tableRows.map((r) => r.rowIndexInTable));
      const trailStart =
        trailingFixedStart.get(row.tableIndex) ?? Number.POSITIVE_INFINITY;
      const inTrailer = row.rowIndexInTable >= trailStart;
      if (
        shouldDeleteLaterSampleRow(protoRow.cells, row.cells, {
          isAtTableEnd: row.rowIndexInTable === maxRi,
          isNearEnd: inTrailer || row.rowIndexInTable >= maxRi - 1,
        }) &&
        !inTrailer
      ) {
        continue;
      }
      for (let ci = 0; ci < row.cells.length; ci += 1) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        const cellText = String(row.cells[ci]?.text || "").trim();
        if (!cellText) continue;
        if (valueAppearsInPrototypeRows(plainText, cellText, prototypes)) continue;
        const loc = findCellTextInRow(
          plainText,
          cellText,
          row.plainStart,
          row.plainEnd,
        );
        if (!loc || !fieldSpanAllowed(loc.start, loc.end, occupied)) continue;
        // Prefer prototype/table headers — later rows often inherit prior body
        // cells as "headers" which must not become field names (e.g. GammaWidget).
        const header =
          protoRow.headers[ci] || row.headers[ci] || "";
        // Label from column header, else a non-amount sibling cell on this row
        // (totals label / baht-text sitting beside the amount).
        const siblingLabel = row.cells
          .map((c) => String(c.text || "").trim())
          .find(
            (t) =>
              t &&
              t !== cellText &&
              !cellLooksLikeAmount(t) &&
              !/\d/.test(t),
          );
        const labelFallback = siblingLabel || "";
        // Caption cells beside an amount stay fixed (Total / VAT label with %).
        // Never overwrite rate/caption labels — only tag value cells.
        const hasAmountSibling = row.cells.some(
          (c, j) => j !== ci && cellLooksLikeAmount(String(c.text || "")),
        );
        // Short captions / rate labels stay fixed; long baht-text / notes are values.
        const looksLikeCaption =
          !cellLooksLikeAmount(cellText) &&
          (/%/.test(cellText) ||
            /\(\s*\d/.test(cellText) ||
            (!/\d/.test(cellText) &&
              cellText.length >= 2 &&
              cellText.length <= 24));
        if (hasAmountSibling && looksLikeCaption) {
          continue;
        }
        // Standalone caption-only cells with a rate marker are never fill values.
        if (/%/.test(cellText) && !cellLooksLikeAmount(cellText)) {
          continue;
        }
        // Note / baht-text rows: a long non-amount cell with no rate marker is a value.
        // Prefer free sibling totals/VAT caption for amounts; else column header.
        // Never sample text. If the sibling name is already taken (baht-text field),
        // fall back so the amount still gets a distinct name.
        const fromHeader = nameFromHeaderOrLabel(header, null, lang, cellText);
        const fromSibling =
          siblingLabel
            ? nameFromHeaderOrLabel(siblingLabel, header, lang, cellText)
            : null;
        let baseName = fromHeader || fromSibling || null;
        if (
          cellLooksLikeAmount(cellText) &&
          fromSibling &&
          !usedNames.has(fromSibling) &&
          !reservedLoopNames.has(fromSibling)
        ) {
          baseName = fromSibling;
        }
        if (!baseName) continue;
        if (nameEqualsSourceValue(baseName, cellText)) continue;
        if (looksLikeFillValue(baseName) || /\d{3,}/.test(baseName)) continue;
        const name = uniqueName(
          baseName,
          usedNames,
          [header, labelFallback].filter((x) => x && !looksLikeFillValue(x)),
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name)) continue;
        if (nameEqualsSourceValue(name, cellText)) continue;
        const tag = buildTag("text", name, "", "");
        if (validateTag(tag)) continue;
        usedNames.add(name);
        occupied.push({ start: loc.start, end: loc.end });
        out.push({
          plainText: cellText,
          occurrence: loc.occurrence,
          plainStart: loc.start,
          name,
          kind: "text",
          tag,
          mode: "replace",
          cellIndex: ci,
          tableIndex: row.tableIndex,
          rowIndexInTable: row.rowIndexInTable,
          headerHint: header || undefined,
        });
      }
    }
  }

  // Enrich: letterhead/footer phones & emails the model often skips.
  enrichContactFieldsFromPlain(plainText, out, occupied, usedNames, lang);
  // Structural label→value pairs (tabs / multi-space), incl. letterhead addresses.
  enrichLabelFollowedValuesFromPlain(plainText, out, occupied, usedNames, lang);

  // One checkbox glyph pair per document.
  unifyDocumentBoolArms(out);

  // Ensure paragraph-list wraps have first-unit fill-ins (digits + unique tokens)
  // so they are not dropped as empty wraps when the model omitted inners.
  if (xml && paraListHints.length && softWraps.length) {
    const WORD_TOK = /[\u0E00-\u0E7FA-Za-z]{2,80}/u;
    const matchWords = (span: string) =>
      span.match(new RegExp(WORD_TOK.source, "gu")) || [];
    const escapeRe = (s: string) =>
      String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const hint of paraListHints) {
      const parent = softWraps.find(
        (w) => w.start === hint.plainStart && w.end === hint.plainEnd,
      );
      if (!parent) continue;
      const unitStarts: number[] = [hint.plainStart];
      if (hint.stem) {
        const anchorRe = new RegExp(
          `${escapeRe(hint.stem)}\\s*[0-9๐-๙]+`,
          "gu",
        );
        const group = plainText.slice(hint.plainStart, hint.groupEnd);
        let am: RegExpExecArray | null;
        while ((am = anchorRe.exec(group)) !== null) {
          const abs = hint.plainStart + am.index;
          if (abs > hint.plainStart) unitStarts.push(abs);
        }
      }
      unitStarts.push(hint.groupEnd);
      const unitTexts = unitStarts.slice(0, -1).map((s, i) =>
        plainText.slice(s, unitStarts[i + 1]),
      );
      if (!unitTexts.length) continue;
      const shared = new Set<string>();
      {
        const sets = unitTexts.map((t) => new Set(matchWords(t)));
        if (sets.length) {
          for (const tok of sets[0]!) {
            if (sets.every((s) => s.has(tok))) shared.add(tok);
          }
        }
      }
      const firstStart = unitStarts[0]!;
      const firstEnd = unitStarts[1]!;
      const firstText = plainText.slice(firstStart, firstEnd);
      const labelBeforeFirst = (at: number): string | null => {
        const before = firstText.slice(0, Math.max(0, at));
        const toks = matchWords(before);
        for (let i = toks.length - 1; i >= 0; i -= 1) {
          const t = toks[i]!;
          if (shared.has(t) || (hint.stem && t === hint.stem)) return t;
        }
        return null;
      };
      // Leading / ordinal digit → auto; name from the label immediately before it.
      const digitRe = /[0-9๐-๙]+/gu;
      let dm: RegExpExecArray | null;
      while ((dm = digitRe.exec(firstText)) !== null) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        if (dm[0].length > 2) continue;
        const start = firstStart + dm.index;
        const end = start + dm[0].length;
        if (!fieldSpanAllowed(start, end, occupied)) continue;
        const lbl = labelBeforeFirst(dm.index);
        // Prefer a short shared label that is NOT the loop name itself.
        let base =
          (lbl && lbl !== parent.name && lbl !== hint.stem
            ? nameFromHeaderOrLabel(lbl, null, lang, dm[0])
            : null) ||
          parentNameStem(parent.name, lang);
        if (!base || looksLikeGarbledName(base) || reservedLoopNames.has(base)) {
          // Fall back to any other shared label in the unit.
          base = null;
          for (const s of shared) {
            if (s === hint.stem || s === parent.name) continue;
            const n = nameFromHeaderOrLabel(s, null, lang, dm[0]);
            if (n && !looksLikeGarbledName(n) && !reservedLoopNames.has(n)) {
              base = n;
              break;
            }
          }
        }
        if (!base) continue;
        const name = uniqueName(
          base,
          usedNames,
          [lbl, hint.stem, parent.name].filter(Boolean) as string[],
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name)) continue;
        const tag = buildTag("auto", name, "", "");
        if (validateTag(tag)) continue;
        const allStarts = findOccurrenceStarts(plainText, dm[0]);
        const occIdx = Math.max(0, allStarts.indexOf(start));
        usedNames.add(name);
        occupied.push({ start, end });
        out.push({
          plainText: dm[0],
          occurrence: occIdx,
          plainStart: start,
          name,
          kind: "auto",
          tag,
          mode: "replace",
          wrapTag: parent.wrapTag,
          wrapOccurrence: parent.wrapOccurrence,
        });
      }
      const wordScan = new RegExp(WORD_TOK.source, "gu");
      let tm: RegExpExecArray | null;
      while ((tm = wordScan.exec(firstText)) !== null) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        const tok = tm[0];
        if (tok.length < 4) continue;
        if (shared.has(tok)) continue;
        if (hint.stem && (tok === hint.stem || tok.startsWith(hint.stem))) {
          continue;
        }
        const start = firstStart + tm.index;
        const end = start + tok.length;
        if (!fieldSpanAllowed(start, end, occupied)) continue;
        const lbl = labelBeforeFirst(tm.index);
        const base =
          nameFromHeaderOrLabel(lbl, hint.stem, lang, tok) ||
          nameFromHeaderOrLabel(hint.stem, null, lang, tok);
        if (!base || looksLikeGarbledName(base)) continue;
        const name = uniqueName(
          base,
          usedNames,
          [lbl, hint.stem, parent.name].filter(Boolean) as string[],
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name)) continue;
        if (nameEqualsSourceValue(name, tok)) continue;
        const tag = buildTag("text", name, "", "");
        if (validateTag(tag)) continue;
        const allStarts = findOccurrenceStarts(plainText, tok);
        const occIdx = Math.max(0, allStarts.indexOf(start));
        usedNames.add(name);
        occupied.push({ start, end });
        out.push({
          plainText: tok,
          occurrence: occIdx,
          plainStart: start,
          name,
          kind: "text",
          tag,
          mode: "replace",
          wrapTag: parent.wrapTag,
          wrapOccurrence: parent.wrapOccurrence,
        });
      }
    }
  }

  // Tag fill-ins in paragraph-list units 2…n (defendants/parties after the wrap).
  // Keyword-free: tokens shared with the first unit are structural labels; tokens
  // unique to later units are fill values. Names come from the nearest shared
  // label to the left — never dotted/numeric suffixes.
  if (xml && paraListHints.length) {
    // Non-global for .match(); a separate /g instance is used for .exec() loops
    // so .match() cannot reset lastIndex and infinite-loop the scanner.
    const WORD_TOK = /[\u0E00-\u0E7FA-Za-z]{2,80}/u;
    const collectToks = (span: string): string[] =>
      span.match(new RegExp(WORD_TOK.source, "gu")) || [];
    const escapeRe = (s: string) =>
      String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labelBefore = (
      unitText: string,
      at: number,
      shared: ReadonlySet<string>,
    ): string | null => {
      const before = unitText.slice(0, Math.max(0, at));
      const toks = before.match(new RegExp(WORD_TOK.source, "gu")) || [];
      for (let i = toks.length - 1; i >= 0; i -= 1) {
        const t = toks[i]!;
        if (shared.has(t)) return t;
      }
      return null;
    };
    for (const hint of paraListHints) {
      // Skip hints that live inside a table (list-table owns those).
      if (
        allDataRows.some(
          (r) => hint.plainStart < r.plainEnd && hint.plainEnd > r.plainStart,
        )
      ) {
        continue;
      }
      if (!(hint.groupEnd > hint.plainEnd)) continue;
      const firstUnit = plainText.slice(hint.plainStart, hint.plainEnd);
      const firstTokSet = new Set(collectToks(firstUnit));
      const parentWrap = softWraps.find(
        (w) => w.start === hint.plainStart && w.end === hint.plainEnd,
      );

      const unitStarts: number[] = [hint.plainStart];
      if (hint.stem) {
        const anchorRe = new RegExp(
          `${escapeRe(hint.stem)}\\s*[0-9๐-๙]+`,
          "gu",
        );
        const group = plainText.slice(hint.plainStart, hint.groupEnd);
        let am: RegExpExecArray | null;
        while ((am = anchorRe.exec(group)) !== null) {
          const abs = hint.plainStart + am.index;
          if (abs > hint.plainStart) unitStarts.push(abs);
        }
      }
      unitStarts.push(hint.groupEnd);

      // Labels shared across every unit → stable name sources.
      const unitTexts = unitStarts.slice(0, -1).map((s, i) =>
        plainText.slice(s, unitStarts[i + 1]),
      );
      const sharedLabels = new Set<string>();
      {
        const sets = unitTexts.map((t) => new Set(collectToks(t)));
        if (sets.length) {
          for (const tok of sets[0]!) {
            if (sets.every((s) => s.has(tok))) sharedLabels.add(tok);
          }
        }
      }

      for (let ui = 1; ui < unitStarts.length - 1; ui += 1) {
        const uStart = unitStarts[ui]!;
        const uEnd = unitStarts[ui + 1]!;
        if (!(uEnd > uStart)) continue;
        const unitText = plainText.slice(uStart, uEnd);

        const idRe = /\d{1,2}-\d{4}-\d{5}-\d{2}-\d|\d{5,13}/g;
        let im: RegExpExecArray | null;
        while ((im = idRe.exec(unitText)) !== null) {
          if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
          const start = uStart + im.index;
          const end = start + im[0].length;
          if (!fieldSpanAllowed(start, end, occupied)) continue;
          if (!plainDigitMatchAllowed(plainText, start, im[0])) continue;
          const lbl = labelBefore(unitText, im.index, sharedLabels);
          const base =
            nameFromHeaderOrLabel(lbl, hint.stem, lang, im[0]) ||
            nameFromHeaderOrLabel(hint.stem, null, lang, im[0]);
          if (!base || looksLikeGarbledName(base)) continue;
          const name = uniqueName(
            base,
            usedNames,
            [lbl, hint.stem].filter(Boolean) as string[],
            lang,
            reservedLoopNames,
          );
          if (!name || reservedLoopNames.has(name)) continue;
          const tag = buildTag("text", name, "", "");
          if (validateTag(tag)) continue;
          const allStarts = findOccurrenceStarts(plainText, im[0]);
          const occIdx = Math.max(0, allStarts.indexOf(start));
          usedNames.add(name);
          occupied.push({ start, end });
          out.push({
            plainText: im[0],
            occurrence: occIdx,
            plainStart: start,
            name,
            kind: "text",
            tag,
            mode: "replace",
            wrapTag: parentWrap?.wrapTag,
            wrapOccurrence: parentWrap?.wrapOccurrence,
          });
        }

        const wordScan = new RegExp(WORD_TOK.source, "gu");
        let tm: RegExpExecArray | null;
        while ((tm = wordScan.exec(unitText)) !== null) {
          if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
          const tok = tm[0];
          if (tok.length < 4) continue;
          if (firstTokSet.has(tok)) continue;
          if (hint.stem && (tok === hint.stem || tok.startsWith(hint.stem))) {
            continue;
          }
          const start = uStart + tm.index;
          const end = start + tok.length;
          if (!fieldSpanAllowed(start, end, occupied)) continue;
          const lbl = labelBefore(unitText, tm.index, sharedLabels);
          const base =
            nameFromHeaderOrLabel(lbl, hint.stem, lang, tok) ||
            nameFromHeaderOrLabel(hint.stem, null, lang, tok);
          if (!base || looksLikeGarbledName(base)) continue;
          const name = uniqueName(
            base,
            usedNames,
            [lbl, hint.stem].filter(Boolean) as string[],
            lang,
            reservedLoopNames,
          );
          if (!name || reservedLoopNames.has(name)) continue;
          if (nameEqualsSourceValue(name, tok)) continue;
          const tag = buildTag("text", name, "", "");
          if (validateTag(tag)) continue;
          const allStarts = findOccurrenceStarts(plainText, tok);
          const occIdx = Math.max(0, allStarts.indexOf(start));
          usedNames.add(name);
          occupied.push({ start, end });
          out.push({
            plainText: tok,
            occurrence: occIdx,
            plainStart: start,
            name,
            kind: "text",
            tag,
            mode: "replace",
            wrapTag: parentWrap?.wrapTag,
            wrapOccurrence: parentWrap?.wrapOccurrence,
          });
        }
      }
    }
  }

  // Never emit a list/list-table wrap with zero inner fields: build inners from
  // the loop row's cells first; only drop the wrap if that still yields nothing.
  {
    const emptyWraps = out.filter((s) => {
      if (s.mode !== "wrap" && s.mode !== "wrap-row") return false;
      return !out.some(
        (inner) =>
          inner.wrapTag === s.tag &&
          (inner.wrapOccurrence ?? 0) === s.occurrence,
      );
    });
    for (const wrap of emptyWraps) {
      const cellPool = [...sampleHints, ...emptyHints].filter((h) => {
        const parent = findParentWrap(softWraps, h.plainStart, h.plainEnd);
        return (
          !!parent &&
          parent.wrapTag === wrap.tag &&
          parent.wrapOccurrence === wrap.occurrence
        );
      });
      for (const hint of cellPool) {
        if (out.length >= MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK) break;
        const key = cellKey(hint.tableIndex, hint.rowIndexInTable, hint.cellIndex);
        if (usedCells.has(key)) continue;
        const sampleText =
          "cellText" in hint
            ? String((hint as TableSampleCellHint).cellText || "")
            : "";
        const header = String(hint.header || "").trim();
        const siblingHeaders = [...sampleHints, ...emptyHints]
          .filter(
            (h) =>
              h.tableIndex === hint.tableIndex &&
              h.rowIndexInTable === hint.rowIndexInTable,
          )
          .map((h) => String(h.header || "").trim())
          .filter(Boolean);
        const baseName =
          nameFromHeaderOrLabel(header, null, lang, sampleText || null) ||
          structuralCellName(
            wrap.name,
            hint.cellIndex,
            lang,
            header,
            siblingHeaders,
          );
        if (!baseName || looksLikeGarbledName(baseName)) continue;
        const name = uniqueName(
          baseName,
          usedNames,
          [header].filter(Boolean),
          lang,
          reservedLoopNames,
        );
        if (!name || reservedLoopNames.has(name)) continue;
        if (sampleText && nameEqualsSourceValue(name, sampleText)) continue;
        const fieldKind = sampleText
          ? inferSampleFieldKind(sampleText, {
              header,
              cellIndex: hint.cellIndex,
              isRunColumn: isRunCol(hint.tableIndex, hint.cellIndex),
            })
          : "text";
        const boolArms =
          fieldKind === "bool"
            ? normalizeBoolArms(sampleText || DEFAULT_BOOL_TRUE_TEXT, "")
            : { trueText: "", falseText: "" };
        const tag = buildTag(
          fieldKind,
          name,
          boolArms.trueText,
          boolArms.falseText,
        );
        if (validateTag(tag)) continue;
        usedNames.add(name);
        usedCells.add(key);
        if (sampleText) {
          const loc = findCellTextInRow(
            plainText,
            sampleText,
            hint.plainStart,
            hint.plainEnd,
          );
          if (loc && fieldSpanAllowed(loc.start, loc.end, occupied)) {
            occupied.push({ start: loc.start, end: loc.end });
            out.push({
              plainText: sampleText,
              occurrence: loc.occurrence,
              plainStart: loc.start,
              name,
              kind: fieldKind,
              tag,
              mode: "replace",
              wrapTag: wrap.tag,
              wrapOccurrence: wrap.occurrence,
              cellIndex: hint.cellIndex,
              tableIndex: hint.tableIndex,
              rowIndexInTable: hint.rowIndexInTable,
              headerHint: header || undefined,
              ...(fieldKind === "bool"
                ? {
                    trueText: boolArms.trueText,
                    falseText: boolArms.falseText,
                  }
                : {}),
            });
            continue;
          }
        }
        out.push({
          plainText: hint.rowAnchor,
          occurrence: hint.occurrence,
          plainStart: hint.plainStart,
          name,
          kind: fieldKind,
          tag,
          mode: "fill-empty-tc",
          cellIndex: hint.cellIndex,
          tableIndex: hint.tableIndex,
          rowIndexInTable: hint.rowIndexInTable,
          wrapTag: wrap.tag,
          wrapOccurrence: wrap.occurrence,
          headerHint: header || undefined,
          ...(fieldKind === "bool"
            ? { trueText: boolArms.trueText, falseText: boolArms.falseText }
            : {}),
        });
      }
    }
    // Drop any wrap that still has zero inners after structural fill.
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const s = out[i]!;
      if (s.mode !== "wrap" && s.mode !== "wrap-row") continue;
      const hasInner = out.some(
        (inner) =>
          inner.wrapTag === s.tag &&
          (inner.wrapOccurrence ?? 0) === s.occurrence,
      );
      if (!hasInner) out.splice(i, 1);
    }
  }

  // Drop garbled / dotted / particle names that slipped through.
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const s = out[i]!;
    if (s.mode === "delete-tr") continue;
    if (looksLikeGarbledName(s.name)) {
      out.splice(i, 1);
    }
  }

  // Scalars must never share a loop name; drop colliding scalars.
  {
    const loopNames = new Set(
      out
        .filter((s) => s.mode === "wrap" || s.mode === "wrap-row")
        .map((s) => s.name),
    );
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const s = out[i]!;
      if (s.mode === "wrap" || s.mode === "wrap-row" || s.mode === "delete-tr") {
        continue;
      }
      if (loopNames.has(s.name)) out.splice(i, 1);
    }
  }

  // Different fill values must not reuse one variable name (keep earliest).
  // Same name under different wraps is also a collision (cross-loop reuse).
  {
    const firstPlainByName = new Map<string, string>();
    const firstWrapByName = new Map<string, string>();
    for (let i = 0; i < out.length; i += 1) {
      const s = out[i]!;
      if (s.mode === "wrap" || s.mode === "wrap-row" || s.mode === "delete-tr") {
        continue;
      }
      const wrapKey = `${s.wrapTag || ""}|${s.wrapOccurrence ?? ""}`;
      const prevPlain = firstPlainByName.get(s.name);
      const prevWrap = firstWrapByName.get(s.name);
      if (prevPlain !== undefined && prevPlain !== s.plainText) {
        out.splice(i, 1);
        i -= 1;
        continue;
      }
      if (prevWrap !== undefined && prevWrap !== wrapKey) {
        out.splice(i, 1);
        i -= 1;
        continue;
      }
      if (prevPlain === undefined) firstPlainByName.set(s.name, s.plainText);
      if (prevWrap === undefined) firstWrapByName.set(s.name, wrapKey);
    }
  }

  out.sort((a, b) => {
    // Apply deletes after wraps/fields at the same locus; stable by plainStart.
    if (a.plainStart !== b.plainStart) return a.plainStart - b.plainStart;
    const rank = (s: AiTagSuggestion) =>
      s.mode === "delete-tr" ? 2 : s.mode === "wrap-row" || s.mode === "wrap" ? 0 : 1;
    const rd = rank(a) - rank(b);
    if (rd) return rd;
    const ac = typeof a.cellIndex === "number" ? a.cellIndex : -1;
    const bc = typeof b.cellIndex === "number" ? b.cellIndex : -1;
    return ac - bc;
  });
  return out;
}

/** Force every bool suggestion to share one true/false glyph pair. */
export function unifyDocumentBoolArms(suggestions: AiTagSuggestion[]): void {
  const bools = suggestions.filter((s) => s.kind === "bool");
  if (!bools.length) return;
  const pair = normalizeBoolArms(bools[0]!.trueText, bools[0]!.falseText);
  for (const s of bools) {
    s.trueText = pair.trueText;
    s.falseText = pair.falseText;
    s.tag = buildTag("bool", s.name, pair.trueText, pair.falseText);
  }
}

/**
 * Seed phone/email spans when the model omitted letterhead contacts.
 * Does not override occupied spans; never shards digits inside a longer number.
 */
function enrichContactFieldsFromPlain(
  plainText: string,
  out: AiTagSuggestion[],
  occupied: OccupiedSpan[],
  usedNames: Set<string>,
  lang: AiTagNameLanguage,
): void {
  if (!plainText) return;
  const softMax = MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK;

  const phoneStemRe =
    /(?:โทร(?:ศัพท์)?\.?|Tel\.?|เบอร์(?:โทร(?:ศัพท์)?)?)/giu;
  let stem: RegExpExecArray | null;
  while ((stem = phoneStemRe.exec(plainText)) !== null) {
    if (out.length >= softMax) break;
    const label = stem[0];
    let after = skipPlainSeparators(plainText, stem.index + label.length);
    // OCR/typo noise between stem and digits (e.g. เบอร์โทรศัทย์ 02-…).
    if (!/[0-9]/.test(plainText[after] || "")) {
      const window = plainText.slice(after, after + 24);
      const nearby = window.search(/[0-9]{1,3}[\-\s]?[0-9]/);
      if (nearby < 0) continue;
      after += nearby;
    }
    // Phone / comma-list body: digits with optional separators.
    const bodyMatch = plainText
      .slice(after)
      .match(/^([0-9][0-9\-\/.,\u00A0 ]{5,}[0-9])/);
    if (!bodyMatch) continue;
    let body = bodyMatch[1]!.replace(/[\u00A0]+/g, " ").trimEnd();
    body = body.replace(/[\s.]+$/u, "");
    if (!/[0-9].*[0-9]/.test(body)) continue;
    const start = after;
    const end = after + body.length;
    if (!fieldSpanAllowed(start, end, occupied)) continue;
    if (!plainValueTailOk(plainText, start, body)) continue;
    const base =
      resolveVarName(lang === "en" ? "phone" : "โทรศัพท์", lang) ||
      (lang === "en" ? "phone" : "โทรศัพท์");
    const name = uniqueName(base, usedNames, [label], lang);
    if (!name) continue;
    const tag = buildTag("text", name, "", "");
    if (validateTag(tag)) continue;
    const allStarts = findOccurrenceStarts(plainText, body);
    const occIdx = Math.max(0, allStarts.indexOf(start));
    usedNames.add(name);
    occupied.push({ start, end });
    out.push({
      plainText: body,
      occurrence: occIdx,
      plainStart: start,
      name,
      kind: "text",
      tag,
      mode: "replace",
      labelHint: label.replace(/ศัทย์.*$/u, "").trim() || label,
    });
  }

  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let em: RegExpExecArray | null;
  while ((em = emailRe.exec(plainText)) !== null) {
    if (out.length >= softMax) break;
    const email = em[0];
    const start = em.index;
    const end = start + email.length;
    if (!fieldSpanAllowed(start, end, occupied)) continue;
    const base =
      resolveVarName(lang === "en" ? "email" : "อีเมล", lang) ||
      (lang === "en" ? "email" : "อีเมล");
    const name = uniqueName(base, usedNames, ["Email"], lang);
    if (!name) continue;
    const tag = buildTag("text", name, "", "");
    if (validateTag(tag)) continue;
    const allStarts = findOccurrenceStarts(plainText, email);
    const occIdx = Math.max(0, allStarts.indexOf(start));
    usedNames.add(name);
    occupied.push({ start, end });
    out.push({
      plainText: email,
      occurrence: occIdx,
      plainStart: start,
      name,
      kind: "text",
      tag,
      mode: "replace",
      labelHint: "Email",
    });
  }
}

/**
 * Seed label-followed fill-ins the model skipped (letterhead addresses, case
 * numbers, short captions with a value after tabs/multi-space). Keyword-free:
 * short stem + separator run + longer value to line end.
 */
function enrichLabelFollowedValuesFromPlain(
  plainText: string,
  out: AiTagSuggestion[],
  occupied: OccupiedSpan[],
  usedNames: Set<string>,
  lang: AiTagNameLanguage,
): void {
  if (!plainText) return;
  const softMax = MAX_SUGGESTIONS + CONTACT_ENRICH_SLACK;
  // Bounded classes — avoid nested unbounded quantifiers / catastrophic backtracking.
  const re =
    /(^|[\n\r])([^\t\n\r]{2,28})([\t \u00A0]{2,8}|\t+)([^\t\n\r]{3,96})/gu;
  let m: RegExpExecArray | null;
  let guard = 0;
  const maxHits = 400;
  while ((m = re.exec(plainText)) !== null) {
    guard += 1;
    if (guard > maxHits) break;
    if (out.length >= softMax) break;
    // Advance lastIndex defensively if the engine stalled.
    if (m.index === re.lastIndex) re.lastIndex += 1;
    const label = String(m[2] || "").trim();
    const value = String(m[4] || "").trim();
    if (!label || !value) continue;
    if (value.length <= label.length) continue;
    // Skip pure punctuation / checkbox-only values.
    if (/^[✓√✔☑☐□☒×✖.\-–—]+$/u.test(value)) continue;
    if (/^\d{1,2}$/.test(value) && label.length <= 4) continue;
    // Re-locate trimmed value precisely in the match window.
    const lineStart = (m.index || 0) + String(m[1] || "").length;
    const window = plainText.slice(lineStart, (m.index || 0) + m[0].length);
    const rel = window.indexOf(value);
    if (rel < 0) continue;
    const start = lineStart + rel;
    const end = start + value.length;
    if (!fieldSpanAllowed(start, end, occupied)) continue;
    if (!plainDigitMatchAllowed(plainText, start, value)) continue;
    if (!plainValueTailOk(plainText, start, value)) continue;
    const base = nameFromHeaderOrLabel(label, null, lang, value);
    if (!base) continue;
    const name = uniqueName(base, usedNames, [label], lang);
    if (!name || nameEqualsSourceValue(name, value)) continue;
    const tag = buildTag("text", name, "", "");
    if (validateTag(tag)) continue;
    const allStarts = findOccurrenceStarts(plainText, value);
    const occIdx = Math.max(0, allStarts.indexOf(start));
    usedNames.add(name);
    occupied.push({ start, end });
    out.push({
      plainText: value,
      occurrence: occIdx,
      plainStart: start,
      name,
      kind: "text",
      tag,
      mode: "replace",
      labelHint: label,
    });
  }
}

/** Count label-followed fillable static runs (whole-document coverage). */
export function countLabelFollowedFillables(plainText: string): number {
  if (!plainText) return 0;
  const re =
    /(^|[\n\r])([^\t\n\r]{2,28})([\t \u00A0]{2,8}|\t+)([^\t\n\r]{3,96})/gu;
  let n = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(plainText)) !== null && guard < 500) {
    guard += 1;
    if (m.index === re.lastIndex) re.lastIndex += 1;
    const label = String(m[2] || "").trim();
    const value = String(m[4] || "").trim();
    if (!label || !value || value.length <= label.length) continue;
    if (/^[✓√✔☑☐□☒×✖.\-–—]+$/u.test(value)) continue;
    n += 1;
  }
  return n;
}

/** 0 disables chunking. Small chunks finish within provider time budgets. */
export const AI_SUGGEST_CHUNK_CHARS_ENV = "DOCX_FORM_AI_SUGGEST_CHUNK_CHARS";
export const DEFAULT_AI_SUGGEST_CHUNK_CHARS = 16_000;
/** Serial by default — concurrent chunk calls throttle/timeout on Cursor. */
export const AI_SUGGEST_CHUNK_CONCURRENCY_ENV =
  "DOCX_FORM_AI_SUGGEST_CHUNK_CONCURRENCY";
export const DEFAULT_AI_SUGGEST_CHUNK_CONCURRENCY = 1;
export const AI_SUGGEST_CHUNK_RETRY_ENV = "DOCX_FORM_AI_SUGGEST_CHUNK_RETRY";
export const DEFAULT_AI_SUGGEST_CHUNK_RETRY = 2;

export function getAiSuggestChunkConcurrency(): number {
  return Math.max(
    1,
    Math.min(
      3,
      Number(
        String(process.env[AI_SUGGEST_CHUNK_CONCURRENCY_ENV] || "").trim() ||
          DEFAULT_AI_SUGGEST_CHUNK_CONCURRENCY,
      ) || DEFAULT_AI_SUGGEST_CHUNK_CONCURRENCY,
    ),
  );
}

export function getAiSuggestChunkRetry(): number {
  const raw = String(process.env[AI_SUGGEST_CHUNK_RETRY_ENV] || "").trim();
  if (!raw) return DEFAULT_AI_SUGGEST_CHUNK_RETRY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AI_SUGGEST_CHUNK_RETRY;
  return Math.min(4, Math.floor(n));
}

/** Hard wall budget for one suggest request — never exceed 5 minutes. */
export const DEFAULT_AI_SUGGEST_OVERALL_MS = 300_000;
/** Per-provider-call cap so main + cheap repair fit under the overall budget. */
export const DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS = 120_000;

/** Per-call timeout for suggest (single-call and chunk paths share this). */
export function getAiSuggestChunkTimeoutMs(baseTimeoutMs?: number): number {
  const base =
    typeof baseTimeoutMs === "number" && Number.isFinite(baseTimeoutMs)
      ? Math.floor(baseTimeoutMs)
      : DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS;
  // Floor and hard-cap at 120s: raise short opts, never exceed the per-call wall.
  // Remaining-budget trimming happens at each callSuggestProvider site.
  return Math.min(
    DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS,
    Math.max(DEFAULT_AI_SUGGEST_CALL_TIMEOUT_MS, Math.max(0, base)),
  );
}

/** Alias — same timeout applies to the single-call (<16k) path. */
export function getAiSuggestCallTimeoutMs(baseTimeoutMs?: number): number {
  return getAiSuggestChunkTimeoutMs(baseTimeoutMs);
}

export function getAiSuggestOverallBudgetMs(baseTimeoutMs?: number): number {
  void baseTimeoutMs;
  return DEFAULT_AI_SUGGEST_OVERALL_MS;
}

export type ChunkCallOutcome = {
  index: number;
  chars: number;
  ok: boolean;
  attempts: number;
  durationMs: number;
  errorClass?: string;
};

export function getAiSuggestChunkChars(): number {
  const raw = String(process.env[AI_SUGGEST_CHUNK_CHARS_ENV] || "").trim();
  if (raw === "") return DEFAULT_AI_SUGGEST_CHUNK_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AI_SUGGEST_CHUNK_CHARS;
  if (n === 0) return 0;
  return Math.min(Math.floor(n), PLAIN_PROMPT_MAX);
}

/** Split TAGGER_PLAIN on soft boundaries for graceful large-doc degrade. */
export function splitPlainTextChunks(
  plainText: string,
  chunkChars: number,
): string[] {
  const text = String(plainText || "");
  if (!chunkChars || text.length <= chunkChars) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + chunkChars);
    if (end < text.length) {
      const window = text.slice(i, end);
      // Prefer break on whitespace / Thai sentence end near the tail.
      const rel = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf("\t"),
        window.lastIndexOf(" "),
        window.lastIndexOf("。"),
        window.lastIndexOf("ฯ"),
      );
      if (rel >= Math.floor(chunkChars * 0.5)) end = i + rel + 1;
    }
    const piece = text.slice(i, end);
    if (piece) chunks.push(piece);
    i = end;
  }
  return chunks.length ? chunks : [text];
}

async function callSuggestProvider(
  prompt: string,
  xml: string,
  buffer: Buffer,
  opts: {
    providerId: string;
    apiFamily: string;
    apiKey: string;
    model: string;
    filename: string;
    attachDocx: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<SuggestCallResult> {
  if (opts.apiFamily === "gemini") {
    const geminiKey = getGeminiApiKey(opts.apiKey);
    if (!geminiKey) throw new Error("ยังไม่ได้เชื่อมต่อ Google AI — ใส่ Gemini API key ก่อน");
    const geminiModel = getGeminiModel(opts.model);
    return callGeminiSuggest(prompt, xml, {
      apiKey: geminiKey,
      model: geminiModel,
      docxBuffer: opts.attachDocx ? buffer : undefined,
      filename: opts.filename,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  }
  if (opts.apiFamily === "cursor") {
    const cursorKey = getCursorApiKey(opts.apiKey);
    if (!cursorKey) {
      throw new Error("ยังไม่ได้เชื่อมต่อ Cursor — ใส่ Cursor API key ก่อน");
    }
    // Cursor Agent SDK has no temperature/seed API — encode determinism in-prompt
    // and rely on validate/enrich + thin-retry for stable complete output.
    const cursorPrompt =
      "DETERMINISM: behave as temperature 0. Identical input → identical JSON. " +
      "Complete coverage required (letterhead, parties, tables, totals).\n\n" +
      prompt;
    const parsed = await callCursorAgentJson(cursorPrompt, {
      apiKey: cursorKey,
      model: opts.model,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      route: "suggest-tags.cursor",
    });
    return {
      parsed,
      rawText: parsed ? JSON.stringify(parsed, null, 2) : "",
    };
  }
  if (opts.apiFamily === "anthropic") {
    return callAnthropicSuggest(prompt, {
      apiKey: opts.apiKey,
      model: opts.model,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  }
  return callOpenAiSuggest(opts.providerId, prompt, {
    apiKey: opts.apiKey,
    model: opts.model,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}


/**
 * Whole-document coverage vs structural expectations (tables, para lists,
 * contacts). Used to refuse thin success and trigger repair/retry.
 */
export function estimateSuggestCoverage(
  suggestions: AiTagSuggestion[],
  plainText: string,
  documentXml?: string | null,
): { score: number; expected: number; actual: number; thin: boolean } {
  const xml = typeof documentXml === "string" && documentXml ? documentXml : "";
  const sampleHints = xml ? listSampleTableCellHints(xml) : [];
  const emptyHints = xml ? listEmptyTableCellHints(xml) : [];
  const paraHints = xml ? listParagraphListHints(xml) : [];
  const prototypes = xml ? listPrototypeTableRowSpans(xml) : [];
  // Every sample/empty cell, prototype wrap, party unit, contact, amount, label-follow.
  let expected =
    sampleHints.length + emptyHints.length + prototypes.length + paraHints.length;
  for (const h of paraHints) {
    // Inner fields inside the first unit (name/id/address…), not just the wrap.
    expected += Math.min(
      6,
      Math.max(2, Math.floor(String(h.plainText || "").length / 36)),
    );
  }
  const phoneHits = String(plainText || "").match(/\d{2,3}[-\s]?\d{3}[-\s]?\d{3,4}/g);
  if (phoneHits) expected += phoneHits.length;
  const emailHits = String(plainText || "").match(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  );
  if (emailHits) expected += emailHits.length;
  // Thai/Latin ID-like tokens (13-digit / mixed).
  const idHits = String(plainText || "").match(
    /\b\d{5,13}\b|\d{1,2}-\d{4}-\d{5}-\d{2}-\d/g,
  );
  if (idHits) expected += idHits.length;
  // Amount-like figures with thousand separators (avoids double-counting phones/IDs).
  const amountHits = String(plainText || "").match(
    /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?/g,
  );
  if (amountHits) expected += amountHits.length;
  // Count every label-followed fillable — no artificial cap.
  expected += countLabelFollowedFillables(plainText);
  // Kept later rows (summary / distinct fixed) — at least one fill per such row.
  if (xml) {
    const allRows = listAllDataTableRows(xml);
    for (const p of prototypes) {
      const proto = allRows.find(
        (r) => r.tableIndex === p.tableIndex && r.rowIndexInTable === p.rowIndexInTable,
      );
      if (!proto) continue;
      const tableRows = allRows.filter((r) => r.tableIndex === p.tableIndex);
      const maxRi = Math.max(...tableRows.map((r) => r.rowIndexInTable));
      for (const row of tableRows) {
        if (row.rowIndexInTable <= p.rowIndexInTable) continue;
        if (
          shouldDeleteLaterSampleRow(proto.cells, row.cells, {
            isAtTableEnd: row.rowIndexInTable === maxRi,
            isNearEnd: row.rowIndexInTable >= maxRi - 1,
          })
        ) {
          continue;
        }
        expected += Math.max(1, countFilledCells(row.cells));
      }
    }
  }
  const actual = suggestions.filter((s) => s.mode !== "delete-tr").length;
  const score = expected > 0 ? actual / Math.max(1, expected) : 1;
  // Refuse thin success: below ~85% of whole-doc expectations (≈33/50 is thin).
  const thin = expected >= 4 && (score < 0.85 || actual + 2 < expected);
  return { score, expected, actual, thin };
}

/** Merge raw AI suggestion rows by plainStart/plainText position (union). */
export function mergeSuggestionRowsByPosition(
  ...batches: Record<string, unknown>[][]
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const batch of batches) {
    for (const row of batch) {
      const plain = String(row.plainText ?? row.text ?? "").trim();
      const occ = Number(row.occurrence ?? row.occ ?? 0) || 0;
      const kind = String(row.kind ?? "text");
      const key = `${kind}|${plain}|${occ}|${String(row.cellIndex ?? "")}`;
      if (!plain || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= MAX_SUGGESTIONS) return out;
    }
  }
  return out;
}

export async function suggestTemplateTags(
  buffer: Buffer,
  opts?: AiTagDraftOpts,
): Promise<{
  suggestions: AiTagSuggestion[];
  plainText: string;
  /** Parsed JSON object from the model, before validate/enrich. */
  rawAi: Record<string, unknown> | null;
  /** Exact model text (may include fences); empty when unavailable. */
  rawText: string;
  /** Surfaced when coverage stays thin after repair/retry. */
  warning?: string;
  coverage?: { score: number; expected: number; actual: number; thin: boolean };
}> {
  const provider = getAiProvider(opts?.provider) || getAiProvider("google")!;
  assertFormAiSupported(provider);
  const apiKey = String(opts?.apiKey || "").trim();
  const model = String(opts?.model || "").trim();
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");
  if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");
  const nameLanguage = parseAiTagNameLanguage(opts?.nameLanguage);

  const plainText = await extractTaggerPlainText(buffer);
  if (!plainText.trim()) {
    throw new Error("เอกสารไม่มีข้อความให้ AI ดราฟตัวแปร");
  }
  const xml = await docxDocumentXml(buffer);
  const filename = String(opts?.filename || "document.docx");
  const plainTruncated = plainText.length > PLAIN_PROMPT_MAX;
  const xmlTruncated = xml.length > XML_PROMPT_MAX;
  const xmlSnippet = xml.slice(0, XML_PROMPT_MAX);
  const emptyCellHints = listEmptyTableCellHints(xml);
  const sampleCellHints = listSampleTableCellHints(xml);
  const paragraphListHints = listParagraphListHints(xml);
  const isGemini = provider.apiFamily === "gemini";
  const attachDocx =
    isGemini &&
    buffer.byteLength > 0 &&
    buffer.byteLength <= DOCX_ATTACH_MAX_BYTES;

  const suggestCallTimeoutMs = getAiSuggestCallTimeoutMs(opts?.timeoutMs);
  const overallBudgetMs = getAiSuggestOverallBudgetMs(opts?.timeoutMs);
  const budgetDeadline = Date.now() + overallBudgetMs;
  const remainingBudgetMs = () => Math.max(0, budgetDeadline - Date.now());
  /** Hold budget so a thin first pass still gets a cheap repair call. */
  const REPAIR_RESERVE_MS = 55_000;
  let reserveRepairBudget = true;
  /** Cap every provider call by per-call wall AND remaining overall budget. */
  const cappedCallTimeoutMs = (preferred?: number) => {
    const base = preferred ?? suggestCallTimeoutMs;
    const left = remainingBudgetMs();
    const usable = reserveRepairBudget
      ? Math.max(0, left - REPAIR_RESERVE_MS)
      : left;
    if (usable < 5_000) return 0;
    return Math.min(base, usable);
  };
  // Overall abort fires at the hard 300s wall so in-flight calls detach.
  const overallGate = createAiTimeoutController(
    opts?.signal,
    overallBudgetMs,
  );
  const callOpts = {
    providerId: provider.id,
    apiFamily: provider.apiFamily,
    apiKey,
    model,
    filename,
    attachDocx,
    signal: overallGate.signal,
    timeoutMs: suggestCallTimeoutMs,
  };

  const buildPromptForPlain = (plainSlice: string, truncated: boolean) =>
    buildSuggestPrompt({
      filename,
      plainText: plainSlice,
      xmlSnippet,
      includeXmlInline: isGemini,
      emptyCellHints,
      sampleCellHints,
      paragraphListHints,
      nameLanguage,
      plainTruncated: truncated,
      xmlTruncated,
      docxAttached: attachDocx,
    });

  const runFull = (timeoutMs?: number) => {
    const ms = cappedCallTimeoutMs(timeoutMs ?? suggestCallTimeoutMs);
    if (ms < 5_000) {
      return Promise.reject(new AiTimeoutError());
    }
    return callSuggestProvider(
      buildPromptForPlain(plainText, plainTruncated),
      xml,
      buffer,
      {
        ...callOpts,
        timeoutMs: ms,
      },
    );
  };

  let singleCallTimedOut = false;
  let singleCallPartial = false;

  const chunkOutcomes: ChunkCallOutcome[] = [];
  const failedChunkIndexes: number[] = [];

  const runOneChunk = async (
    i: number,
    chunk: string,
    chunkChars: number,
  ): Promise<{
    rows: Record<string, unknown>[];
    rawText: string;
    parsed: Record<string, unknown> | null;
  }> => {
    const retries = getAiSuggestChunkRetry();
    const chunkTimeout = getAiSuggestChunkTimeoutMs(callOpts.timeoutMs);
    // Slim prompts: only hints overlapping this chunk; no full XML on chunks.
    const c0 = plainText.indexOf(chunk);
    const cStart = c0 >= 0 ? c0 : 0;
    const cEnd = cStart + chunk.length;
    const overlap = (start: number, end: number) =>
      end > cStart && start < cEnd;
    const slimPrompt = buildSuggestPrompt({
      filename,
      plainText: chunk,
      xmlSnippet: "",
      includeXmlInline: false,
      emptyCellHints: emptyCellHints.filter((h) =>
        overlap(h.plainStart, h.plainEnd),
      ),
      sampleCellHints: sampleCellHints.filter((h) =>
        overlap(h.plainStart, h.plainEnd),
      ),
      paragraphListHints: paragraphListHints.filter((h) =>
        overlap(h.plainStart, h.groupEnd || h.plainEnd),
      ),
      nameLanguage,
      plainTruncated: chunk.length >= chunkChars,
      xmlTruncated: false,
      docxAttached: false,
    });
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (opts?.signal?.aborted || overallGate.signal.aborted) break;
      const ms = cappedCallTimeoutMs(chunkTimeout);
      if (ms < 5_000) break;
      const t0 = Date.now();
      try {
        const part = await callSuggestProvider(slimPrompt, xml, buffer, {
          ...callOpts,
          attachDocx: false,
          timeoutMs: ms,
        });
        const durationMs = Date.now() - t0;
        chunkOutcomes.push({
          index: i,
          chars: chunk.length,
          ok: true,
          attempts: attempt + 1,
          durationMs,
        });
        logAiCall({
          route: "template/suggest-tags/chunk",
          provider: provider.id,
          model,
          durationMs,
          outcome: "ok",
          phase: `chunk_${i + 1}_attempt_${attempt + 1}`,
        });
        return {
          rows: normalizeRawSuggestions(part.parsed),
          rawText: part.rawText || "",
          parsed: part.parsed,
        };
      } catch (err) {
        lastErr = err;
        const durationMs = Date.now() - t0;
        const timedOut = isAiTimeoutError(err);
        const retryable = timedOut || isRetryableAiError(err);
        logAiCall({
          route: "template/suggest-tags/chunk",
          provider: provider.id,
          model,
          durationMs,
          outcome: timedOut ? "timeout" : "error",
          errorClass: timedOut
            ? "AI_TIMEOUT"
            : err instanceof Error
              ? err.name
              : "Error",
          phase: `chunk_${i + 1}_attempt_${attempt + 1}`,
        });
        if (!retryable || attempt >= retries) break;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    const errClass =
      lastErr && isAiTimeoutError(lastErr)
        ? "AI_TIMEOUT"
        : lastErr instanceof Error
          ? lastErr.name
          : "Error";
    chunkOutcomes.push({
      index: i,
      chars: chunk.length,
      ok: false,
      attempts: retries + 1,
      durationMs: 0,
      errorClass: errClass,
    });
    failedChunkIndexes.push(i);
    return { rows: [], rawText: `/* chunk_${i + 1}_failed:${errClass} */`, parsed: null };
  };

  const runChunked = async (): Promise<SuggestCallResult> => {
    const chunkChars = getAiSuggestChunkChars() || DEFAULT_AI_SUGGEST_CHUNK_CHARS;
    const chunks = splitPlainTextChunks(plainText, chunkChars);
    const rawParts: string[] = new Array(chunks.length).fill("");
    const batchRows: Record<string, unknown>[][] = new Array(chunks.length)
      .fill(null)
      .map(() => []);
    let lastParsed: Record<string, unknown> | null = null;
    let next = 0;
    const worker = async () => {
      while (true) {
        if (opts?.signal?.aborted) return;
        if (remainingBudgetMs() < 5_000) return;
        const i = next;
        next += 1;
        if (i >= chunks.length) return;
        const result = await runOneChunk(i, chunks[i]!, chunkChars);
        rawParts[i] = result.rawText;
        if (result.parsed) lastParsed = result.parsed;
        batchRows[i] = result.rows;
      }
    };
    const pool = Math.min(
      getAiSuggestChunkConcurrency(),
      Math.max(1, chunks.length),
    );
    await Promise.all(Array.from({ length: pool }, () => worker()));
    // Any chunk never started (budget) counts as failed.
    for (let i = 0; i < chunks.length; i += 1) {
      if (!chunkOutcomes.some((o) => o.index === i)) {
        failedChunkIndexes.push(i);
        chunkOutcomes.push({
          index: i,
          chars: chunks[i]!.length,
          ok: false,
          attempts: 0,
          durationMs: 0,
          errorClass: "BUDGET",
        });
        rawParts[i] = `/* chunk_${i + 1}_failed:BUDGET */`;
      }
    }
    const merged = mergeSuggestionRowsByPosition(...batchRows);
    return {
      parsed: { ...(lastParsed || {}), suggestions: merged },
      rawText: rawParts.filter(Boolean).join("\n\n"),
    };
  };

  const chunkChars = getAiSuggestChunkChars();
  // Prefer chunks early — full-doc prompts are the main timeout source.
  const preferChunkFirst =
    chunkChars > 0 && plainText.length > chunkChars;

  let callResult: SuggestCallResult | null = null;
  if (preferChunkFirst) {
    callResult = await runChunked();
  } else {
    // Single-call path (< chunk size, often <16k): longer timeout + budget;
    // on timeout return partial (deterministic enrich) instead of failing thrice.
    try {
      callResult = await runFull(suggestCallTimeoutMs);
    } catch (err) {
      if (isAiTimeoutError(err) || isRetryableAiError(err)) {
        singleCallTimedOut = isAiTimeoutError(err);
        singleCallPartial = true;
        logAiCall({
          route: "template/suggest-tags/single",
          provider: provider.id,
          model,
          outcome: singleCallTimedOut ? "timeout" : "error",
          errorClass: singleCallTimedOut
            ? "AI_TIMEOUT"
            : err instanceof Error
              ? err.name
              : "Error",
          phase: "single_call_partial",
        });
        // Empty AI rows → validate still seeds wraps/contacts/totals.
        callResult = {
          parsed: { suggestions: [] },
          rawText: `/* single_call_partial:${singleCallTimedOut ? "AI_TIMEOUT" : "ERROR"} */`,
        };
      } else {
        throw err;
      }
    }
  }
  if (!callResult) {
    callResult = {
      parsed: { suggestions: [] },
      rawText: "/* no_provider_response */",
    };
    singleCallPartial = true;
  }

  const finalize = (parsed: Record<string, unknown> | null, rawText: string) => {
    const suggestions = validateAiTagSuggestions(
      plainText,
      normalizeRawSuggestions(parsed),
      xml,
      nameLanguage,
    );
    const coverage = estimateSuggestCoverage(suggestions, plainText, xml);
    return { suggestions, coverage, parsed, rawText };
  };

  let { parsed, rawText } = callResult;
  let finalized = finalize(parsed, rawText);

  // Release the repair reserve so the cheap pass can use remaining budget.
  reserveRepairBudget = false;

  // Cheap region repair: only failed/thin slices, short timeout, remaining budget.
  // Never re-run a full-document pass (that stacked past the 300s wall).
  if (
    finalized.coverage.thin &&
    !opts?.signal?.aborted &&
    !overallGate.signal.aborted &&
    remainingBudgetMs() >= 12_000
  ) {
    try {
      const repairMs = cappedCallTimeoutMs(
        Math.min(50_000, Math.max(12_000, remainingBudgetMs() - 3_000)),
      );
      if (repairMs >= 10_000) {
        const uniqueFailed = [...new Set(failedChunkIndexes)].sort(
          (a, b) => a - b,
        );
        if (preferChunkFirst && uniqueFailed.length) {
          const chunkChars =
            getAiSuggestChunkChars() || DEFAULT_AI_SUGGEST_CHUNK_CHARS;
          const chunks = splitPlainTextChunks(plainText, chunkChars);
          const repairBatches: Record<string, unknown>[][] = [];
          for (const i of uniqueFailed.slice(0, 3)) {
            if (remainingBudgetMs() < 10_000) break;
            const chunk = chunks[i];
            if (!chunk) continue;
            const repaired = await runOneChunk(i, chunk, chunkChars);
            if (repaired.rows.length) repairBatches.push(repaired.rows);
          }
          if (repairBatches.length) {
            const mergedRaw = mergeSuggestionRowsByPosition(
              normalizeRawSuggestions(parsed),
              ...repairBatches,
            );
            const retried = finalize(
              { ...(parsed || {}), suggestions: mergedRaw },
              rawText,
            );
            if (
              retried.suggestions.length >= finalized.suggestions.length ||
              retried.coverage.score >= finalized.coverage.score
            ) {
              finalized = retried;
              parsed = retried.parsed;
              rawText = retried.rawText;
            }
          }
        } else {
          // Thin after a "successful" pass (or single-call): focused repair.
          const repairPrompt =
            buildPromptForPlain(plainText, plainTruncated) +
            "\n\nCHEAP REPAIR: prior pass was thin. Emit ONLY missing fill-ins " +
            "(every prototype table cell, totals/VAT/note values, party id/name in units 2…n). " +
            "Names from headers/labels only — no dotted or numeric suffixes. " +
            "Return a compact JSON suggestions array — do not rewrite existing tags.";
          const retry = await callSuggestProvider(repairPrompt, xml, buffer, {
            ...callOpts,
            attachDocx: false,
            timeoutMs: repairMs,
          });
          const mergedRaw = mergeSuggestionRowsByPosition(
            normalizeRawSuggestions(parsed),
            normalizeRawSuggestions(retry.parsed),
          );
          const retried = finalize(
            { ...(retry.parsed || {}), suggestions: mergedRaw },
            [rawText, retry.rawText || ""].filter(Boolean).join("\n\n"),
          );
          if (
            retried.suggestions.length >= finalized.suggestions.length ||
            retried.coverage.score >= finalized.coverage.score
          ) {
            finalized = retried;
            parsed = retried.parsed;
            rawText = retried.rawText;
          }
        }
      }
    } catch {
      // Keep first pass; surface thin warning below.
    }
  }

  // Re-measure after deterministic enrich (finalize already ran validate).
  finalized = {
    ...finalized,
    coverage: estimateSuggestCoverage(finalized.suggestions, plainText, xml),
  };

  const warnParts: string[] = [];
  if (failedChunkIndexes.length) {
    const regions = [...new Set(failedChunkIndexes)]
      .sort((a, b) => a - b)
      .map((i) => `ช่วงที่ ${i + 1}`)
      .join(", ");
    warnParts.push(
      `ผล AI บางส่วน — ช่วงที่ล้มเหลว: ${regions} (${failedChunkIndexes.length} ช่วง หลังลองใหม่)`,
    );
  }
  if (singleCallPartial) {
    warnParts.push(
      singleCallTimedOut
        ? "ผล AI บางส่วน — การเรียกครั้งเดียวหมดเวลา ใช้การเติมโครงสร้างแทน"
        : "ผล AI บางส่วน — การเรียกครั้งเดียวล้มเหลว ใช้การเติมโครงสร้างแทน",
    );
  }
  // Always surface a thin/partial warning when coverage is incomplete — even if
  // every provider call "succeeded" with a sparse suggestions array.
  if (finalized.coverage.thin) {
    warnParts.push(
      `ความครอบคลุมแท็กยังบาง (${finalized.coverage.actual}/${finalized.coverage.expected}) — ตรวจหัวจดหมาย ภาคี ตาราง และยอดรวม`,
    );
  } else if (
    /partial|AI_TIMEOUT|BUDGET/i.test(rawText) &&
    !warnParts.length
  ) {
    warnParts.push(
      `ผล AI บางส่วน — ใช้การเติมโครงสร้างแทน (${finalized.coverage.actual}/${finalized.coverage.expected})`,
    );
  }
  const warning = warnParts.length ? warnParts.join(" · ") : undefined;

  if (chunkOutcomes.length) {
    const okN = chunkOutcomes.filter((o) => o.ok).length;
    logAiCall({
      route: "template/suggest-tags/chunk-summary",
      provider: provider.id,
      model,
      outcome: failedChunkIndexes.length ? "error" : "ok",
      phase: `chunks_ok_${okN}_of_${chunkOutcomes.length}`,
    });
  }

  overallGate.clear();
  return {
    suggestions: finalized.suggestions,
    plainText,
    rawAi: parsed,
    rawText,
    coverage: finalized.coverage,
    ...(warning ? { warning } : {}),
  };
}
