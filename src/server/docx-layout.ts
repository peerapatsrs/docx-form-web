import JSZip from "jszip";

export type CellAlign = "left" | "center" | "right" | "both";

export type LayoutCell = {
  text: string;
  colspan?: number;
  rowspan?: number;
  /** Paragraph horizontal alignment from Word (w:jc). */
  align?: CellAlign;
  /** Preferred width in twips (dxa) from w:tcW or tblGrid. */
  widthDxa?: number;
};

export type LayoutTextBlock = {
  type: "text";
  text: string;
  /** Present when this block comes from a header/footer part. */
  part?: "header" | "footer";
};
export type LayoutTableBlock = {
  type: "table";
  /** Header rows from Word (with colspan/rowspan). */
  headerRows: LayoutCell[][];
  /** Loop list name if this table row is a {{#name}}…{{/}} template. */
  listName?: string;
  /** Data-row cells with {{#}} / {{/}} stripped; tags remain for fields. */
  templateCells: LayoutCell[];
  /**
   * Sample/body rows that still sit below the loop template in Word.
   * New wrap-row tagging strips these; kept here so tagger preview can show leftovers.
   */
  trailingRows?: LayoutCell[][];
  /** Static table (no loop) — all rows including body. */
  staticRows?: LayoutCell[][];
  /** Column widths from w:tblGrid (dxa). */
  colWidths?: number[];
  /** Word floating table (tblpPr) — visual order may differ from XML order. */
  floating?: boolean;
  /** Present when this block comes from a header/footer part. */
  part?: "header" | "footer";
};
/** Inline image whose Word alt/descr carries a {{field}} tag. */
export type LayoutImageBlock = {
  type: "image";
  /** Variable name from alt/descr (e.g. logo from {{logo}}). */
  fieldName: string;
  /** Nearby label from the preceding short paragraph when available. */
  label?: string;
  alt?: string;
  part?: "header" | "footer";
};
export type LayoutBlock = LayoutTextBlock | LayoutTableBlock | LayoutImageBlock;

export type DocumentLayout = {
  blocks: LayoutBlock[];
};

type RawCell = {
  text: string;
  colspan: number;
  vMerge: "restart" | "continue" | null;
  startCol: number;
  align?: CellAlign;
  widthDxa?: number;
};

function mapJc(val: string | undefined): CellAlign | undefined {
  if (!val) return undefined;
  switch (val) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
    case "distribute":
      return "both";
    case "left":
    case "start":
      return "left";
    default:
      return undefined;
  }
}

/** First explicit w:jc in the cell (usually the first paragraph). */
function parseCellAlign(tcXml: string): CellAlign | undefined {
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(tcXml))) {
    const p = m[1];
    const jc = mapJc(/<w:jc\b[^>]*\bw:val="([^"]*)"/.exec(p)?.[1]);
    if (jc) return jc;
    if (/<w:t[\s>]/.test(p)) break;
  }
  return undefined;
}

function parseTcWidth(tcXml: string): number | undefined {
  const pr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tcXml)?.[1] || "";
  const w =
    /<w:tcW\b[^>]*\bw:w="(\d+)"[^>]*\bw:type="dxa"/.exec(pr)?.[1] ||
    /<w:tcW\b[^>]*\bw:type="dxa"[^>]*\bw:w="(\d+)"/.exec(pr)?.[1];
  if (!w) return undefined;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseTblGridWidths(tblInner: string): number[] | undefined {
  const grid = /<w:tblGrid\b[^>]*>([\s\S]*?)<\/w:tblGrid>/.exec(tblInner)?.[1];
  if (!grid) return undefined;
  const widths: number[] = [];
  const re = /<w:gridCol\b[^>]*\bw:w="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(grid))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) widths.push(n);
  }
  return widths.length ? widths : undefined;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Cell/paragraph plain: <w:t> text with <w:tab/> as \\t (Word tab spacing). */
function cellPlainText(tcXml: string): string {
  let out = "";
  const re = /<w:tab\b[^>]*\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tcXml))) {
    if (m[0].startsWith("<w:tab")) out += "\t";
    else out += decodeXmlEntities(m[1] || "");
  }
  return out;
}

function parseTcProps(tcXml: string): { colspan: number; vMerge: RawCell["vMerge"] } {
  const pr = /<w:tcPr\b[^>]*>([\s\S]*?)<\/w:tcPr>/.exec(tcXml)?.[1] || "";
  let colspan = 1;
  const gs = /<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(pr);
  if (gs) colspan = Math.max(1, Number(gs[1]) || 1);

  let vMerge: RawCell["vMerge"] = null;
  const vMergeTag = /<w:vMerge\b([^>]*)\/?>/.exec(pr);
  if (vMergeTag) {
    const val = /\bw:val="([^"]*)"/.exec(vMergeTag[1] || "")?.[1];
    // Word: val="restart" starts a merge; bare <w:vMerge/> continues it
    vMerge = val === "restart" ? "restart" : "continue";
  }
  return { colspan, vMerge };
}

/**
 * Find top-level matched open/close tags by local name (depth-aware).
 * Avoids non-greedy regex breaking on nested tables / nested cells.
 */
function findTopLevelSpans(
  xml: string,
  localName: string,
): { start: number; end: number; inner: string }[] {
  const openRe = new RegExp(`<w:${localName}\\b[^>/]*(?:/>|>)`, "g");
  const closeToken = `</w:${localName}>`;
  const out: { start: number; end: number; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(xml))) {
    const open = m[0];
    const start = m.index;
    if (open.endsWith("/>")) {
      out.push({ start, end: start + open.length, inner: "" });
      continue;
    }
    let depth = 1;
    let pos = start + open.length;
    while (pos < xml.length && depth > 0) {
      const nextOpen = xml.indexOf(`<w:${localName}`, pos);
      const nextClose = xml.indexOf(closeToken, pos);
      if (nextClose < 0) break;
      if (nextOpen >= 0 && nextOpen < nextClose) {
        const slice = xml.slice(nextOpen, nextOpen + open.length + 8);
        const self = /^<w:[\w]+[^>]*\/>/.test(slice);
        const realOpen = new RegExp(`^<w:${localName}\\b`).test(slice);
        if (realOpen) {
          depth += self ? 0 : 1;
          pos = nextOpen + 1;
          continue;
        }
        pos = nextOpen + 1;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        const end = nextClose + closeToken.length;
        out.push({
          start,
          end,
          inner: xml.slice(start + open.length, nextClose),
        });
        openRe.lastIndex = end;
        break;
      }
      pos = nextClose + closeToken.length;
    }
  }
  return out;
}

function parseTableRawRows(tblInner: string): RawCell[][] {
  const rows: RawCell[][] = [];
  for (const tr of findTopLevelSpans(tblInner, "tr")) {
    const cells: RawCell[] = [];
    let startCol = 0;
    for (const tc of findTopLevelSpans(tr.inner, "tc")) {
      const { colspan, vMerge } = parseTcProps(tc.inner);
      const align = parseCellAlign(tc.inner);
      const widthDxa = parseTcWidth(tc.inner);
      cells.push({
        text: cellPlainText(tc.inner),
        colspan,
        vMerge,
        startCol,
        ...(align ? { align } : {}),
        ...(widthDxa ? { widthDxa } : {}),
      });
      startCol += colspan;
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function cellCovering(row: RawCell[], col: number): RawCell | null {
  for (const cell of row) {
    if (col >= cell.startCol && col < cell.startCol + cell.colspan) return cell;
  }
  return null;
}

/**
 * Convert raw Word cells into HTML-ready cells (skip vMerge continue, set rowspan).
 * If a vertical-merge restart cell is empty but a continue cell carries text/tags,
 * fold that text into the restart so merged-cell variables stay fillable in preview.
 */
function resolveMerges(rows: RawCell[][]): LayoutCell[][] {
  return rows.map((row, ri) => {
    const out: LayoutCell[] = [];
    for (const cell of row) {
      if (cell.vMerge === "continue") continue;
      let rowspan = 1;
      let text = cell.text;
      if (cell.vMerge === "restart") {
        for (let j = ri + 1; j < rows.length; j++) {
          const below = cellCovering(rows[j], cell.startCol);
          if (below && below.vMerge === "continue") {
            rowspan += 1;
            if (!text.trim() && below.text.trim()) text = below.text;
            else if (below.text.trim() && !text.includes(below.text)) {
              // Keep tags that only appear in continuation cells.
              if (/\{\{[^}]+\}\}/.test(below.text) && !/\{\{[^}]+\}\}/.test(text)) {
                text = text ? `${text}\n${below.text}` : below.text;
              }
            }
          } else break;
        }
      }
      const layout: LayoutCell = { text };
      if (cell.colspan > 1) layout.colspan = cell.colspan;
      if (rowspan > 1) layout.rowspan = rowspan;
      if (cell.align) layout.align = cell.align;
      if (cell.widthDxa) layout.widthDxa = cell.widthDxa;
      out.push(layout);
    }
    return out;
  });
}

function paragraphPlainText(pXml: string): string {
  return cellPlainText(pXml);
}

function stripLoopWrappers(cell: string): string {
  return cell
    .replace(/\{\{#([^}]*)\}\}/g, "")
    .replace(/\{\{\/([^}]*)\}\}/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function rawToTemplateCell(cell: RawCell): LayoutCell {
  const layout: LayoutCell = { text: stripLoopWrappers(cell.text) };
  if (cell.align) layout.align = cell.align;
  if (cell.widthDxa) layout.widthDxa = cell.widthDxa;
  if (cell.colspan > 1) layout.colspan = cell.colspan;
  return layout;
}

function tableToBlock(
  rawRows: RawCell[][],
  floating = false,
  colWidths?: number[],
): LayoutTableBlock {
  const resolved = resolveMerges(rawRows);
  const cols = colWidths?.length ? { colWidths } : {};
  for (let i = 0; i < rawRows.length; i++) {
    const joined = rawRows[i].map((c) => c.text).join("");
    const open = /\{\{#([^}]*)\}\}/.exec(joined);
    if (open) {
      const trailing = resolved.slice(i + 1);
      return {
        type: "table",
        headerRows: resolved.slice(0, i),
        listName: open[1].trim(),
        templateCells: rawRows[i].map(rawToTemplateCell),
        ...(trailing.length ? { trailingRows: trailing } : {}),
        floating: floating || undefined,
        ...cols,
      };
    }
  }
  return {
    type: "table",
    headerRows: [],
    templateCells: [],
    staticRows: resolved,
    floating: floating || undefined,
    ...cols,
  };
}

/**
 * Floating Word tables often sit before their caption in XML but appear below it on screen.
 * Pull an immediate following intro paragraph (e.g. “…ดังต่อไปนี้”) to before the table.
 */
function reorderFloatingTableCaptions(blocks: LayoutBlock[]): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "table" && b.floating && i + 1 < blocks.length && blocks[i + 1].type === "text") {
      const next = blocks[i + 1] as LayoutTextBlock;
      const paras = next.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
      const first = paras[0] || "";
      const looksLikeCaption =
        /ดังต่อไปนี้\s*$/.test(first) ||
        /ดังนี้\s*$/.test(first) ||
        (!!b.listName && first.includes(b.listName));
      if (looksLikeCaption && first) {
        out.push({ type: "text", text: first });
        out.push(b);
        const rest = paras.slice(1).join("\n").trim();
        blocks[i + 1] = { type: "text", text: rest };
        continue;
      }
    }
    if (b.type === "text" && !b.text.trim()) continue;
    out.push(b);
  }
  return out;
}

/** Read {{field}} tags from Word drawing alt text (wp:docPr descr / title). */
function imageFieldsFromParagraph(pXml: string): { fieldName: string; alt: string }[] {
  const out: { fieldName: string; alt: string }[] = [];
  const re = /<wp:docPr\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml))) {
    const attrs = m[1] || "";
    const descr =
      /\bdescr="([^"]*)"/.exec(attrs)?.[1] ||
      /\btitle="([^"]*)"/.exec(attrs)?.[1] ||
      "";
    const decoded = decodeXmlEntities(descr);
    const tag = /\{\{\s*([^{}]+)\s*\}\}/.exec(decoded);
    if (!tag) continue;
    const fieldName = tag[1].trim();
    if (!fieldName || fieldName.startsWith("#") || fieldName.startsWith("/")) continue;
    out.push({ fieldName, alt: decoded });
  }
  return out;
}

/** Last short label line in the pending text buffer (e.g. "โลโก้:"). */
function peekNearbyImageLabel(textBuf: string[]): string | undefined {
  const joined = textBuf.join("");
  const lines = joined
    .split(/\n+/)
    .map((l) => l.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i];
    if (/\{\{/.test(line)) continue;
    const cleaned = line.replace(/[:：]\s*$/, "").trim();
    if (!cleaned || cleaned.length > 40) continue;
    if (cleaned.includes("\t")) continue;
    return cleaned;
  }
  return undefined;
}

/** Walk a Word story part (body / hdr / ftr) into layout blocks. */
function walkStoryXml(
  storyXml: string,
  part?: "header" | "footer",
): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  let textBuf: string[] = [];
  const flushText = () => {
    const text = textBuf.join("").replace(/\n{3,}/g, "\n\n").trim();
    if (text) {
      const block: LayoutTextBlock = { type: "text", text };
      if (part) block.part = part;
      blocks.push(block);
    }
    textBuf = [];
  };

  // Prefer explicit body/hdr/ftr wrappers when present.
  const wrapped =
    /<w:body\b[^>]*>([\s\S]*)<\/w:body>/i.exec(storyXml)?.[1] ||
    /<w:hdr\b[^>]*>([\s\S]*)<\/w:hdr>/i.exec(storyXml)?.[1] ||
    /<w:ftr\b[^>]*>([\s\S]*)<\/w:ftr>/i.exec(storyXml)?.[1] ||
    storyXml;

  const nextTableOpen = (from: number): number => {
    const re = /<w:tbl(?:\s|>)/g;
    re.lastIndex = from;
    const m = re.exec(wrapped);
    return m ? m.index : -1;
  };

  let pos = 0;
  while (pos < wrapped.length) {
    const tblAt = nextTableOpen(pos);
    const pAt = wrapped.indexOf("<w:p", pos);
    if (tblAt < 0 && pAt < 0) break;

    if (tblAt >= 0 && (pAt < 0 || tblAt <= pAt)) {
      // Depth-aware table end (nested tables exist in complex docs).
      const openMatch = /^<w:tbl\b[^>]*>/.exec(wrapped.slice(tblAt));
      if (!openMatch) {
        pos = tblAt + 6;
        continue;
      }
      let depth = 1;
      let scan = tblAt + openMatch[0].length;
      let end = -1;
      while (scan < wrapped.length && depth > 0) {
        const nextOpen = nextTableOpen(scan);
        const nextClose = wrapped.indexOf("</w:tbl>", scan);
        if (nextClose < 0) break;
        if (nextOpen >= 0 && nextOpen < nextClose) {
          depth += 1;
          scan = nextOpen + 6;
          continue;
        }
        depth -= 1;
        if (depth === 0) {
          end = nextClose;
          break;
        }
        scan = nextClose + "</w:tbl>".length;
      }
      if (end < 0) break;
      const tblXml = wrapped.slice(tblAt, end + "</w:tbl>".length);
      const inner = tblXml.replace(/^<w:tbl\b[^>]*>/, "").replace(/<\/w:tbl>$/, "");
      flushText();
      const floating = /<w:tblpPr\b/.test(tblXml);
      const rows = parseTableRawRows(inner);
      const colWidths = parseTblGridWidths(inner);
      if (rows.length) {
        const block = tableToBlock(rows, floating, colWidths);
        if (part) block.part = part;
        blocks.push(block);
      }
      pos = end + "</w:tbl>".length;
      continue;
    }

    if (pAt >= 0) {
      const slice = wrapped.slice(pAt, pAt + 6);
      if (!(slice.startsWith("<w:p>") || slice.startsWith("<w:p "))) {
        pos = pAt + 4;
        continue;
      }
      const end = wrapped.indexOf("</w:p>", pAt);
      if (end < 0) break;
      const pXml = wrapped.slice(pAt, end + "</w:p>".length);
      const imageFields = imageFieldsFromParagraph(pXml);
      const t = paragraphPlainText(pXml);
      if (imageFields.length) {
        const nearby = peekNearbyImageLabel(textBuf);
        if (t) textBuf.push(t + "\n");
        flushText();
        for (const img of imageFields) {
          const block: LayoutImageBlock = {
            type: "image",
            fieldName: img.fieldName,
            alt: img.alt,
            ...(nearby ? { label: nearby } : {}),
          };
          if (part) block.part = part;
          blocks.push(block);
        }
      } else if (t) {
        textBuf.push(t + "\n");
      } else {
        textBuf.push("\n");
      }
      pos = end + "</w:p>".length;
      continue;
    }
    break;
  }
  flushText();
  return blocks;
}

function markPart(
  blocks: LayoutBlock[],
  part: "header" | "footer",
): LayoutBlock[] {
  return blocks.map((b) => ({ ...b, part }));
}

/**
 * Walk document body + headers + footers in order so variables in those
 * parts appear in the fill preview the same way body variables do.
 */
export async function extractDocumentLayout(buffer: Buffer): Promise<DocumentLayout> {
  const zip = await JSZip.loadAsync(buffer);
  const blocks: LayoutBlock[] = [];

  const headerNames = Object.keys(zip.files)
    .filter((n) => /^word\/header\d+\.xml$/i.test(n))
    .sort();
  for (const name of headerNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    blocks.push(...markPart(walkStoryXml(xml, "header"), "header"));
  }

  const main = zip.file("word/document.xml");
  if (main) {
    const xml = await main.async("string");
    blocks.push(...reorderFloatingTableCaptions(walkStoryXml(xml)));
  }

  const footerNames = Object.keys(zip.files)
    .filter((n) => /^word\/footer\d+\.xml$/i.test(n))
    .sort();
  for (const name of footerNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    blocks.push(...markPart(walkStoryXml(xml, "footer"), "footer"));
  }

  return { blocks };
}

/** Concatenated plain text from body + headers + footers (for content panel). */
export async function extractAllPlainText(buffer: Buffer): Promise<string> {
  const { blocks } = await extractDocumentLayout(buffer);
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      parts.push(b.text);
      continue;
    }
    if (b.type === "image") {
      if (b.label) parts.push(`${b.label}:`);
      if (b.fieldName) parts.push(`{{${b.fieldName}}}`);
      continue;
    }
    /** @type {LayoutCell[][]} */
    const rows: LayoutCell[][] = [
      ...(b.headerRows || []),
      ...(b.templateCells?.length ? [b.templateCells] : []),
      ...(b.trailingRows || []),
      ...(b.staticRows || []),
    ];
    for (const row of rows) {
      parts.push(
        row
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .join("\t"),
      );
    }
  }
  return parts
    .join("\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
