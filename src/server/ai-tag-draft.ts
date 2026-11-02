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

import { getGeminiApiKey, getGeminiModel } from "./ai-config";
import { callCursorAgentJson } from "./ai-cursor-agent";
import { formatProviderHttpError } from "./ai-http-errors";
import {
  assertFormAiSupported,
  getAiProvider,
  getAnthropicApiBase,
  getGeminiApiBase,
} from "./ai-providers";
import { VAR_NAME_RE as NAME_RE } from "./field-names";
import {
  extractTaggerPlainText,
  listEmptyTableCellHints,
  listParagraphListHints,
  listPrototypeTableRowSpans,
  listSampleTableCellHints,
  tryPlainSpanOfTableRow,
  validateListCloseTag,
  validateListOpenTag,
  validateTag,
  type ParagraphListHint,
  type PrototypeTableRowSpan,
  type TableEmptyCellHint,
  type TableSampleCellHint,
} from "./template-tagger";

export type AiTagDraftKind = "text" | "bool" | "auto" | "list" | "list-table";

export type AiTagSuggestion = {
  plainText: string;
  occurrence: number;
  plainStart: number;
  name: string;
  kind: AiTagDraftKind;
  tag: string;
  mode: "replace" | "wrap" | "wrap-row" | "fill-empty-tc";
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
 * โทร02-023-2599 · โทรสำนักงานใหญ่ · TelACME
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
    .trim()
    .replace(/^#+/, "")
    .replace(/^\++/, "")
    .replace(/[/\\|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\w\u0E00-\u0E7F.-]/gu, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** ASCII-only sanitize for English variable names. */
function sanitizeNameAscii(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/^\++/, "")
    .replace(/[/\\|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .toLowerCase();
}

/**
 * Common Thai form/header fragments → English snake tokens for enrichment
 * when the user asks for English variable names.
 */
const TH_HEADER_EN: ReadonlyArray<readonly [string, string]> = [
  ["เขต / อำเภอ", "district"],
  ["เขต/อำเภอ", "district"],
  ["จำเลยที่", "defendant_no"],
  ["จำลยที่", "defendant_no"], // common form typo (missing เ)
  ["โจทก์ที่", "plaintiff_no"],
  ["ลำดับที่", "seq"],
  ["หมายเลข", "number"],
  ["ที่อยู่", "address"],
  ["วันที่", "date"],
  ["เบอร์โทร", "phone"],
  ["โทรศัพท์", "phone"],
  ["อีเมล", "email"],
  ["จำเลย", "defendant"],
  ["โจทก์", "plaintiff"],
  ["ลำดับ", "seq"],
  ["ชื่อ", "name"],
  ["นามสกุล", "surname"],
  ["เขต", "district"],
  ["อำเภอ", "district"],
  ["จังหวัด", "province"],
  ["ตำบล", "subdistrict"],
  ["หมู่", "moo"],
  ["ถนน", "road"],
  ["ราคา", "price"],
  ["จำนวน", "amount"],
  ["รายการ", "items"],
  ["หมายเหตุ", "note"],
  ["ที่", "no"],
];

function englishNameFromLabel(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  const exact = TH_HEADER_EN.find(([th]) => th === s);
  if (exact) return sanitizeNameAscii(exact[1]);

  // Longest-first token replace so 「จำเลยที่」beats 「ที่」.
  const sorted = [...TH_HEADER_EN].sort((a, b) => b[0].length - a[0].length);
  for (const [th, en] of sorted) {
    if (s.includes(th)) s = s.split(th).join(`_${en}_`);
  }

  const latin = s.match(/[A-Za-z][A-Za-z0-9_]*/g);
  if (latin?.length) return sanitizeNameAscii(latin.join("_"));

  const ascii = sanitizeNameAscii(s);
  return ascii || "field";
}

function resolveVarName(raw: string, lang: AiTagNameLanguage): string {
  // Normalize a frequent form typo so chips/tags read 「จำเลยที่」.
  const normalized = String(raw || "").replace(/จำลยที่/g, "จำเลยที่");
  if (lang === "th") return sanitizeName(normalized);
  const ascii = sanitizeNameAscii(normalized);
  if (ascii && /[A-Za-z]/.test(ascii)) return ascii;
  return englishNameFromLabel(normalized);
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

function uniqueName(base: string, usedNames: Set<string>): string | null {
  let name = base;
  if (!name || !NAME_RE.test(name)) return null;
  if (!usedNames.has(name)) return name;
  let n = 2;
  while (usedNames.has(`${base}_${n}`) && n < 50) n += 1;
  name = `${base}_${n}`;
  return NAME_RE.test(name) ? name : null;
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
  Examples: defendant_no, district, seq, plaintiff_name, amount.
  From Thai headers: 「จำเลยที่」/「ลำดับ」→ defendant_no or seq; 「เขต / อำเภอ」→ district.
  Prefer short descriptive English identifiers.`;
  }
  return `- name (REQUIRED language: Thai identifiers preferred): Thai and/or Latin letters, digits, underscore, dot, hyphen only (no spaces).
  Examples: ลำดับ, เขต_อำเภอ, จำเลยที่, ชื่อ.
  From headers keep Thai when clear (「จำเลยที่」→ จำเลยที่ or ลำดับ; 「เขต / อำเภอ」→ เขต_อำเภอ).
  Prefer short descriptive names.`;
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
      : '{"plainText":"1","name":"ลำดับ","kind":"auto","mode":"replace"}';
  const listNameExample =
    opts.nameLanguage === "en" ? "defendants" : "รายการจำเลย";
  const outsideDigitExample =
    opts.nameLanguage === "en"
      ? '{"plainText":"1","name":"defendant_no","kind":"text","mode":"replace"}'
      : '{"plainText":"1","name":"จำเลยที่","kind":"text","mode":"replace"}';
  const emptyNameExample =
    opts.nameLanguage === "en" ? "district" : "เขต_อำเภอ";
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

You receive the FULL document (TAGGER_PLAIN + document.xml${opts.docxAttached ? " + original .docx" : ""}). Read all of it and decide yourself what should become form fields / list wraps. Heuristic hint blocks below are OPTIONAL aids only — they may be incomplete or wrong; override them when the document says otherwise.

Return ONLY valid JSON:
{"suggestions":[{"plainText":"exact VALUE span to replace","label":"nearby field label if any","name":"var_name","kind":"text"|"bool"|"auto"|"list"|"list-table","mode":"replace"|"wrap"|"wrap-row"|"fill-empty-tc","cellIndex":null,"trueText":"optional for bool","falseText":"optional for bool","occurrence":0}]}

Grounding (must stay true so the app can apply your tags):
- plainText MUST be an exact contiguous substring of TAGGER_PLAIN (same characters, including spaces/tabs) — EXCEPT blank table cells: mode "fill-empty-tc" with plainText = a row-anchor substring that exists in TAGGER_PLAIN (hints may suggest anchors; you may choose another valid anchor from the same prototype row if clearer).
- Do NOT invent prose that is not in TAGGER_PLAIN. Do NOT suggest text that already contains {{…}} tags.
- Max ${MAX_SUGGESTIONS} suggestions. Skip duplicates / unsafe overlaps (fields may nest fully inside a list wrap; fill-empty-tc may share a row anchor with its list-table wrap).
- occurrence is 0-based among identical plainText matches in document order (omit or 0 if unsure).
- Cover the document: emit a suggestion for every distinct fill-in VALUE you want tagged (different names/companies/phones/addresses/emails each need their own row). If the exact same VALUE string repeats in several safe places, one row is enough — the system expands it to every matching location. Do not under-suggest unique fields.
- Letterhead / footer contacts are required when present: after 「โทร」/「Tel」/「เบอร์โทรศัพท์」 tag the phone number or comma-list (e.g. 02-023-2599,096-392-3963); also tag emails like biglegal@…. Never tag a single digit inside a phone number.

How to split label vs value (use your judgment on the real text):
- When a fill-in VALUE follows a short caption/stem, set "label" to that caption exactly as in TAGGER_PLAIN and plainText to the VALUE only. VALUE may be ANY text (names, companies, addresses, amounts, phones, ids) — not only digits.
- Separators vary: Word tabs (\\t), spaces, NBSP, OR flush with NO separator. Do not assume tabs.
  Examples:
  ประเภทหนี้\\t\\tกู้ยืม → {"plainText":"กู้ยืม","label":"ประเภทหนี้",...}
  มอบหมายให้ บริษัท กฎหมาย บีไอจี จำกัด (ตัวอย่าง) → {"plainText":"บริษัท กฎหมาย บีไอจี จำกัด","label":"มอบหมายให้",...}
  มอบหมายให้บริษัท กฎหมาย บีไอจี จำกัด… (flush) → same split
  (โทร02-023-2599) / (โทร02-023-2599,02-023-2591) / (โทรสำนักงานใหญ่)
    → plainText = the value body (digits OR text); label = "โทร"
- Prefer omitting instructional tails like 「(ตัวอย่าง)」 and usually omit wrapping 「()」.

Kinds / modes (schema the app understands — pick what fits the document):
- "text" — one-off sample → {{name}} (replace), OR blank table cell (fill-empty-tc). Digits outside loops are text (e.g. ${outsideDigitExample}), never {{+name}} there.
- "bool" — checkbox-like √/✓ → {{name?true,false}}
- "auto" — ONLY run numbers INSIDE an accepted list/list-table wrap → {{+name}}. Forbidden outside loops. 「จำเลยที่」alone is never auto.
- "list" — repeating prose OUTSIDE tables: wrap the FIRST unit only (mode "wrap"). Name like "${listNameExample}". Tag inner samples inside that wrap; leave later units untagged.
- "list-table" — repeating TABLE rows: wrap ONLY the first body/data row (mode "wrap-row"). Skip headers and later sample rows. Usually also emit replace/auto/bool for each non-empty sample cell on that prototype row (incl. first column), e.g. ${nameExample}. Empty meaningful cells → fill-empty-tc with cellIndex (name e.g. ${emptyNameExample}).
- Prefer sample fill-in spots over headings/boilerplate as the replaced span (captions go in "label").
- Distinct meanings → distinct names even when values look alike: buyer vs seller address, buyer vs seller tax id, document date vs document number, party A vs party B phone. Derive names from the nearby label/role (e.g. ที่อยู่ผู้ซื้อ / ที่อยู่ผู้ขาย), never reuse one name for two roles.
- Leave fixed letterhead, court/agency titles, section headings, logos captions, and other non-editable boilerplate as plain text — do NOT turn them into variables.
- Cover typical fill blanks: end dates, signature lines, name lines, amounts, and empty table cells that a user would fill. If you intentionally skip a blank, omit it only when it is clearly instructional/boilerplate.
- Repeating table body rows MUST use kind "list-table" (wrap-row on the first data row). Do not emit a flat text tag per cell across every sample row.
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
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
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
    "";
  return { parsed: parseJsonObject(rawText), rawText };
}

async function callOpenAiSuggest(
  providerId: string,
  prompt: string,
  opts: { apiKey: string; model: string },
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
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  };
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status === 400) {
    delete body.response_format;
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
}

async function callAnthropicSuggest(
  prompt: string,
  opts: { apiKey: string; model: string },
): Promise<SuggestCallResult> {
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
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
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
 * (e.g. tagging the whole 「จำเลยที่ 1 …」block as one scalar instead of {{#list}}).
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
 * (or as a fill-empty-tc cell bound to such a wrap). Stray auto → text.
 */
function coerceFieldKindForWrap(
  kind: AiTagDraftKind,
  wraps: SoftWrapSpan[],
  start: number,
  end: number,
): AiTagDraftKind {
  if (kind !== "auto") return kind;
  return findParentWrap(wraps, start, end) ? "auto" : "text";
}

/**
 * Pure-digit needles must be a complete token — not a shard of a phone/id.
 * Rejects: "3" inside "02-023-2599", "2" in "281", "1" in "1โฉนด…".
 * Allows longer digit cells flush to Thai when Word tables omit separators
 * (e.g. "4578ปทุมธานี", "1200หนึ่งพัน…") — only block 1–2 digit row markers.
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
 * Reject only mid-token continuations. A complete phone before a list comma is OK:
 * 「02-023-2599,096-392-396」 may tag the first number alone.
 * Still blocks Latin glue (TelACME) and mid-hyphen digits (handled mainly in plainDigitMatchAllowed).
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

function inferSampleFieldKind(cellText: string): AiTagDraftKind {
  if (/^\d+$/.test(cellText)) return "auto";
  if (/^[✓√✔☑]$/u.test(cellText)) return "bool";
  return "text";
}

/** Prefer a readable list name from prototype column headers. */
function inventListTableName(
  samples: TableSampleCellHint[],
  empties: TableEmptyCellHint[],
  tableIndex: number,
  lang: AiTagNameLanguage,
): string {
  const headers = [...samples, ...empties]
    .map((h) => h.header)
    .filter((h) => !!h);
  const blob = headers.join(" ");
  if (lang === "en") {
    if (/จำเล|จำลย|defendant/i.test(blob)) return "defendants";
    if (/ทรัพย์|property/i.test(blob)) return "properties";
    if (/ค่าใช้|expense|cost/i.test(blob)) return "expenses";
    return `rows_${tableIndex + 1}`;
  }
  if (/จำเล|จำลย/.test(blob)) return "รายการจำเลย";
  if (/ทรัพย์/.test(blob)) return "รายการทรัพย์";
  if (/ค่าใช้/.test(blob)) return "รายการค่าใช้จ่าย";
  return `รายการ${tableIndex + 1}`;
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

const SUMMARY_FIELD_RE =
  /รวม(?:เป็นเงิน)?(?:ทั้งสิ้น)?|สุทธิ|ยอดรวม|ภาษี(?:มูลค่าเพิ่ม)?|vat|subtotal|grand\s*total|\btotal\b/iu;

/** Footer/total rows may tag outside the prototype; ordinary later sample rows may not. */
function isSummaryTableField(
  plainText: string,
  xml: string,
  start: number,
  end: number,
  anchorLabel: string,
  matchPlain: string,
): boolean {
  if (SUMMARY_FIELD_RE.test(anchorLabel) || SUMMARY_FIELD_RE.test(matchPlain)) {
    return true;
  }
  if (!xml) return false;
  const rowSpan = tryPlainSpanOfTableRow(xml, start, end);
  if (!rowSpan) return false;
  return SUMMARY_FIELD_RE.test(plainText.slice(rowSpan.start, rowSpan.end));
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
 * per <w:tbl>. Paragraph lists: first repeating unit only; later units hard-occupied.
 */
export function validateAiTagSuggestions(
  plainText: string,
  rawRows: Record<string, unknown>[],
  documentXml?: string | null,
  nameLanguage: AiTagNameLanguage = "th",
): AiTagSuggestion[] {
  const occupied = collectExistingTagRanges(plainText);
  const usedNames = new Set<string>();
  const out: AiTagSuggestion[] = [];
  const softWraps: SoftWrapSpan[] = [];
  const usedCells = new Set<string>();
  const xml = typeof documentXml === "string" && documentXml ? documentXml : "";
  const emptyHints = xml ? listEmptyTableCellHints(xml) : [];
  const sampleHints = xml ? listSampleTableCellHints(xml) : [];
  const prototypes = xml ? listPrototypeTableRowSpans(xml) : [];
  const paraListHints = xml ? listParagraphListHints(xml) : [];
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

  // Seed paragraph-list wraps for consecutive numbered prose blocks (จำเลยที่ 1/2/3).
  // Prepend so first-unit seeds win over over-wide model wraps (stable sort keeps
  // earlier equal-rank wraps). Soft-occupy prototype + hard-occupy later units.
  if (xml && paraListHints.length) {
    const paraSeeds: PendingRow[] = [];
    for (const h of paraListHints) {
      if (!h.plainText || !(h.plainEnd > h.plainStart)) continue;
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
  const scalarValueKey = (p: PendingRow): { len: number; labeled: number } => {
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
    return { len: value.length, labeled: label ? 1 : 0 };
  };
  pending.sort((a, b) => {
    const rank = (p: PendingRow) => (p.listLike ? 2 : p.fillEmpty ? 1 : 0);
    const rd = rank(b) - rank(a);
    if (rd) return rd;
    if (rank(a) !== 0) return 0;
    const ka = scalarValueKey(a);
    const kb = scalarValueKey(b);
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
    const nameSource = String(row.name ?? "").trim() || anchorLabel;
    const baseName = resolveVarName(nameSource, lang);
    const name = uniqueName(baseName, usedNames);
    if (!name) continue;

    const trueText =
      kind === "bool"
        ? String(row.trueText ?? row.true_text ?? "√").slice(0, 40)
        : "";
    const falseText =
      kind === "bool" ? String(row.falseText ?? row.false_text ?? "").slice(0, 40) : "";

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
        } else if (kind === "list-table") {
          // Claimed table row but not in <w:tr> — skip (don't silently become paragraph list).
          continue;
        } else {
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
        };
        occupied.push({ start: occupyStart, end: occupyEnd, soft: true });
        softWraps.push({
          start: occupyStart,
          end: occupyEnd,
          soft: true,
          wrapTag: tag,
          wrapOccurrence,
          name,
        });
        if (resolvedKind === "list-table" && rowSpan) {
          const proto = prototypeForSpan(rowSpan.start, rowSpan.end);
          if (proto) usedPrototypeTables.add(proto.tableIndex);
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
            // Hard-occupy later sample units so enrichment / stray fields cannot
            // fight the paragraph list (mirrors leaving later table rows alone).
            if (hint.groupEnd > hint.plainEnd) {
              occupied.push({ start: hint.plainEnd, end: hint.groupEnd });
            }
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
            const fieldKind = coerceFieldKindForWrap(
              kind,
              softWraps,
              rowSpan.start,
              rowSpan.end,
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
      for (const hit of orderedHits) {
        if (out.length + acceptedMany.length >= MAX_SUGGESTIONS) break;
        const start = hit.start;
        const end = hit.end;
        const matchPlain = hit.matchedPlain;
        if (!fieldSpanAllowed(start, end, occupied)) continue;
        if (!plainDigitMatchAllowed(plainText, start, matchPlain)) continue;
        if (!plainValueTailOk(plainText, start, matchPlain)) continue;
        const role = tableRowRoleForSpan(xml, start, end, prototypes);
        // Later sample data rows stay blocked. Unique footer/total cells in the
        // same <w:tbl> (e.g. รวมทั้งสิ้น 1,116) may still tag when labeled/row
        // looks like a summary — and the value is not a prototype duplicate.
        if (role === "other") {
          if (
            !isSummaryTableField(
              plainText,
              xml,
              start,
              end,
              anchorLabel,
              matchPlain,
            ) ||
            valueAppearsInPrototypeRows(plainText, matchPlain, prototypes)
          ) {
            continue;
          }
        }
        const fieldKind = coerceFieldKindForWrap(kind, softWraps, start, end);
        const tag = buildTag(fieldKind, name, trueText, falseText);
        if (validateTag(tag)) continue;

        const parent = findParentWrap(softWraps, start, end);
        // occurrence among identical matchPlain spans in document order
        const allStarts = findOccurrenceStarts(plainText, matchPlain);
        const occIdx = Math.max(0, allStarts.indexOf(start));
        acceptedMany.push({
          plainText: matchPlain,
          occurrence: occIdx,
          plainStart: start,
          name,
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
      usedNames.add(name);
      out.push(...acceptedMany);
      continue;
    }
    if (!accepted) continue;
    usedNames.add(name);
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
      const baseName =
        resolveVarName(hint.header, lang) ||
        (lang === "en" ? `col_${hint.cellIndex}` : "");
      const name = uniqueName(baseName, usedNames);
      if (!name) continue;
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

      const fieldKind = inferSampleFieldKind(hint.cellText);
      const baseName =
        resolveVarName(hint.header, lang) ||
        resolveVarName(hint.cellText, lang) ||
        (lang === "en" ? `col_${hint.cellIndex}` : "");
      const name = uniqueName(baseName, usedNames);
      if (!name) continue;
      const trueText = fieldKind === "bool" ? hint.cellText || "√" : "";
      const falseText = "";
      const tag = buildTag(fieldKind, name, trueText, falseText);
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
          kind: fieldKind,
          tag,
          mode: "replace",
          wrapTag: parent.wrapTag,
          wrapOccurrence: parent.wrapOccurrence,
          cellIndex: hint.cellIndex,
          tableIndex: hint.tableIndex,
          rowIndexInTable: hint.rowIndexInTable,
          headerHint: hint.header,
          ...(fieldKind === "bool" ? { trueText, falseText } : {}),
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
        kind: fieldKind,
        tag,
        mode: "fill-empty-tc",
        cellIndex: hint.cellIndex,
        tableIndex: hint.tableIndex,
        rowIndexInTable: hint.rowIndexInTable,
        wrapTag: parent.wrapTag,
        wrapOccurrence: parent.wrapOccurrence,
        headerHint: hint.header,
        ...(fieldKind === "bool" ? { trueText, falseText } : {}),
      });
    }
  }

  // Enrich: letterhead/footer phones & emails the model often skips.
  enrichContactFieldsFromPlain(plainText, out, occupied, usedNames, lang);

  out.sort((a, b) => {
    if (a.plainStart !== b.plainStart) return a.plainStart - b.plainStart;
    const ac = typeof a.cellIndex === "number" ? a.cellIndex : -1;
    const bc = typeof b.cellIndex === "number" ? b.cellIndex : -1;
    return ac - bc;
  });
  return out;
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
    const name = uniqueName(base, usedNames);
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
    const name = uniqueName(base, usedNames);
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

  const prompt = buildSuggestPrompt({
    filename,
    plainText,
    xmlSnippet,
    includeXmlInline: isGemini,
    emptyCellHints,
    sampleCellHints,
    paragraphListHints,
    nameLanguage,
    plainTruncated,
    xmlTruncated,
    docxAttached: attachDocx,
  });

  let callResult: SuggestCallResult = { parsed: null, rawText: "" };
  if (isGemini) {
    const geminiKey = getGeminiApiKey(apiKey);
    if (!geminiKey) throw new Error("ยังไม่ได้เชื่อมต่อ Google AI — ใส่ Gemini API key ก่อน");
    const geminiModel = getGeminiModel(model);
    callResult = await callGeminiSuggest(prompt, xml, {
      apiKey: geminiKey,
      model: geminiModel,
      docxBuffer: attachDocx ? buffer : undefined,
      filename,
    });
  } else if (provider.apiFamily === "cursor") {
    const parsed = await callCursorAgentJson(prompt, { apiKey, model });
    callResult = {
      parsed,
      rawText: parsed ? JSON.stringify(parsed, null, 2) : "",
    };
  } else if (provider.apiFamily === "anthropic") {
    callResult = await callAnthropicSuggest(prompt, { apiKey, model });
  } else {
    callResult = await callOpenAiSuggest(provider.id, prompt, {
      apiKey,
      model,
    });
  }

  const { parsed, rawText } = callResult;
  const suggestions = validateAiTagSuggestions(
    plainText,
    normalizeRawSuggestions(parsed),
    xml,
    nameLanguage,
  );
  return { suggestions, plainText, rawAi: parsed, rawText };
}
