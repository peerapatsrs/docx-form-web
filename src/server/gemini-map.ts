import type { FormField } from "./docx-engine";
import { getGeminiApiKey, getGeminiModel } from "./ai-config";
import type { ExtractedSource } from "./source-extract";
import type { DocxFormValuesJson, MapCandidate } from "./source-map";
import { mergeAiIntoValuesJson } from "./source-map";

type GeminiHit = MapCandidate & { path: string };

type ScalarSpec = {
  path: string;
  type: "text" | "bool";
  hint: string;
};

type ListSpec = {
  name: string;
  keys: { name: string; type: "text" | "bool"; hint: string }[];
};

function buildSchema(fields: FormField[]): {
  scalars: ScalarSpec[];
  lists: ListSpec[];
} {
  const scalars: ScalarSpec[] = [];
  const lists: ListSpec[] = [];
  for (const f of fields) {
    if (f.type === "auto" || f.type === "image") continue;
    if (f.type === "list") {
      const keys = f.itemFields
        .filter((i) => i.type !== "auto")
        .map((i) =>
          i.type === "bool"
            ? {
                name: i.name,
                type: "bool" as const,
                hint: `bool label=${i.label}; true→${i.trueText}; false→${i.falseText}`,
              }
            : { name: i.name, type: "text" as const, hint: i.name },
        );
      if (keys.length) lists.push({ name: f.name, keys });
      continue;
    }
    if (f.type === "bool") {
      scalars.push({
        path: f.name,
        type: "bool",
        hint: `label=${f.label}; true→${f.trueText}; false→${f.falseText}`,
      });
      continue;
    }
    scalars.push({ path: f.name, type: "text", hint: f.name });
  }
  return { scalars, lists };
}

function serializeTables(sources: ExtractedSource[]): string {
  const blocks: string[] = [];
  for (const s of sources) {
    if (!s.tables?.length) continue;
    blocks.push(`\n----- STRUCTURED TABLES in ${s.filename} -----`);
    s.tables.forEach((tbl, i) => {
      const width = Math.max(
        tbl.headers?.length || 0,
        ...tbl.rows.map((r) => r.length),
        0,
      );
      const pad = (row: string[]) => {
        const cells = row.slice();
        while (cells.length < width) cells.push("");
        return cells.map((c) => (c && c.trim() ? c.trim() : "—")).join(" | ");
      };
      blocks.push(`[TABLE ${i + 1}]`);
      if (tbl.headers?.length) blocks.push(`headers: ${pad(tbl.headers)}`);
      tbl.rows.forEach((r, ri) => blocks.push(`row ${ri}: ${pad(r)}`));
      blocks.push(`[END TABLE ${i + 1}]`);
    });
  }
  return blocks.join("\n");
}

function corpusFromSources(sources: ExtractedSource[], maxChars = 48000): string {
  const parts: string[] = [];
  let used = 0;
  const push = (chunk: string) => {
    if (!chunk || used >= maxChars) return;
    if (used + chunk.length > maxChars) {
      parts.push(chunk.slice(0, Math.max(0, maxChars - used)));
      used = maxChars;
      return;
    }
    parts.push(chunk);
    used += chunk.length;
  };

  for (const s of sources) {
    const header = `\n===== FILE: ${s.filename} (${s.kind}) =====\n`;
    const body = (s.text || "").trim();
    if (!body) continue;
    push(header + body);
  }
  // Append structured tables again (with empties) so column alignment is explicit.
  push(serializeTables(sources));
  return parts.join("\n");
}

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
      // Legacy array → wrap
      if (Array.isArray(parsed)) {
        return { _legacy: parsed };
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  const direct = tryParse(body);
  if (direct) return direct;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(body.slice(start, end + 1));
  }
  const a0 = body.indexOf("[");
  const a1 = body.lastIndexOf("]");
  if (a0 >= 0 && a1 > a0) {
    return tryParse(body.slice(a0, a1 + 1));
  }
  return null;
}

function coerceValue(
  raw: unknown,
  type: "text" | "bool",
): { value: string | boolean; confidence: number } | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { value?: unknown; confidence?: unknown; found?: unknown };
    if (o.found === false || o.value === null || o.value === undefined) return null;
    const inner = coerceValue(o.value, type);
    if (!inner) return null;
    const conf =
      typeof o.confidence === "number"
        ? Math.min(1, Math.max(0, o.confidence))
        : inner.confidence;
    return { value: inner.value, confidence: conf };
  }
  if (type === "bool") {
    if (typeof raw === "boolean") return { value: raw, confidence: 0.85 };
    const t = String(raw).trim();
    if (/^(true|false)$/i.test(t)) return { value: /^true$/i.test(t), confidence: 0.85 };
    if (/^(1|yes|ใช่|พบ|√|✓)$/i.test(t)) return { value: true, confidence: 0.7 };
    if (/^(0|no|ไม่|x|✗|ไม่พบ)$/i.test(t)) return { value: false, confidence: 0.7 };
    return null;
  }
  const t = String(raw).trim();
  if (!t || /^null$/i.test(t)) return null;
  return { value: t, confidence: 0.85 };
}

/** Flatten structured Gemini JSON into path hits. */
function hitsFromStructured(
  parsed: Record<string, unknown>,
  scalars: ScalarSpec[],
  lists: ListSpec[],
): GeminiHit[] {
  const out: GeminiHit[] = [];
  const push = (path: string, value: string | boolean, confidence: number) => {
    out.push({
      path,
      value,
      sourceFile: "Google Gemini",
      rule: "gemini",
      confidence,
    });
  };

  // Legacy array form: [{path,value,confidence}]
  if (Array.isArray(parsed._legacy)) {
    for (const item of parsed._legacy as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const s = item as { path?: unknown; value?: unknown; confidence?: unknown };
      if (typeof s.path !== "string" || !s.path.trim()) continue;
      const path = s.path.trim();
      const top = path.split(".")[0];
      const list = lists.find((l) => l.name === top);
      const scalar = scalars.find((x) => x.path === path);
      const type: "text" | "bool" =
        scalar?.type ||
        (list
          ? list.keys.find((k) => path.endsWith(`.${k.name}`))?.type || "text"
          : "text");
      const c = coerceValue(s.value, type);
      if (!c) continue;
      const conf =
        typeof s.confidence === "number"
          ? Math.min(1, Math.max(0, s.confidence))
          : c.confidence;
      push(path, c.value, conf);
    }
    return out;
  }

  const fieldsObj =
    parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)
      ? (parsed.fields as Record<string, unknown>)
      : parsed;

  for (const spec of scalars) {
    const raw =
      fieldsObj[spec.path] !== undefined
        ? fieldsObj[spec.path]
        : (parsed as Record<string, unknown>)[spec.path];
    const c = coerceValue(raw, spec.type);
    if (c) push(spec.path, c.value, c.confidence);
  }

  const listsObj =
    parsed.lists && typeof parsed.lists === "object" && !Array.isArray(parsed.lists)
      ? (parsed.lists as Record<string, unknown>)
      : null;

  for (const list of lists) {
    const rowsRaw = listsObj?.[list.name];
    if (!Array.isArray(rowsRaw)) continue;
    rowsRaw.forEach((row, i) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      const rowObj = row as Record<string, unknown>;
      for (const key of list.keys) {
        const c = coerceValue(rowObj[key.name], key.type);
        if (c) push(`${list.name}.${i}.${key.name}`, c.value, c.confidence);
      }
    });
  }

  return out;
}

function missingScalarPaths(scalars: ScalarSpec[], hits: GeminiHit[]): string[] {
  const have = new Set(hits.map((h) => h.path));
  return scalars.map((s) => s.path).filter((p) => !have.has(p));
}

function missingListCellPaths(lists: ListSpec[], hits: GeminiHit[]): string[] {
  const missing: string[] = [];
  for (const list of lists) {
    const rowIdxs = new Set<number>();
    const prefix = `${list.name}.`;
    for (const h of hits) {
      if (!h.path.startsWith(prefix)) continue;
      const m = /^\S+\.(\d+)\./.exec(h.path);
      if (m) rowIdxs.add(Number(m[1]));
    }
    // Always require at least row 0 skeleton so the list appears in the UI
    // when the source has data but Gemini returned nothing for the list.
    const rows = rowIdxs.size ? [...rowIdxs].sort((a, b) => a - b) : [];
    for (const i of rows) {
      for (const key of list.keys) {
        const path = `${list.name}.${i}.${key.name}`;
        if (!hits.some((h) => h.path === path)) missing.push(path);
      }
    }
  }
  return missing;
}

function listsWithNoHits(lists: ListSpec[], hits: GeminiHit[]): ListSpec[] {
  return lists.filter(
    (list) => !hits.some((h) => h.path === list.name || h.path.startsWith(`${list.name}.`)),
  );
}

const UI_MSG_MAX = 100;

type GeminiErrorBody = {
  error?: { message?: string; status?: string; code?: number };
  message?: string;
};

/** Prefer Google `error.message` / `error.status`; strip JSON dump for the UI banner. */
function parseGeminiErrorBody(raw: string): { message: string; status: string } {
  const text = String(raw || "").trim();
  if (!text) return { message: "", status: "" };
  try {
    const parsed = JSON.parse(text) as GeminiErrorBody;
    const msg = parsed?.error?.message || parsed?.message;
    const st = parsed?.error?.status;
    return {
      message: typeof msg === "string" ? msg.trim() : "",
      status: typeof st === "string" ? st.trim() : "",
    };
  } catch {
    return { message: text, status: "" };
  }
}

function sanitizeGeminiDetail(raw: string, max = UI_MSG_MAX): string {
  const { message } = parseGeminiErrorBody(raw);
  let text = message || String(raw || "").trim();
  if (!text) return "";
  text = text.replace(/\s+/g, " ").replace(/[{}\[\]]/g, "").trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

/** 429: quota vs rate-limit from Google message/status when available. */
function format429Message(body: string): string {
  const parsed = parseGeminiErrorBody(body);
  const hay = `${parsed.status} ${parsed.message}`.toLowerCase();
  const detail = sanitizeGeminiDetail(body, 80);

  const looksRate =
    /rate.?limit|too many requests|throttle|requests per (minute|second)|\brpm\b|\btpm\b/i.test(
      hay,
    );
  const looksQuota =
    /quota|exceeded your current quota|free_tier|billing|generaterequestsperday|generate_requests|resource_exhausted/i.test(
      hay,
    );

  if (looksRate) {
    return detail
      ? `Google AI เรียกถี่เกินไป — ${detail}`
      : "Google AI เรียกถี่เกินไป — รอสักครู่แล้วลองใหม่";
  }
  if (looksQuota) {
    return detail
      ? `Google AI เกินโควต้าแล้ว — ${detail}`
      : "Google AI เกินโควต้าแล้ว — รอรีเซ็ตหรืออัปเกรดแผน";
  }
  return detail
    ? `Google AI จำกัดการเรียก (429) — ${detail}`
    : "Google AI จำกัดการเรียก (429) — อาจเกินโควต้าหรือเรียกถี่เกินไป";
}

/** Short Thai-friendly message for Gemini HTTP failures (no raw JSON dump). */
export function formatGeminiHttpError(status: number, body: string): string {
  if (status === 503) {
    return "Google AI โมเดลนี้โหลดสูงชั่วคราว — ยังไม่ใช่โควต้าเต็ม ลองใหม่หรือเปลี่ยนโมเดล";
  }
  if (status === 429) {
    return format429Message(body);
  }
  if (status === 400 || status === 403) {
    return "API key หรือสิทธิ์ไม่ถูกต้อง";
  }
  if (status === 404) {
    return "โมเดลนี้ไม่มีหรือเลิกใช้แล้ว — เปลี่ยนโมเดล";
  }
  const detail = sanitizeGeminiDetail(body);
  return detail
    ? `เรียก Gemini ไม่สำเร็จ (${status}) — ${detail}`
    : `เรียก Gemini ไม่สำเร็จ (${status})`;
}

/** Network / timeout / DNS failures talking to Google. */
export function formatGeminiNetworkError(_err?: unknown): string {
  return "เชื่อมต่อ Google ไม่ได้";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson(
  prompt: string,
  opts?: { apiKey?: string | null; model?: string | null },
): Promise<Record<string, unknown> | null> {
  const apiKey = getGeminiApiKey(opts?.apiKey);
  if (!apiKey) throw new Error("ยังไม่ได้เชื่อมต่อ Google AI — ใส่ Gemini API key ก่อน");
  const model = getGeminiModel(opts?.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  async function callOnce(): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  }

  let res: Response;
  try {
    res = await callOnce();
    if (res.status === 503) {
      await sleep(700);
      res = await callOnce();
    }
  } catch (err) {
    throw new Error(formatGeminiNetworkError(err));
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(formatGeminiHttpError(res.status, errText));
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseJsonObject(text);
}

function mergeHits(into: GeminiHit[], more: GeminiHit[]): void {
  const have = new Set(into.map((h) => `${h.path}\0${String(h.value)}`));
  for (const h of more) {
    const key = `${h.path}\0${String(h.value)}`;
    if (have.has(key)) continue;
    // Prefer first value for a path; still allow distinct alt values
    const samePathDiffVal = into.some(
      (x) => x.path === h.path && String(x.value) !== String(h.value),
    );
    if (into.some((x) => x.path === h.path) && !samePathDiffVal) continue;
    if (into.some((x) => x.path === h.path && String(x.value) === String(h.value))) continue;
    // If path already has a value, only add as alternate distinct value
    into.push(h);
    have.add(key);
  }
}

function addHitIfAbsent(into: GeminiHit[], hit: GeminiHit): void {
  if (into.some((h) => h.path === hit.path)) return;
  into.push(hit);
}

/**
 * Ask Gemini to propose field fills from extracted source text.
 * Uses a structured schema + a gap-fill pass so every scalar / list cell
 * that appears in the template is attempted.
 */
export async function geminiProposeCandidates(
  fields: FormField[],
  sources: ExtractedSource[],
  opts?: { apiKey?: string | null; model?: string | null },
): Promise<GeminiHit[]> {
  const { scalars, lists } = buildSchema(fields);
  const corpus = corpusFromSources(sources);
  if (!corpus.trim()) {
    throw new Error("ไม่มีข้อความจากเอกสารต้นทางให้ AI อ่าน");
  }
  if (!scalars.length && !lists.length) return [];
  if (!getGeminiApiKey(opts?.apiKey)) {
    throw new Error("ยังไม่ได้เชื่อมต่อ Google AI — ใส่ Gemini API key ของคุณก่อน");
  }

  const listSchema = lists.map((l) => ({
    name: l.name,
    itemKeys: l.keys.map((k) => ({ key: k.name, type: k.type, hint: k.hint })),
  }));

  const prompt1 = `You extract values for a Thai Word template form from source documents.
Return ONLY valid JSON object (no markdown) with this exact shape:
{
  "fields": {
    "<scalarPath>": { "value": "<string or boolean>", "confidence": 0.0-1.0 }
  },
  "lists": {
    "<listName>": [
      { "<itemKey>": { "value": "<string or boolean>", "confidence": 0.0-1.0 }, ... },
      ...more rows...
    ]
  }
}

HARD RULES:
- Include EVERY key from "scalars" under "fields". If not found in sources, set value to null.
- For EVERY list in "listsSchema", include that list name under "lists".
- Each list must contain one object per distinct row found in the sources (0 or more).
- Every row object MUST include ALL itemKeys for that list (null if unknown).
- Prefer exact values from sources; do not invent IDs/names/case numbers.
- Bool values must be true or false (not strings).
- Tables use "—" for empty cells — column order matters. Do NOT shift values left across empty cells.
- Thai legal tables often have: ภูมิลำเนา ณ วันฟ้อง (earlier columns) vs ภูมิลำเนาปัจจุบัน (later columns).
  Keys containing ปัจจุบัน map to the CURRENT-domicile columns; keys containing ภูมิลำเนา (without ปัจจุบัน) map to filing-domicile columns.
- Keys พบ / ไม่ are checkbox columns (true if √/✓ present in that cell).

scalars:
${JSON.stringify(
    scalars.map((s) => ({ path: s.path, type: s.type, hint: s.hint })),
    null,
    2,
  )}

listsSchema:
${JSON.stringify(listSchema, null, 2)}

Source text:
${corpus}`;

  const parsed1 = await callGeminiJson(prompt1, opts);
  const hits: GeminiHit[] = [];
  if (parsed1) {
    mergeHits(hits, hitsFromStructured(parsed1, scalars, lists));
  }

  // Gap-fill: missing scalars + incomplete list rows + lists with zero hits
  const missScalars = missingScalarPaths(scalars, hits);
  const missCells = missingListCellPaths(lists, hits);
  const emptyLists = listsWithNoHits(lists, hits);

  if (missScalars.length || missCells.length || emptyLists.length) {
    const prompt2 = `Fill ONLY the missing template paths below from the same source text.
Return ONLY JSON:
{
  "fields": { "<path>": { "value": string|boolean|null, "confidence": number } },
  "lists": {
    "<listName>": [ { "<itemKey>": { "value": ..., "confidence": ... }, ... } ]
  }
}

Rules:
- Attempt EVERY path listed in missingScalars and missingListCells.
- For emptyLists: find ALL rows in the source for that list and fill every itemKey.
- null if truly not present; do not invent.
- Bool → true/false.

missingScalars: ${JSON.stringify(missScalars)}
missingListCells: ${JSON.stringify(missCells)}
emptyLists: ${JSON.stringify(
      emptyLists.map((l) => ({
        name: l.name,
        itemKeys: l.keys.map((k) => ({ key: k.name, type: k.type })),
      })),
    )}

scalars types: ${JSON.stringify(Object.fromEntries(scalars.map((s) => [s.path, s.type])))}
list key types: ${JSON.stringify(
      Object.fromEntries(
        lists.map((l) => [l.name, Object.fromEntries(l.keys.map((k) => [k.name, k.type]))]),
      ),
    )}

Source text:
${corpus}`;

    const parsed2 = await callGeminiJson(prompt2, opts);
    if (parsed2) {
      const more = hitsFromStructured(parsed2, scalars, lists);
      for (const h of more) addHitIfAbsent(hits, h);
    }
  }

  // Ensure every scalar appears as a proposal path (skip marker via empty → preferSkip later)
  // Actually UI unmatched lists scalars without hits. Add low-confidence null? Better:
  // leave missing as unmatched OR add preferSkip via proposalsFromHits.
  // User asked for complete map — seed empty-list row 0 keys as absent is wrong.
  // For scalars still missing after 2 passes, we cannot invent — UI shows unmatched.

  // If a list has rows but some cells still missing, leave them (rowSkip on apply).

  // Filter: only allow known scalar paths or listName.n.key
  const scalarSet = new Set(scalars.map((s) => s.path));
  const listByName = new Map(lists.map((l) => [l.name, l]));
  return hits.filter((h) => {
    if (scalarSet.has(h.path)) return true;
    const m = /^([^.]+)\.(\d+)\.(.+)$/.exec(h.path);
    if (!m) return false;
    const list = listByName.get(m[1]);
    if (!list) return false;
    return list.keys.some((k) => k.name === m[3]);
  });
}

/**
 * Lean path: system owns the Export JSON skeleton; AI fills values once.
 * No gap-fill second call — Import JSON handles the rest.
 */
export async function geminiFillDocxFormValues(
  skeleton: DocxFormValuesJson,
  sources: ExtractedSource[],
  opts?: { apiKey?: string | null; model?: string | null },
): Promise<DocxFormValuesJson> {
  const corpus = corpusFromSources(sources);
  if (!corpus.trim()) {
    throw new Error("ไม่มีข้อความจากเอกสารต้นทางให้ AI อ่าน");
  }
  if (!getGeminiApiKey(opts?.apiKey)) {
    throw new Error("ยังไม่ได้เชื่อมต่อ Google AI — ใส่ Gemini API key ของคุณก่อน");
  }

  const slim = {
    format: "docx-form-values",
    version: 1,
    template: skeleton.template,
    fields: skeleton.fields,
    values: skeleton.values,
    skip: skeleton.skip,
    rowSkip: skeleton.rowSkip,
  };

  const prompt = `You fill a Thai Word form values JSON from source documents.
Return ONLY valid JSON in the SAME shape as "templateJson" below (docx-form-values).
Do not invent keys. Keep "format", "version", "template", "fields" unchanged.
Fill "values" from the sources. Set skip=true when a value is unknown/empty.
For bool fields use true/false. For lists return an array of row objects (0+ rows).
Do not invent IDs/names/case numbers; prefer exact source text.
Thai tables: empty cells are "—"; do not shift values across empty cells.

templateJson:
${JSON.stringify(slim, null, 2)}

Source text:
${corpus}`;

  const parsed = await callGeminiJson(prompt, opts);
  return mergeAiIntoValuesJson(skeleton, parsed);
}
