import JSZip from "jszip";

/**
 * Word often splits `{{…}}` across adjacent <w:r>/<w:t> runs.
 * Merge each split tag into the first overlapping run so detection/replace
 * stay reliable and that run's formatting wins.
 */

type WtHit = {
  matchStart: number;
  matchEnd: number;
  openInner: string;
  text: string;
};

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

function collectWtHits(pXml: string): WtHit[] {
  const hits: WtHit[] = [];
  const re = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pXml)) !== null) {
    const openInner = m[1] || "";
    const raw = m[2] || "";
    hits.push({
      matchStart: m.index,
      matchEnd: m.index + m[0].length,
      openInner,
      text: decodeXmlEntities(raw),
    });
  }
  return hits;
}

type CharMap = { hitIndex: number; offset: number };

function buildPlainMap(hits: WtHit[]): { plain: string; map: CharMap[] } {
  let plain = "";
  const map: CharMap[] = [];
  hits.forEach((h, hitIndex) => {
    for (let offset = 0; offset < h.text.length; offset += 1) {
      map.push({ hitIndex, offset });
      plain += h.text[offset];
    }
  });
  return { plain, map };
}

function findTagSpans(plain: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < plain.length) {
    const open = plain.indexOf("{{", i);
    if (open < 0) break;
    const close = plain.indexOf("}}", open + 2);
    if (close < 0) break;
    spans.push({ start: open, end: close + 2 });
    i = close + 2;
  }
  return spans;
}

/** Merge the left-most split tag in a paragraph; return null if none. */
function mergeOneSplitTag(pXml: string): string | null {
  const hits = collectWtHits(pXml);
  if (hits.length < 2) return null;

  const { plain, map } = buildPlainMap(hits);
  const split = findTagSpans(plain).find((sp) => {
    if (sp.start >= map.length || sp.end - 1 >= map.length) return false;
    return map[sp.start].hitIndex !== map[sp.end - 1].hitIndex;
  });
  if (!split) return null;

  const first = map[split.start];
  const last = map[split.end - 1];
  const tagText = plain.slice(split.start, split.end);
  const texts = hits.map((h) => h.text);

  const prefix = texts[first.hitIndex].slice(0, first.offset);
  const suffix = texts[last.hitIndex].slice(last.offset + 1);
  texts[first.hitIndex] = prefix + tagText + suffix;
  for (let hi = first.hitIndex + 1; hi <= last.hitIndex; hi += 1) {
    texts[hi] = "";
  }

  let next = pXml;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const h = hits[i];
    const text = texts[i];
    const open = buildOpenTag(h.openInner, text);
    const replacement = `${open}${encodeXmlEntities(text)}</w:t>`;
    next = next.slice(0, h.matchStart) + replacement + next.slice(h.matchEnd);
  }
  return next;
}

/**
 * Merge every tag that spans multiple <w:t> nodes into the first run's text.
 * Later runs keep their <w:rPr> but contribute empty <w:t/> for the moved span.
 */
export function mergeSplitTemplateTagsInXml(xml: string): string {
  if (!xml.includes("{{") || !xml.includes("<w:t")) return xml;

  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml) => {
    let current = pXml;
    // Bound iterations by run count; each pass collapses at least one split tag.
    for (let n = 0; n < 64; n += 1) {
      const merged = mergeOneSplitTag(current);
      if (!merged || merged === current) return current;
      current = merged;
    }
    return current;
  });
}

const WORD_XML_PART =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i;

/** Merge split tags across all main Word XML parts in a .docx buffer. */
export async function mergeSplitTemplateTagsInDocx(
  buffer: Buffer,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  const tasks: Array<Promise<void>> = [];

  zip.forEach((path, file) => {
    if (file.dir || !WORD_XML_PART.test(path)) return;
    tasks.push(
      (async () => {
        const xml = await file.async("string");
        const next = mergeSplitTemplateTagsInXml(xml);
        if (next !== xml) {
          zip.file(path, next);
          changed = true;
        }
      })(),
    );
  });

  await Promise.all(tasks);
  if (!changed) return buffer;
  return Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    }),
  );
}
