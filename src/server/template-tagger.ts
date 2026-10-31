import JSZip from "jszip";
import { extractDocumentLayout } from "./docx-layout";
import { extractDocumentText } from "./docx-engine";

export type TagReplacement = {
  id: string;
  /** Exact plain text to find in document plain (<w:t> + <w:tab/> → \\t). */
  plainText: string;
  /** 0-based index among matches of plainText in document order. */
  occurrence: number;
  /**
   * For mode "replace": full field tag, e.g. {{name}} or {{พบ?√,x}}.
   * For mode "wrap": opening loop tag, e.g. {{#items}}.
   * For delete modes: unused (may be empty).
   */
  tag: string;
  /**
   * replace (default) — swap the range with tag.
   * wrap — insert tag at range start and closeTag at range end (keep middle text).
   * wrap-row — like wrap, but expand to the full <w:tr> that contains the range.
   * delete-p — remove the whole <w:p> that contains the range.
   * delete-tr — remove the whole <w:tr> that contains the range.
   * fill-empty-tc — set <w:tc> text to tag (by cellIndex) on the row found via plainText
   *   (empty cells or cells that can't be plain-matched, e.g. checkbox marks).
   */
  mode?: "replace" | "wrap" | "wrap-row" | "delete-p" | "delete-tr" | "fill-empty-tc";
  /** Closing loop tag for wrap modes; default {{/}}. */
  closeTag?: string;
  /** 0-based <w:tc> index for fill-empty-tc. */
  cellIndex?: number;
  /**
   * Visible DOM cell index in the preview row (no rowspan holes).
   * Used when cellIndex overshoots the real <w:tc> count on that row.
   */
  domCellIndex?: number;
  /**
   * For fill-empty-tc: wrap-row open tag that owns this cell (e.g. {{#items}}).
   * With wrapOccurrence, targets that loop's row — not the first {{#…}} in the doc.
   */
  wrapTag?: string;
  /** 0-based index among wrapTag matches in document order (after prior wraps apply). */
  wrapOccurrence?: number;
  /**
   * For delete-tr: 0-based <w:tbl> index in document order (matches preview table order).
   * With rowIndexInTable, targets a row without relying on plainText (avoids jumping tables).
   */
  tableIndex?: number;
  /**
   * For delete-tr: 0-based <w:tr> index inside that table, in the *original* document
   * (not the preview after earlier deletes in this session).
   */
  rowIndexInTable?: number;
  /**
   * @deprecated Prefer tableIndex + rowIndexInTable. Shift within the same <w:tbl> only.
   */
  rowOffset?: number;
  /**
   * Absolute start offset in document plain of the *original* document
   * (<w:t> text with <w:tab/> as \\t).
   * When set and the needle still matches there, preferred over re-scanning by occurrence
   * (stable after earlier tags in the same session).
   */
  plainStart?: number;
};

export type TagTemplateResult = {
  buffer: Buffer;
  plainText: string;
  content: string;
  layout: Awaited<ReturnType<typeof extractDocumentLayout>>["blocks"];
  /** Non-fatal issues (e.g. empty-cell fill skipped). */
  warnings?: string[];
};

type WtNode = {
  /** Inclusive start offset in concatenated plain text. */
  plainStart: number;
  /** Exclusive end offset in concatenated plain text. */
  plainEnd: number;
  /** Start index of text content inside the XML string. */
  contentStart: number;
  /** End index of text content inside the XML string. */
  contentEnd: number;
  /** Decoded text content. */
  text: string;
  openTag: string;
};

const NAME_RE = /^[\w\u0E00-\u0E7F.-]+$/u;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeXmlEntities(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function needsXmlSpace(text: string): boolean {
  return /^\s|\s$/.test(text) || text.includes("  ") || text.includes("\t");
}

function buildOpenTag(existingOpenInner: string, text: string): string {
  const inner = existingOpenInner || "";
  const hasSpace = /\bxml:space\s*=\s*["']preserve["']/.test(inner);
  if (needsXmlSpace(text) && !hasSpace) {
    return `<w:t${inner} xml:space="preserve">`;
  }
  return `<w:t${inner}>`;
}

function validateVarName(name: string, kind: string): string | null {
  const n = String(name || "").trim();
  if (!n) return `${kind}ว่างไม่ได้`;
  if (!NAME_RE.test(n)) {
    return `${kind}ใช้ได้เฉพาะตัวอักษร ตัวเลข _ . -`;
  }
  return null;
}

/** Validate a field / bool / auto tag payload (not loop wrappers). */
export function validateTag(tag: string): string | null {
  const t = String(tag || "").trim();
  if (!t) return "แท็กว่างไม่ได้";
  if (!/^\{\{[^{}]+\}\}$/.test(t)) {
    return "แท็กต้องอยู่ในรูป {{ชื่อ}} / {{+ชื่อ}} หรือ {{ชื่อ?จริง,เท็จ}}";
  }
  const inner = t.slice(2, -2).trim();
  if (!inner) return "ชื่อแท็กว่างไม่ได้";
  if (/[\u0000-\u001f]/.test(inner)) return "แท็กมีอักขระควบคุมที่ไม่อนุญาต";
  if (inner.startsWith("#") || inner.startsWith("/")) {
    return "แท็กฟิลด์ไม่ใช่แท็กลูป — ใช้โหมดลิสต์สำหรับ {{#…}}";
  }
  // Auto/runno: {{+ลำดับ}} — leading + then a normal label (engine type "auto").
  if (inner.startsWith("+")) {
    const label = inner.slice(1).trim();
    if (!label) return "ชื่อรันเลขว่างไม่ได้";
    const err = validateVarName(label, "ชื่อรันเลข");
    if (err) return err;
    return null;
  }
  const bool = /^([^?#/{}]+)\?([^,{}]*),(.*)$/.exec(inner);
  if (bool) {
    const err = validateVarName(bool[1], "ชื่อตัวแปรติ๊ก");
    if (err) return err;
    return null;
  }
  return validateVarName(inner, "ชื่อตัวแปร");
}

/** Validate {{#listName}} open tag. */
export function validateListOpenTag(tag: string): string | null {
  const t = String(tag || "").trim();
  if (!t) return "แท็กลูปว่างไม่ได้";
  const m = /^\{\{#([^{}]+)\}\}$/.exec(t);
  if (!m) return "แท็กลูปต้องอยู่ในรูป {{#ชื่อ}}";
  const name = m[1].trim();
  if (/[\u0000-\u001f]/.test(name)) return "ชื่อลิสต์มีอักขระควบคุมที่ไม่อนุญาต";
  return validateVarName(name, "ชื่อลิสต์");
}

/** Validate {{/}} or {{/name}} close tag. */
export function validateListCloseTag(tag: string): string | null {
  const t = String(tag || "").trim();
  if (!t) return "แท็กปิดลูปว่างไม่ได้";
  const m = /^\{\{\/([^{}]*)\}\}$/.exec(t);
  if (!m) return "แท็กปิดลูปต้องเป็น {{/}} หรือ {{/ชื่อ}}";
  const name = m[1].trim();
  if (!name) return null;
  if (/[\u0000-\u001f]/.test(name)) return "ชื่อลิสต์มีอักขระควบคุมที่ไม่อนุญาต";
  return validateVarName(name, "ชื่อลิสต์");
}

/** Validate list variable name alone (no braces). */
export function validateListName(name: string): string | null {
  return validateVarName(String(name || "").trim(), "ชื่อลิสต์");
}

/**
 * Walk body in document order: <w:t> runs map to editable nodes; <w:tab/>
 * becomes a literal \\t in plain (Word tab stops) so selection/matching and
 * preview spacing stay aligned. Tabs are not WtNodes — they only shift offsets.
 */
function collectWtNodes(xml: string): { nodes: WtNode[]; plainText: string } {
  const nodes: WtNode[] = [];
  let plain = "";
  let m: RegExpExecArray | null;
  // Self-closing tab OR a text run — keep in XML order.
  const re = /<w:tab\b[^>]*\/>|<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith("<w:tab")) {
      plain += "\t";
      continue;
    }
    const openInner = m[1] || "";
    const raw = m[2] || "";
    const text = decodeXmlEntities(raw);
    const contentStart = m.index + `<w:t${openInner}>`.length;
    const contentEnd = contentStart + raw.length;
    const plainStart = plain.length;
    plain += text;
    nodes.push({
      plainStart,
      plainEnd: plain.length,
      contentStart,
      contentEnd,
      text,
      openTag: `<w:t${openInner}>`,
    });
  }
  return { nodes, plainText: plain };
}

/**
 * Pure-digit needles must be a complete token — not a prefix of a longer number
 * ("2" in "281"). Short runnos also must not steal leading digits of Thai-glued
 * text ("1" in "1โฉนด…"). Longer IDs (tax / ทะเบียน) often sit flush against the
 * next Thai label with no <w:tab/> — those must still match.
 * Only the following character is checked (a digit on the left e.g. "N2"+"281"
 * → "N2281" must still allow "281").
 */
function plainMatchAllowed(haystack: string, idx: number, needle: string): boolean {
  if (!/^\d+$/.test(needle)) return true;
  const next = haystack[idx + needle.length] || "";
  if (/\d/.test(next)) return false;
  if (needle.length <= 4 && /[\u0E00-\u0E7F]/u.test(next)) return false;
  return true;
}

function indexOfPlainMatch(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1;
  let at = Math.max(0, from);
  while (at <= haystack.length) {
    const idx = haystack.indexOf(needle, at);
    if (idx < 0) return -1;
    if (plainMatchAllowed(haystack, idx, needle)) return idx;
    at = idx + 1;
  }
  return -1;
}

function findOccurrenceRange(
  plainText: string,
  needle: string,
  occurrence: number,
): { start: number; end: number } {
  if (!needle) throw new Error("ข้อความที่จะแทนที่ว่างไม่ได้");
  if (!Number.isFinite(occurrence) || occurrence < 0) {
    throw new Error("occurrence ต้องเป็นจำนวนเต็มตั้งแต่ 0");
  }
  let from = 0;
  let found = -1;
  let start = -1;
  while (from <= plainText.length) {
    const idx = indexOfPlainMatch(plainText, needle, from);
    if (idx < 0) break;
    found += 1;
    if (found === occurrence) {
      start = idx;
      break;
    }
    from = idx + Math.max(1, needle.length);
  }
  if (start < 0) {
    throw new Error(
      `ไม่พบข้อความ "${needle.slice(0, 40)}${needle.length > 40 ? "…" : ""}" (ครั้งที่ ${occurrence + 1})`,
    );
  }
  return { start, end: start + needle.length };
}

function overlappingNodes(nodes: WtNode[], start: number, end: number): WtNode[] {
  return nodes.filter((n) => n.plainEnd > start && n.plainStart < end);
}

/**
 * Nodes that touch a point (for zero-width inserts).
 * preferEnd: true → attach to the node that ends here (close tags);
 * preferEnd: false → attach to the node that starts here (open tags).
 */
function nodesAtPoint(
  nodes: WtNode[],
  point: number,
  preferEnd = false,
): WtNode[] {
  const containing = nodes.filter((n) => n.plainStart < point && n.plainEnd > point);
  if (containing.length) return containing;
  const ending = nodes.filter((n) => n.plainEnd === point && n.plainStart <= point);
  const starting = nodes.filter((n) => n.plainStart === point && n.plainEnd >= point);
  if (preferEnd) {
    if (ending.length) return [ending[ending.length - 1]];
    if (starting.length) return [starting[0]];
  } else {
    if (starting.length) return [starting[0]];
    if (ending.length) return [ending[ending.length - 1]];
  }
  return [];
}

type XmlEdit = { start: number; end: number; replacement: string };

function replaceWtContent(node: WtNode, newText: string): XmlEdit {
  const openInnerMatch = /^<w:t(\s[^>]*)?>/.exec(node.openTag);
  const openInner = openInnerMatch?.[1] || "";
  const open = buildOpenTag(openInner, newText);
  const encoded = encodeXmlEntities(newText);
  const fullStart = node.contentStart - node.openTag.length;
  const fullEnd = node.contentEnd + "</w:t>".length;
  return {
    start: fullStart,
    end: fullEnd,
    replacement: `${open}${encoded}</w:t>`,
  };
}

/**
 * Apply one replacement on document.xml, returning new xml.
 * Puts the full tag in the first overlapping run (keeps that run's w:t attrs / surrounding w:rPr),
 * clears text from subsequent overlapping runs, and preserves prefixes/suffixes.
 * Empty range (start===end) inserts tag at that point.
 */
function applyRangeReplace(
  xml: string,
  nodes: WtNode[],
  rangeStart: number,
  rangeEnd: number,
  tag: string,
  insertPreferEnd = false,
): string {
  const hit =
    rangeStart === rangeEnd
      ? nodesAtPoint(nodes, rangeStart, insertPreferEnd)
      : overlappingNodes(nodes, rangeStart, rangeEnd);
  if (!hit.length) {
    throw new Error("ช่วงข้อความไม่ตรงกับ <w:t> ในเอกสาร");
  }

  const edits: XmlEdit[] = [];

  for (let i = 0; i < hit.length; i++) {
    const node = hit[i];
    const localStart = Math.max(0, rangeStart - node.plainStart);
    const localEnd = Math.min(node.text.length, Math.max(localStart, rangeEnd - node.plainStart));
    const prefix = node.text.slice(0, localStart);
    const suffix = node.text.slice(localEnd);

    let newText: string;
    if (rangeStart === rangeEnd) {
      newText = prefix + tag + suffix;
    } else if (i === 0 && hit.length === 1) {
      newText = prefix + tag + suffix;
    } else if (i === 0) {
      newText = prefix + tag;
    } else if (i === hit.length - 1) {
      newText = suffix;
    } else {
      newText = "";
    }

    edits.push(replaceWtContent(node, newText));
  }

  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/**
 * Find the start index of the <w:tr> element that contains xmlOffset.
 * Must not match <w:trPr>, <w:trHeight>, etc.
 */
function findContainingTrOpen(xml: string, xmlOffset: number): number {
  const re = /<w:tr[\s>]/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m.index > xmlOffset) break;
    open = m.index;
  }
  return open;
}

/**
 * Find the start index of the <w:p> element that contains xmlOffset.
 * Must not match <w:pPr>, <w:pgSz>, <w:pict>, etc. — only bare <w:p …>.
 */
function findContainingPOpen(xml: string, xmlOffset: number): number {
  const re = /<w:p(?:\s[^>]*)?>/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m.index > xmlOffset) break;
    open = m.index;
  }
  return open;
}

type XmlElementSpan = {
  /** Plain-text span of all <w:t> inside the element (may be empty). */
  start: number;
  end: number;
  xmlStart: number;
  xmlEnd: number;
};

/**
 * Expand a plain-text range to the full <w:tr> that contains it.
 */
function findContainingTblOpen(xml: string, xmlOffset: number): number {
  const re = /<w:tbl[\s>]/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m.index > xmlOffset) break;
    open = m.index;
  }
  return open;
}

function listTblOpens(xml: string): number[] {
  const opens: number[] = [];
  const re = /<w:tbl[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) opens.push(m.index);
  return opens;
}

/** Absolute start indexes of <w:tr> inside a <w:tbl> that starts at tblOpen. */
function listTrOpensInTable(xml: string, tblOpen: number): number[] {
  if (tblOpen < 0) return [];
  const tblClose = xml.indexOf("</w:tbl>", tblOpen);
  if (tblClose < 0) return [];
  const slice = xml.slice(tblOpen, tblClose);
  const opens: number[] = [];
  const re = /<w:tr[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) opens.push(tblOpen + m.index);
  return opens;
}

/** Absolute start indexes of <w:tr> that belong to the same <w:tbl> as trOpen. */
function listTrOpensInSameTable(xml: string, trOpen: number): number[] {
  const tblOpen = findContainingTblOpen(xml, trOpen);
  return listTrOpensInTable(xml, tblOpen);
}

function trXmlBounds(xml: string, trOpen: number): { xmlStart: number; xmlEnd: number } {
  const trClose = xml.indexOf("</w:tr>", trOpen);
  if (trClose < 0) throw new Error("โครงสร้างแถวตารางไม่สมบูรณ์");
  return { xmlStart: trOpen, xmlEnd: trClose + "</w:tr>".length };
}

/**
 * Resolve target <w:tr> within the same table as the plain-text hit.
 * Prefer absolute rowIndexInTable; else rowOffset within that table only.
 */
function resolveTableRowXmlTarget(
  xml: string,
  trOpen: number,
  rowOffset = 0,
  rowIndexInTable?: number,
): { xmlStart: number; xmlEnd: number } {
  const opens = listTrOpensInSameTable(xml, trOpen);
  if (!opens.length) return trXmlBounds(xml, trOpen);

  if (typeof rowIndexInTable === "number" && Number.isFinite(rowIndexInTable)) {
    if (rowIndexInTable < 0 || rowIndexInTable >= opens.length) {
      throw new Error(
        `แถวที่ ${rowIndexInTable + 1} ไม่มีในตารางนี้ (มี ${opens.length} แถว) — อาจกดลบผิดตาราง`,
      );
    }
    return trXmlBounds(xml, opens[rowIndexInTable]);
  }

  if (!rowOffset) return trXmlBounds(xml, trOpen);

  let idx = -1;
  for (let i = 0; i < opens.length; i++) {
    if (opens[i] === trOpen) {
      idx = i;
      break;
    }
    if (opens[i] <= trOpen) idx = i;
  }
  if (idx < 0) throw new Error("ไม่พบแถวตารางอ้างอิง");
  const targetIdx = idx + rowOffset;
  if (targetIdx < 0 || targetIdx >= opens.length) {
    throw new Error(
      `เลื่อนแถวในตารางไม่ถึง (offset ${rowOffset}) — ไม่ข้ามไปตารางอื่น`,
    );
  }
  return trXmlBounds(xml, opens[targetIdx]);
}

/**
 * Pin a row by table + row index in the original document (no plainText lookup).
 */
function expandToTableRowByIndex(
  xml: string,
  nodes: WtNode[],
  tableIndex: number,
  rowIndexInTable: number,
  fallbackPlainStart = 0,
  fallbackPlainEnd = 0,
): XmlElementSpan {
  const tblOpens = listTblOpens(xml);
  if (tableIndex < 0 || tableIndex >= tblOpens.length) {
    throw new Error(`ไม่พบตารางที่ ${tableIndex + 1} (มี ${tblOpens.length} ตาราง)`);
  }
  const opens = listTrOpensInTable(xml, tblOpens[tableIndex]);
  if (rowIndexInTable < 0 || rowIndexInTable >= opens.length) {
    throw new Error(
      `แถวที่ ${rowIndexInTable + 1} ไม่มีในตารางที่ ${tableIndex + 1} (มี ${opens.length} แถว)`,
    );
  }
  const shifted = trXmlBounds(xml, opens[rowIndexInTable]);
  const rowNodes = nodes.filter(
    (n) => n.contentStart >= shifted.xmlStart && n.contentEnd <= shifted.xmlEnd,
  );
  if (!rowNodes.length) {
    return {
      start: fallbackPlainStart,
      end: fallbackPlainEnd,
      xmlStart: shifted.xmlStart,
      xmlEnd: shifted.xmlEnd,
    };
  }
  return {
    start: rowNodes[0].plainStart,
    end: rowNodes[rowNodes.length - 1].plainEnd,
    xmlStart: shifted.xmlStart,
    xmlEnd: shifted.xmlEnd,
  };
}

function expandToTableRow(
  xml: string,
  nodes: WtNode[],
  rangeStart: number,
  rangeEnd: number,
  requireText = true,
  rowOffset = 0,
  rowIndexInTable?: number,
  tableIndex?: number,
): XmlElementSpan {
  if (
    typeof tableIndex === "number" &&
    Number.isFinite(tableIndex) &&
    typeof rowIndexInTable === "number" &&
    Number.isFinite(rowIndexInTable)
  ) {
    return expandToTableRowByIndex(
      xml,
      nodes,
      tableIndex,
      rowIndexInTable,
      rangeStart,
      rangeEnd,
    );
  }

  const hit = overlappingNodes(nodes, rangeStart, rangeEnd);
  if (!hit.length) {
    throw new Error("ช่วงข้อความไม่อยู่ในแถวตาราง");
  }
  // Use the first overlapping node's content position to locate the row in XML.
  const anchor = hit[0].contentStart;
  const trOpen = findContainingTrOpen(xml, anchor);
  if (trOpen < 0) {
    throw new Error("ไม่พบแถวตาราง (<w:tr>) ที่ครอบข้อความที่เลือก — ลองเลือกในตาราง");
  }
  const shifted = resolveTableRowXmlTarget(xml, trOpen, rowOffset, rowIndexInTable);
  const rowNodes = nodes.filter(
    (n) => n.contentStart >= shifted.xmlStart && n.contentEnd <= shifted.xmlEnd,
  );
  const pinned =
    (typeof rowIndexInTable === "number" && Number.isFinite(rowIndexInTable)) ||
    rowOffset !== 0;
  if (!rowNodes.length) {
    if (requireText && !pinned) {
      throw new Error("แถวตารางไม่มีข้อความให้ห่อด้วยลิสต์");
    }
    // Empty target row (typical for pinned/offset delete) — plain range unused for delete.
    return {
      start: rangeStart,
      end: rangeEnd,
      xmlStart: shifted.xmlStart,
      xmlEnd: shifted.xmlEnd,
    };
  }
  return {
    start: rowNodes[0].plainStart,
    end: rowNodes[rowNodes.length - 1].plainEnd,
    xmlStart: shifted.xmlStart,
    xmlEnd: shifted.xmlEnd,
  };
}

/**
 * Expand a plain-text range to the full <w:p> that contains it.
 */
function expandToParagraph(
  xml: string,
  nodes: WtNode[],
  rangeStart: number,
  rangeEnd: number,
): XmlElementSpan {
  const hit = overlappingNodes(nodes, rangeStart, rangeEnd);
  if (!hit.length) {
    throw new Error("ช่วงข้อความไม่อยู่ในย่อหน้า");
  }
  const anchor = hit[0].contentStart;
  const pOpen = findContainingPOpen(xml, anchor);
  if (pOpen < 0) {
    throw new Error("ไม่พบย่อหน้า (<w:p>) ที่ครอบข้อความที่เลือก");
  }
  const pClose = xml.indexOf("</w:p>", anchor);
  if (pClose < 0 || pClose < pOpen) {
    throw new Error("โครงสร้างย่อหน้าไม่สมบูรณ์");
  }
  const pXmlEnd = pClose + "</w:p>".length;
  const pNodes = nodes.filter(
    (n) => n.contentStart >= pOpen && n.contentEnd <= pXmlEnd,
  );
  if (!pNodes.length) {
    return { start: rangeStart, end: rangeEnd, xmlStart: pOpen, xmlEnd: pXmlEnd };
  }
  return {
    start: pNodes[0].plainStart,
    end: pNodes[pNodes.length - 1].plainEnd,
    xmlStart: pOpen,
    xmlEnd: pXmlEnd,
  };
}

/** Cut one XML element span out of document.xml. */
function removeXmlSpan(xml: string, xmlStart: number, xmlEnd: number): string {
  if (xmlStart < 0 || xmlEnd <= xmlStart || xmlEnd > xml.length) {
    throw new Error("ช่วง XML ที่จะลบไม่ถูกต้อง");
  }
  return xml.slice(0, xmlStart) + xml.slice(xmlEnd);
}

/** Plain text of one table row slice (w:t + tabs). */
function trPlainText(trXml: string): string {
  let out = "";
  const re = /<w:tab\b[^>]*\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trXml))) {
    if (m[0].startsWith("<w:tab")) out += "\t";
    else out += decodeXmlEntities(m[1] || "");
  }
  return out;
}

/**
 * Prepend `text` to the first <w:t> inside [sliceStart, sliceEnd).
 * If the row has no text run, inject `<w:r><w:t>…</w:t></w:r>` into the first <w:p>.
 */
function prependToFirstWt(
  xml: string,
  sliceStart: number,
  sliceEnd: number,
  text: string,
): string {
  const slice = xml.slice(sliceStart, sliceEnd);
  const wt = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/.exec(slice);
  if (wt) {
    const abs = sliceStart + wt.index;
    const openInner = wt[1] || "";
    const newText = text + decodeXmlEntities(wt[2] || "");
    const open = buildOpenTag(openInner, newText);
    return (
      xml.slice(0, abs) +
      `${open}${encodeXmlEntities(newText)}</w:t>` +
      xml.slice(abs + wt[0].length)
    );
  }
  const pOpen = /<w:p[\s>]/.exec(slice);
  if (!pOpen) return xml;
  const absP = sliceStart + pOpen.index;
  const afterP = xml.indexOf(">", absP) + 1;
  const pPrEnd = xml.startsWith("<w:pPr", afterP)
    ? xml.indexOf("</w:pPr>", afterP) + "</w:pPr>".length
    : afterP;
  const run = `<w:r><w:t xml:space="preserve">${encodeXmlEntities(text)}</w:t></w:r>`;
  return xml.slice(0, pPrEnd) + run + xml.slice(pPrEnd);
}

/** Ensure <w:tblHeader/> on the first `count` rows of a table XML slice. */
function markLeadingRowsAsTblHeader(tblXml: string, count: number): string {
  if (count <= 0) return tblXml;
  let result = "";
  let rest = tblXml;
  let marked = 0;
  while (marked < count) {
    const trAt = rest.search(/<w:tr[\s>]/);
    if (trAt < 0) break;
    result += rest.slice(0, trAt);
    rest = rest.slice(trAt);
    const trEnd = rest.indexOf("</w:tr>");
    if (trEnd < 0) break;
    let tr = rest.slice(0, trEnd + "</w:tr>".length);
    rest = rest.slice(trEnd + "</w:tr>".length);
    if (!/<w:tblHeader\b/.test(tr)) {
      if (/<w:trPr\b[^>]*>/.test(tr)) {
        tr = tr.replace(/<w:trPr\b[^>]*>/, (open) => `${open}<w:tblHeader/>`);
      } else {
        tr = tr.replace(/<w:tr[\s>][^>]*>/, (open) => `${open}<w:trPr><w:tblHeader/></w:trPr>`);
      }
    }
    result += tr;
    marked += 1;
  }
  return result + rest;
}

/**
 * Last unmatched {{#name}} in XML before `tableStart` (within 2000 chars).
 * Used when a list open was left in a paragraph above the table.
 */
function findOrphanLoopOpenBefore(
  xml: string,
  tableStart: number,
): { name: string; absStart: number; absEnd: number } | null {
  const windowStart = Math.max(0, tableStart - 2000);
  const before = xml.slice(0, tableStart);
  const re = /\{\{#([^{}]+)\}\}|\{\{\/([^{}]*)\}\}/g;
  const stack: { name: string; absStart: number; absEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    if (m[0].startsWith("{{#")) {
      stack.push({
        name: m[1],
        absStart: m.index,
        absEnd: m.index + m[0].length,
      });
    } else if (stack.length) {
      stack.pop();
    }
  }
  if (!stack.length) return null;
  const last = stack[stack.length - 1];
  if (last.absStart < windowStart) return null;
  return last;
}

/**
 * List tables that only have {{/}} (no {{#…}} on the same table) look "headless"
 * in Word. Move a nearby orphan {{#name}} onto the template row (or invent one),
 * and mark rows above as tblHeader.
 */
function ensureTableLoopOpenTags(xml: string): string {
  const tables: { start: number; end: number }[] = [];
  const re = /<w:tbl[\s>][\s\S]*?<\/w:tbl>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    tables.push({ start: m.index, end: m.index + m[0].length });
  }
  let out = xml;
  for (let ti = tables.length - 1; ti >= 0; ti--) {
    let start = tables[ti].start;
    let end = tables[ti].end;
    const tblXml = out.slice(start, end);
    if (/\{\{#[^{}]*\}\}/.test(trPlainText(tblXml))) continue;

    const trRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
    const rows: { localStart: number; localEnd: number; plain: string }[] = [];
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(tblXml)) !== null) {
      rows.push({
        localStart: tr.index,
        localEnd: tr.index + tr[0].length,
        plain: trPlainText(tr[0]),
      });
    }
    const closeIdx = rows.findIndex(
      (r) => /\{\{\/\}/.test(r.plain) || /\{\{\/[^}]*\}\}/.test(r.plain),
    );
    if (closeIdx < 0) continue;
    let tmplIdx = rows.findIndex(
      (r, i) => i <= closeIdx && /\{\{[^{#/][^{}]*\}\}/.test(r.plain),
    );
    if (tmplIdx < 0) tmplIdx = closeIdx;

    const orphan = findOrphanLoopOpenBefore(out, start);
    let openTag: string;
    if (orphan) {
      openTag = `{{#${orphan.name}}}`;
      out = out.slice(0, orphan.absStart) + out.slice(orphan.absEnd);
      const delta = orphan.absEnd - orphan.absStart;
      start -= delta;
      end -= delta;
    } else {
      // Document order: first headless table → รายการ1
      openTag = `{{#รายการ${ti + 1}}}`;
    }

    const row = rows[tmplIdx];
    const absRowStart = start + row.localStart;
    const absRowEnd = start + row.localEnd;
    let next = prependToFirstWt(out, absRowStart, absRowEnd, openTag);

    const headerCount = tmplIdx;
    if (headerCount > 0) {
      const tblAt = next.indexOf("<w:tbl", start);
      const tblClose = next.indexOf("</w:tbl>", tblAt);
      if (tblAt >= 0 && tblClose > tblAt) {
        const fresh = next.slice(tblAt, tblClose + "</w:tbl>".length);
        const marked = markLeadingRowsAsTblHeader(fresh, headerCount);
        next =
          next.slice(0, tblAt) +
          marked +
          next.slice(tblClose + "</w:tbl>".length);
      }
    }
    out = next;
  }
  return out;
}

/**
 * When a table already has {{#…}} on a non-first row, mark rows above as
 * Word repeating header rows (<w:tblHeader/>).
 */
function ensureTableListHeaders(xml: string): string {
  const tables: { start: number; end: number }[] = [];
  const re = /<w:tbl[\s>][\s\S]*?<\/w:tbl>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    tables.push({ start: m.index, end: m.index + m[0].length });
  }
  let out = xml;
  for (let ti = tables.length - 1; ti >= 0; ti--) {
    const { start, end } = tables[ti];
    const tblXml = out.slice(start, end);
    const trRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
    let tmplIdx = -1;
    let rowI = 0;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(tblXml)) !== null) {
      if (/\{\{#[^{}]*\}\}/.test(trPlainText(tr[0]))) {
        tmplIdx = rowI;
        break;
      }
      rowI += 1;
    }
    if (tmplIdx <= 0) continue;
    const marked = markLeadingRowsAsTblHeader(tblXml, tmplIdx);
    if (marked !== tblXml) {
      out = out.slice(0, start) + marked + out.slice(end);
    }
  }
  return out;
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

function rangeContains(
  outer: { start: number; end: number },
  inner: { start: number; end: number },
): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

type ResolvedOp = {
  id: string;
  start: number;
  end: number;
  tag: string;
  plainText: string;
  mode: "replace" | "wrap" | "wrap-row" | "delete-p" | "delete-tr" | "fill-empty-tc";
  closeTag: string;
  /** XML element bounds for delete modes (from original document.xml). */
  xmlStart?: number;
  xmlEnd?: number;
  cellIndex?: number;
};

function isDeleteMode(mode: ResolvedOp["mode"]): boolean {
  return mode === "delete-p" || mode === "delete-tr";
}

function isWrapMode(mode: ResolvedOp["mode"]): boolean {
  return mode === "wrap" || mode === "wrap-row";
}

function isFillEmptyTcMode(mode: ResolvedOp["mode"]): boolean {
  return mode === "fill-empty-tc";
}

/**
 * Next `<w:tc …>` open at/after `from` — must not match `<w:tcPr`.
 */
function indexOfTcOpen(xml: string, from: number): number {
  const re = /<w:tc[\s>]/g;
  re.lastIndex = from;
  const m = re.exec(xml);
  return m ? m.index : -1;
}

/** Top-level <w:tc>…</w:tc> spans inside a <w:tr> slice (no nested-table walk). */
function findTopLevelTcSpans(trXml: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const re = /<w:tc[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trXml)) !== null) {
    const start = m.index;
    let depth = 1;
    let i = start + m[0].length;
    while (i < trXml.length && depth > 0) {
      const nextOpen = indexOfTcOpen(trXml, i);
      const nextClose = trXml.indexOf("</w:tc>", i);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        // Skip past this open tag so nested <w:tcPr> is not re-scanned as open.
        const openEnd = trXml.indexOf(">", nextOpen);
        i = openEnd >= 0 ? openEnd + 1 : nextOpen + 5;
      } else {
        depth -= 1;
        i = nextClose + "</w:tc>".length;
        if (depth === 0) {
          spans.push({ start, end: i });
          // Jump the outer regex past this cell so we don't re-enter nested tcs.
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * Find a <w:tr> for fill-empty-tc. Prefer the plain-range row (wrap tag in
 * concatenated <w:t> — works when the tag is split across runs so xml.indexOf
 * misses). Then contiguous locator tags in XML. Always return the wrap's row
 * when found, even if cellIndex is high — caller validates tc count.
 */
function findTrOpenForFill(
  xml: string,
  nodes: WtNode[],
  plainStart: number,
  plainEnd: number,
  cellIndex: number,
  locatorTags: string[] = [],
  locatorOccurrence = 0,
): number {
  const need = cellIndex + 1;
  const trCellCount = (trOpen: number) => {
    if (trOpen < 0) return 0;
    const trClose = xml.indexOf("</w:tr>", trOpen);
    if (trClose < 0) return 0;
    return findTopLevelTcSpans(xml.slice(trOpen, trClose + "</w:tr>".length)).length;
  };
  const trHasCells = (trOpen: number) => trCellCount(trOpen) >= need;

  // 1) Plain-range anchor from wrap tag in fillPlain (most reliable after wrap-row).
  const hit =
    plainEnd > plainStart
      ? overlappingNodes(nodes, plainStart, plainEnd)
      : plainStart > 0 || plainEnd > 0
        ? nodesAtPoint(nodes, plainStart, false)
        : [];
  if (hit.length) {
    const trOpen = findContainingTrOpen(xml, hit[0].contentStart);
    if (trOpen >= 0 && trCellCount(trOpen) > 0) return trOpen;
  }

  // 2) Contiguous locator string in XML (may miss split {{#…}} runs).
  for (const loc of locatorTags) {
    if (!loc) continue;
    let from = 0;
    let found = -1;
    while (from < xml.length) {
      const idx = xml.indexOf(loc, from);
      if (idx < 0) break;
      const trOpen = findContainingTrOpen(xml, idx);
      if (trCellCount(trOpen) > 0) {
        found += 1;
        if (found === locatorOccurrence) return trOpen;
      }
      from = idx + loc.length;
    }
  }

  // 3) Nearest preceding row that has enough cells.
  if (hit.length) {
    const trOpen = findContainingTrOpen(xml, hit[0].contentStart);
    if (trOpen >= 0) {
      const re = /<w:tr[\s>]/g;
      let prev = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        if (m.index > trOpen) break;
        if (trHasCells(m.index)) prev = m.index;
      }
      if (prev >= 0) return prev;
    }
  }
  return -1;
}

/** Absolute <w:tr> open by table + row index in the *current* xml. */
function trOpenByTableRow(xml: string, tableIndex: number, rowIndexInTable: number): number {
  const tblOpens = listTblOpens(xml);
  if (tableIndex < 0 || tableIndex >= tblOpens.length) return -1;
  const opens = listTrOpensInTable(xml, tblOpens[tableIndex]);
  if (rowIndexInTable < 0 || rowIndexInTable >= opens.length) return -1;
  return opens[rowIndexInTable];
}

/**
 * Set a table cell's text to `tag` (empty or replace) in the row containing
 * [plainStart, plainEnd) — or a row located via wrap-row open tags /
 * tableIndex+rowIndexInTable pin.
 */
function setTcContentInRow(
  xml: string,
  nodes: WtNode[],
  plainStart: number,
  plainEnd: number,
  cellIndex: number,
  tag: string,
  locatorTags: string[] = [],
  locatorOccurrence = 0,
  domCellIndex?: number,
  tableIndex?: number,
  rowIndexInTable?: number,
): string {
  let trOpen = -1;
  if (
    typeof tableIndex === "number" &&
    Number.isFinite(tableIndex) &&
    typeof rowIndexInTable === "number" &&
    Number.isFinite(rowIndexInTable)
  ) {
    trOpen = trOpenByTableRow(xml, tableIndex, rowIndexInTable);
  }
  if (trOpen < 0) {
    trOpen = findTrOpenForFill(
      xml,
      nodes,
      plainStart,
      plainEnd,
      cellIndex,
      locatorTags,
      locatorOccurrence,
    );
  }
  if (trOpen < 0) throw new Error("ไม่พบแถวตารางของเซลล์ว่าง");
  const trClose = xml.indexOf("</w:tr>", trOpen);
  if (trClose < 0) throw new Error("แถวตารางปิดไม่ครบ");
  const trEnd = trClose + "</w:tr>".length;
  const trXml = xml.slice(trOpen, trEnd);
  const tcs = findTopLevelTcSpans(trXml);
  let useIndex = cellIndex;
  if (
    (useIndex < 0 || useIndex >= tcs.length) &&
    typeof domCellIndex === "number" &&
    domCellIndex >= 0 &&
    domCellIndex < tcs.length
  ) {
    useIndex = domCellIndex;
  }
  if (useIndex < 0 || useIndex >= tcs.length) {
    throw new Error(`เซลล์ที่ ${cellIndex + 1} ไม่มีในแถว (มี ${tcs.length} เซลล์)`);
  }
  const span = tcs[useIndex];
  const cellAbsStart = trOpen + span.start;
  const cellAbsEnd = trOpen + span.end;
  const cellXml = xml.slice(cellAbsStart, cellAbsEnd);

  const encoded = encodeXmlEntities(tag);
  let newCell: string;
  if (/<w:t\b[^>]*>[^<]*<\/w:t>/.test(cellXml)) {
    let first = true;
    newCell = cellXml.replace(/<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g, (_m, attrs = "") => {
      if (first) {
        first = false;
        const open = needsXmlSpace(tag)
          ? buildOpenTag(attrs || "", tag)
          : `<w:t${attrs || ""}>`;
        return `${open}${encoded}</w:t>`;
      }
      return `<w:t${attrs || ""}></w:t>`;
    });
  } else if (/<w:p\b[^>]*>/.test(cellXml)) {
    newCell = cellXml.replace(
      /(<w:p\b[^>]*>)(\s*<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>)?/,
      (_m, pOpen: string, pPr = "") => `${pOpen}${pPr || ""}<w:r><w:t>${encoded}</w:t></w:r>`,
    );
  } else {
    newCell = cellXml.replace(
      /<w:tc\b([^>]*)>/,
      `<w:tc$1><w:p><w:r><w:t>${encoded}</w:t></w:r></w:p>`,
    );
  }
  return xml.slice(0, cellAbsStart) + newCell + xml.slice(cellAbsEnd);
}

/**
 * Shift a plain-text offset past earlier deletions (deletes applied first on original).
 */
function shiftPastDeletes(
  pos: number,
  deletes: { start: number; end: number }[],
): number {
  let shifted = pos;
  for (const d of deletes) {
    if (d.end <= pos) shifted -= d.end - d.start;
    else if (d.start < pos && pos < d.end) {
      throw new Error("ช่วงแท็กทับกับช่วงที่ลบแล้ว");
    }
  }
  return shifted;
}

/**
 * Replace selected plain-text ranges with {{tags}} inside word/document.xml,
 * wrap ranges / table rows with {{#list}}…{{/}}, or delete <w:p>/<w:tr>,
 * preserving surrounding runs and formatting.
 */
export async function tagTemplate(
  buffer: Buffer,
  replacements: TagReplacement[],
): Promise<TagTemplateResult> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) {
    throw new Error("ไฟล์ไม่ใช่ .docx ที่ถูกต้อง (ไม่มี word/document.xml)");
  }

  let xml = await file.async("string");
  const list = Array.isArray(replacements) ? replacements : [];
  const fillWarnings: string[] = [];

  if (list.length > 0) {
    // Validate fill-empty-tc up front; apply AFTER wrap/replace so row plain anchors stay intact.
    type PendingFill = {
      id: string;
      plainText: string;
      occurrence: number;
      tag: string;
      cellIndex: number;
      domCellIndex?: number;
      wrapTag?: string;
      wrapOccurrence: number;
      tableIndex?: number;
      rowIndexInTable?: number;
    };
    const pendingFills: PendingFill[] = [];
    const deletePins = list
      .filter((r) => (r?.mode || "") === "delete-tr")
      .map((r) => ({
        tableIndex: Number(r?.tableIndex),
        rowIndexInTable: Number(r?.rowIndexInTable),
      }))
      .filter(
        (d) =>
          Number.isFinite(d.tableIndex) &&
          d.tableIndex >= 0 &&
          Number.isFinite(d.rowIndexInTable) &&
          d.rowIndexInTable >= 0,
      );
    for (const raw of list) {
      if ((raw?.mode || "replace") !== "fill-empty-tc") continue;
      const id = String(raw?.id || "").trim() || "fill";
      const plain = String(raw?.plainText ?? "");
      const occurrence = Number(raw?.occurrence ?? 0);
      const tag = String(raw?.tag || "").trim();
      const ci = Number(raw?.cellIndex);
      const domCi = Number(raw?.domCellIndex);
      const wrapTag = String(raw?.wrapTag || "").trim() || undefined;
      const wrapOccurrence = Number.isFinite(Number(raw?.wrapOccurrence))
        ? Number(raw.wrapOccurrence)
        : 0;
      const tableIndex = Number.isFinite(Number(raw?.tableIndex))
        ? Number(raw.tableIndex)
        : undefined;
      const rowIndexInTable = Number.isFinite(Number(raw?.rowIndexInTable))
        ? Number(raw.rowIndexInTable)
        : undefined;
      if (!plain) throw new Error(`รายการ ${id}: ข้อความว่างไม่ได้`);
      const tagErr = validateTag(tag);
      if (tagErr) throw new Error(tagErr);
      if (!Number.isFinite(ci) || ci < 0) {
        throw new Error(`รายการ ${id}: fill-empty-tc ต้องมี cellIndex >= 0`);
      }
      pendingFills.push({
        id,
        plainText: plain,
        occurrence,
        tag,
        cellIndex: ci,
        ...(Number.isFinite(domCi) && domCi >= 0 ? { domCellIndex: domCi } : {}),
        wrapTag,
        wrapOccurrence,
        ...(typeof tableIndex === "number" ? { tableIndex } : {}),
        ...(typeof rowIndexInTable === "number" ? { rowIndexInTable } : {}),
      });
    }

    const restList = list.filter((r) => (r?.mode || "replace") !== "fill-empty-tc");
    const { nodes, plainText } = collectWtNodes(xml);

    const resolved: ResolvedOp[] = [];

    for (const raw of restList) {
      const id = String(raw?.id || "").trim() || `r${resolved.length}`;
      const plain = String(raw?.plainText ?? "");
      const occurrence = Number(raw?.occurrence ?? 0);
      const tag = String(raw?.tag || "").trim();
      const mode = (raw?.mode || "replace") as ResolvedOp["mode"];
      const closeTag = String(raw?.closeTag || "{{/}}").trim();

      const tableIndex =
        mode === "delete-tr" && Number.isFinite(Number(raw?.tableIndex))
          ? Number(raw.tableIndex)
          : undefined;
      const rowIndexInTableEarly =
        mode === "delete-tr" && Number.isFinite(Number(raw?.rowIndexInTable))
          ? Number(raw.rowIndexInTable)
          : undefined;
      const pinnedDelete =
        mode === "delete-tr" &&
        typeof tableIndex === "number" &&
        typeof rowIndexInTableEarly === "number";

      if (!plain && !pinnedDelete) {
        throw new Error(`รายการ ${id}: ข้อความว่างไม่ได้`);
      }

      if (isDeleteMode(mode)) {
        // tag unused for deletes
      } else if (isWrapMode(mode)) {
        const openErr = validateListOpenTag(tag);
        if (openErr) throw new Error(openErr);
        const closeErr = validateListCloseTag(closeTag);
        if (closeErr) throw new Error(closeErr);
      } else {
        // Normal field tags; also allow in-place rename of loop markers already
        // in the file (plainText is "{{#old}}" → tag "{{#new}}").
        const tagErr = validateTag(tag);
        if (tagErr) {
          const openErr = validateListOpenTag(tag);
          if (openErr) throw new Error(tagErr);
        }
      }

      const plainStartRaw = Number(raw?.plainStart);
      const hasPlainStart =
        Number.isFinite(plainStartRaw) &&
        plainStartRaw >= 0 &&
        plain.length > 0 &&
        plainText.slice(plainStartRaw, plainStartRaw + plain.length) === plain;

      let range =
        plain.length > 0 && !pinnedDelete
          ? hasPlainStart
            ? { start: plainStartRaw, end: plainStartRaw + plain.length }
            : findOccurrenceRange(plainText, plain, occurrence)
          : { start: 0, end: 0 };
      let xmlStart: number | undefined;
      let xmlEnd: number | undefined;

      if (mode === "wrap-row" || mode === "delete-tr") {
        const rowOffset =
          mode === "delete-tr" && Number.isFinite(Number(raw?.rowOffset))
            ? Number(raw.rowOffset)
            : 0;
        const rowIndexInTable =
          mode === "delete-tr" && Number.isFinite(Number(raw?.rowIndexInTable))
            ? Number(raw.rowIndexInTable)
            : undefined;
        const expanded = expandToTableRow(
          xml,
          nodes,
          range.start,
          range.end,
          mode === "wrap-row",
          rowOffset,
          rowIndexInTable,
          tableIndex,
        );
        range = { start: expanded.start, end: expanded.end };
        if (mode === "delete-tr") {
          xmlStart = expanded.xmlStart;
          xmlEnd = expanded.xmlEnd;
        }
      } else if (mode === "delete-p") {
        const expanded = expandToParagraph(xml, nodes, range.start, range.end);
        range = { start: expanded.start, end: expanded.end };
        xmlStart = expanded.xmlStart;
        xmlEnd = expanded.xmlEnd;
      }

      resolved.push({
        id,
        start: range.start,
        end: range.end,
        tag,
        plainText: plain,
        mode,
        closeTag,
        xmlStart,
        xmlEnd,
      });
    }

    // Overlap rules:
    // - deletes must not overlap any other op (partial or nested)
    // - replaces may nest fully inside wraps; no partial overlaps
    // - wraps must not overlap each other; replaces must not overlap each other
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i];
        const b = resolved[j];
        if (!rangesOverlap(a, b)) continue;

        const aDel = isDeleteMode(a.mode);
        const bDel = isDeleteMode(b.mode);
        if (aDel || bDel) {
          throw new Error(
            `ช่วงลบแถวซ้อนกับรายการอื่น: "${a.plainText.slice(0, 24)}" กับ "${b.plainText.slice(0, 24)}"`,
          );
        }

        const aWrap = isWrapMode(a.mode);
        const bWrap = isWrapMode(b.mode);

        if (aWrap && bWrap) {
          throw new Error(
            `ช่วงลิสต์ซ้อนกัน: "${a.plainText.slice(0, 24)}" กับ "${b.plainText.slice(0, 24)}"`,
          );
        }
        if (!aWrap && !bWrap) {
          throw new Error(
            `ช่วงแท็กซ้อนกัน: "${a.plainText.slice(0, 24)}" กับ "${b.plainText.slice(0, 24)}"`,
          );
        }
        const wrap = aWrap ? a : b;
        const field = aWrap ? b : a;
        if (!rangeContains(wrap, field)) {
          throw new Error(
            `แท็กฟิลด์คาบขอบลิสต์: "${field.plainText.slice(0, 24)}" กับ "${wrap.plainText.slice(0, 24)}"`,
          );
        }
      }
    }

    // 1) Structural deletes first (end → start by XML offset so earlier cuts stay valid).
    const deletes = resolved
      .filter((r) => isDeleteMode(r.mode) && r.xmlStart != null && r.xmlEnd != null)
      .slice()
      .sort((a, b) => (b.xmlStart as number) - (a.xmlStart as number));
    for (const d of deletes) {
      xml = removeXmlSpan(xml, d.xmlStart as number, d.xmlEnd as number);
    }

    // 2) Shift remaining tag ops past deleted plain spans, then apply end → start.
    const deletedPlain = deletes
      .map((d) => ({ start: d.start, end: d.end }))
      .sort((a, b) => a.start - b.start);

    type Atomic = {
      pos: number;
      end: number;
      text: string;
      kind: "insert" | "replace";
      preferEnd?: boolean;
    };
    const atomics: Atomic[] = [];
    for (const r of resolved) {
      if (isDeleteMode(r.mode)) continue;
      const start = shiftPastDeletes(r.start, deletedPlain);
      const end = shiftPastDeletes(r.end, deletedPlain);
      if (isWrapMode(r.mode)) {
        atomics.push({
          pos: end,
          end,
          text: r.closeTag,
          kind: "insert",
          preferEnd: true,
        });
        atomics.push({
          pos: start,
          end: start,
          text: r.tag,
          kind: "insert",
          preferEnd: false,
        });
      } else {
        atomics.push({ pos: start, end, text: r.tag, kind: "replace" });
      }
    }
    atomics.sort((a, b) => b.pos - a.pos || b.end - a.end);

    for (const op of atomics) {
      const { nodes: currentNodes } = collectWtNodes(xml);
      xml = applyRangeReplace(
        xml,
        currentNodes,
        op.pos,
        op.end,
        op.text,
        op.kind === "insert" ? !!op.preferEnd : false,
      );
    }

    // Keep rows below wrap-row (may be footer / extra samples) — delete manually via delete-tr.

    // 3) Fill empty <w:tc> last — locate the owning wrap-row (wrapTag + occurrence),
    // not the first {{#…}} in the document (that skipped empty cells in later tables).
    const wrapOpenTags = resolved
      .filter((r) => r.mode === "wrap-row")
      .map((r) => r.tag)
      .filter(Boolean);
    for (const f of pendingFills) {
      const { nodes: fillNodes, plainText: fillPlain } = collectWtNodes(xml);
      let range: { start: number; end: number } | null = null;
      const locTag = f.wrapTag || "";
      const locOcc = f.wrapOccurrence || 0;
      if (locTag) {
        try {
          range = findOccurrenceRange(fillPlain, locTag, locOcc);
        } catch {
          range = null;
        }
      }
      if (!range) {
        try {
          range = findOccurrenceRange(fillPlain, f.plainText, f.occurrence);
        } catch {
          range = null;
        }
      }
      if (!range && wrapOpenTags.length) {
        for (const openTag of wrapOpenTags) {
          try {
            range = findOccurrenceRange(fillPlain, openTag, 0);
            break;
          } catch {
            /* try next */
          }
        }
      }
      if (!range) {
        range = { start: 0, end: 0 };
      }
      const locators = locTag ? [locTag] : wrapOpenTags;
      // Deletes already applied — shift original row index down by earlier deletes
      // in the same table so the pin still hits the intended <w:tr>.
      let fillRow = f.rowIndexInTable;
      if (typeof f.tableIndex === "number" && typeof fillRow === "number") {
        const earlier = deletePins.filter(
          (d) => d.tableIndex === f.tableIndex && d.rowIndexInTable < fillRow!,
        ).length;
        fillRow = fillRow - earlier;
      }
      try {
        xml = setTcContentInRow(
          xml,
          fillNodes,
          range.start,
          range.end,
          f.cellIndex,
          f.tag,
          locators,
          locTag ? locOcc : 0,
          f.domCellIndex,
          f.tableIndex,
          fillRow,
        );
      } catch (err) {
        // Don't fail the whole batch when one empty-cell index can't be placed
        // (wrong row / colspan) — wrap + other fields still apply.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tagTemplate] skip fill-empty-tc ${f.id}: ${msg}`);
        fillWarnings.push(`เซลล์ว่าง ${f.cellIndex + 1} (${f.tag}): ${msg}`);
      }
    }

  }

  // Tables that got {{/}} without a {{#…}} on the same table (open left in a
  // paragraph above) look headless in Word — repair even when there are no new
  // replacements (re-download of an already-tagged file).
  xml = ensureTableLoopOpenTags(xml);
  xml = ensureTableListHeaders(xml);
  zip.file("word/document.xml", xml);

  const outBuf = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  const { plainText } = collectWtNodes(
    (await (await JSZip.loadAsync(outBuf)).file("word/document.xml")!.async("string")),
  );
  const layout = await extractDocumentLayout(outBuf);
  const content = await extractDocumentText(outBuf);

  return {
    buffer: outBuf,
    plainText,
    content,
    layout: layout.blocks,
    ...(fillWarnings.length ? { warnings: fillWarnings } : {}),
  };
}

/** Plain text as the tagger sees it (<w:t> + <w:tab/> as \\t). */
export async function extractTaggerPlainText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) return "";
  const xml = await file.async("string");
  return collectWtNodes(xml).plainText;
}
