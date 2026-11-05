/**
 * Provider-agnostic fill of Export JSON from source files.
 * Gemini keeps native multimodal; OpenAI-compatible + Anthropic use
 * vision for images and text extraction for PDF/DOCX.
 */

import type { FormField } from "./docx-engine";
import { callCursorAgentJson } from "./ai-cursor-agent";
import { getCursorApiKey } from "./ai-config";
import { formatProviderHttpError } from "./ai-http-errors";
import {
  assertFormAiSupported,
  getAiProvider,
  getAnthropicApiBase,
} from "./ai-providers";
import {
  geminiFillDocxFormValues,
  geminiFillDocxFormValuesBatch,
  type BatchFillItem,
  type BatchFillResultItem,
  type GeminiSourceFile,
} from "./gemini-map";
import type { DocxFormValuesJson } from "./source-map";
import { mergeAiIntoValuesJson } from "./source-map";

export type AiSourceFile = GeminiSourceFile;

export type AiFillOpts = {
  provider?: string | null;
  apiKey?: string | null;
  model?: string | null;
  fields?: FormField[];
};

const FILL_RULES = `Fill values from Source text. Set skip=true when unknown/empty (bool false is a real value → skip=false).
For lists: values[listName] = array of row objects with ALL item keys (0+ rows); empty list → [] and skip=true.
Bool must be true/false. Prefer exact source text; do not invent IDs/names/case numbers.
Tables: "—" means empty cell; column order matters — do NOT shift values left across empty cells.
If similar headers appear twice (earlier vs later), keys with 「ปัจจุบัน」/current → later set; unmarked pair → earlier set.
Checkbox-style keys (e.g. พบ / ไม่) → true when √/✓ is in that cell.
If the source is unrelated to the template (wrong document / no overlapping facts), leave every value empty with skip=true and set "relevant": false on the root object.`;

export const DOCX_XML_TEXT_CAP = 120_000;
export const PDF_TEXT_CAP = 80_000;

export type AiFillMeta = {
  sourceTruncated: boolean;
  truncatedFiles: string[];
};

/** Inspect whether source extraction will drop trailing content for prompt caps. */
export async function inspectSourceTruncation(
  files: AiSourceFile[],
): Promise<AiFillMeta> {
  const truncatedFiles: string[] = [];
  const { detectKind, extractSourceFile } = await import("./source-extract");
  for (const f of files) {
    const name = f.filename || "source";
    const kind = detectKind(name, f.mimeType);
    if (kind === "docx") {
      try {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(f.buffer);
        const xmlFile = zip.file("word/document.xml");
        const xml = xmlFile ? await xmlFile.async("string") : "";
        if (xml.length > DOCX_XML_TEXT_CAP) truncatedFiles.push(name);
      } catch {
        /* ignore — fill path will surface read errors */
      }
    } else if (kind === "pdf") {
      try {
        const extracted = await extractSourceFile({
          buffer: f.buffer,
          filename: name,
          mimeType: f.mimeType || "application/pdf",
        });
        if ((extracted.text || "").length > PDF_TEXT_CAP) {
          truncatedFiles.push(name);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return {
    sourceTruncated: truncatedFiles.length > 0,
    truncatedFiles,
  };
}

function slimExportSkeleton(skeleton: DocxFormValuesJson) {
  return {
    format: "docx-form-values" as const,
    version: 1 as const,
    template: skeleton.template,
    fields: skeleton.fields,
    values: skeleton.values,
    skip: skeleton.skip,
    rowSkip: skeleton.rowSkip,
  };
}

function fieldHintsForPrompt(fields: FormField[]): string {
  const hints: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === "auto" || f.type === "image") continue;
    if (f.type === "bool") {
      hints[f.name] = {
        type: "bool",
        label: f.label,
        trueText: f.trueText,
        falseText: f.falseText,
      };
      continue;
    }
    if (f.type === "list") {
      hints[f.name] = {
        type: "list",
        items: f.itemFields
          .filter((i) => i.type !== "auto")
          .map((i) =>
            i.type === "bool"
              ? {
                  name: i.name,
                  type: "bool",
                  label: i.label,
                  trueText: i.trueText,
                  falseText: i.falseText,
                }
              : { name: i.name, type: "text" },
          ),
      };
      continue;
    }
    hints[f.name] = { type: "text" };
  }
  return Object.keys(hints).length ? JSON.stringify(hints) : "";
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
      if (Array.isArray(parsed)) return { _legacy: parsed };
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

function imageMime(filename: string, mime?: string): string {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return m;
  const n = filename.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

async function sourceAsTextAndImages(files: AiSourceFile[]): Promise<{
  textBlocks: string[];
  images: { mimeType: string; base64: string; filename: string }[];
}> {
  const textBlocks: string[] = [];
  const images: { mimeType: string; base64: string; filename: string }[] = [];
  const { detectKind, extractSourceFile } = await import("./source-extract");

  for (const f of files) {
    const name = f.filename || "source";
    const mime = String(f.mimeType || "");
    const kind = detectKind(name, mime);
    if (kind === "image") {
      images.push({
        mimeType: imageMime(name, mime),
        base64: f.buffer.toString("base64"),
        filename: name,
      });
      continue;
    }
    if (kind === "docx") {
      try {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(f.buffer);
        const xmlFile = zip.file("word/document.xml");
        const xml = xmlFile ? await xmlFile.async("string") : "";
        textBlocks.push(
          `===== FILE: ${name} (Word document.xml) =====\n${xml.slice(0, DOCX_XML_TEXT_CAP)}`,
        );
      } catch {
        textBlocks.push(`===== FILE: ${name} (docx — อ่าน XML ไม่สำเร็จ) =====`);
      }
      continue;
    }
    if (kind === "pdf") {
      try {
        const extracted = await extractSourceFile({
          buffer: f.buffer,
          filename: name,
          mimeType: mime || "application/pdf",
        });
        textBlocks.push(
          `===== FILE: ${name} (PDF text) =====\n${(extracted.text || "").slice(0, PDF_TEXT_CAP)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        textBlocks.push(`===== FILE: ${name} (PDF — ดึงข้อความไม่สำเร็จ: ${msg}) =====`);
      }
      continue;
    }
    textBlocks.push(`===== FILE: ${name} (unsupported kind) =====`);
  }

  return { textBlocks, images };
}

function buildSinglePrompt(
  skeleton: DocxFormValuesJson,
  fields: FormField[],
  textBlocks: string[],
): string {
  const hints = fields.length ? fieldHintsForPrompt(fields) : "";
  const slim = slimExportSkeleton(skeleton);
  return `You fill a Thai Word form values JSON exactly like a user Export JSON file.
Return ONLY valid JSON in the SAME shape as templateJson (docx-form-values).
Do not invent keys. Keep format, version, template, fields unchanged.
${FILL_RULES}
${hints ? `\nfieldHints:\n${hints}\n` : ""}
templateJson:
${JSON.stringify(slim)}

SOURCE TEXT:
${textBlocks.join("\n\n") || "(see attached images)"}

Images may also be attached. Prefer visual/layout evidence when present.`;
}

function buildBatchPrompt(items: BatchFillItem[], textBlocks: string[]): string {
  const pack = items.map((it) => ({
    id: it.id,
    filename: it.filename,
    templateJson: slimExportSkeleton(it.skeleton),
    fieldHints: it.fields?.length
      ? JSON.parse(fieldHintsForPrompt(it.fields) || "null")
      : null,
  }));
  return `You fill SEVERAL separate Thai Word Export JSON files from the SAME sources.
Each item in "templates" is ONE independent Export JSON — do NOT merge fields across templates.
Return ONLY valid JSON:
{
  "results": [
    { "id": "<same id>", "filename": "<same filename>", "valuesJson": { ...filled docx-form-values... } }
  ]
}
Rules:
- results MUST have exactly ${items.length} entries, one per templates[].id
- Keep each valuesJson.format/version/template/fields unchanged; only fill values/skip/rowSkip
- ${FILL_RULES.split("\n").join("\n- ")}

templates:
${JSON.stringify(pack)}

SOURCE TEXT:
${textBlocks.join("\n\n") || "(see attached images)"}`;
}

function pickFilledRawForItem(
  parsed: Record<string, unknown>,
  item: BatchFillItem,
  index: number,
  total: number,
): Record<string, unknown> | null {
  const results = parsed.results;
  if (Array.isArray(results)) {
    const byId = results.find(
      (r) =>
        r &&
        typeof r === "object" &&
        !Array.isArray(r) &&
        String((r as { id?: unknown }).id || "") === item.id,
    ) as Record<string, unknown> | undefined;
    if (byId) {
      const inner = byId.valuesJson;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
      return byId;
    }
    if (index < results.length) {
      const at = results[index];
      if (at && typeof at === "object" && !Array.isArray(at)) {
        const row = at as Record<string, unknown>;
        const inner = row.valuesJson;
        if (inner && typeof inner === "object" && !Array.isArray(inner)) {
          return inner as Record<string, unknown>;
        }
        return row;
      }
    }
  }
  if (
    total === 1 &&
    parsed.format === "docx-form-values" &&
    parsed.values &&
    typeof parsed.values === "object"
  ) {
    return parsed;
  }
  return null;
}

async function callOpenAiJson(
  providerId: string,
  prompt: string,
  opts: {
    apiKey: string;
    model: string;
    images: { mimeType: string; base64: string; filename: string }[];
  },
): Promise<Record<string, unknown> | null> {
  const provider = getAiProvider(providerId);
  if (!provider || provider.apiFamily !== "openai" || !provider.baseUrl) {
    throw new Error(`ผู้ให้บริการ ${providerId} ไม่รองรับ OpenAI-compatible API`);
  }
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: prompt }];
  for (const img of opts.images.slice(0, 12)) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
      },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    ...(provider.defaultHeaders || {}),
  };

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0.1,
    messages: [{ role: "user", content }],
  };
  // Some gateways reject response_format with vision — try with it first.
  body.response_format = { type: "json_object" };

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
  const text =
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
  return parseJsonObject(text);
}

async function callAnthropicJson(
  prompt: string,
  opts: {
    apiKey: string;
    model: string;
    images: { mimeType: string; base64: string; filename: string }[];
  },
): Promise<Record<string, unknown> | null> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  > = [];
  for (const img of opts.images.slice(0, 12)) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mimeType,
        data: img.base64,
      },
    });
  }
  content.push({ type: "text", text: prompt });

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
      messages: [{ role: "user", content }],
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
  const text = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("");
  return parseJsonObject(text);
}

type CompatApiFamily = "openai" | "anthropic" | "cursor";

async function callCompatJson(
  providerId: string,
  apiFamily: CompatApiFamily,
  prompt: string,
  opts: {
    apiKey: string;
    model: string;
    images: { mimeType: string; base64: string; filename: string }[];
  },
): Promise<Record<string, unknown> | null> {
  if (apiFamily === "cursor") {
    return callCursorAgentJson(prompt, {
      apiKey: opts.apiKey,
      model: opts.model,
      images: opts.images.map((img) => ({
        mimeType: img.mimeType,
        base64: img.base64,
      })),
    });
  }
  if (apiFamily === "anthropic") {
    return callAnthropicJson(prompt, opts);
  }
  return callOpenAiJson(providerId, prompt, opts);
}

function resolveCompatApiKey(
  apiFamily: CompatApiFamily,
  override?: string | null,
): string {
  if (apiFamily === "cursor") {
    return getCursorApiKey(override) || "";
  }
  return String(override || "").trim();
}

async function fillViaCompat(
  skeleton: DocxFormValuesJson,
  sourceFiles: AiSourceFile[],
  opts: AiFillOpts & { providerId: string; apiFamily: CompatApiFamily },
): Promise<DocxFormValuesJson> {
  const apiKey = resolveCompatApiKey(opts.apiFamily, opts.apiKey);
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");
  const model = String(opts.model || "").trim();
  if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");
  if (!sourceFiles.length) throw new Error("ไม่มีไฟล์ต้นทางให้ AI อ่าน");

  const { textBlocks, images } = await sourceAsTextAndImages(sourceFiles);
  const prompt = buildSinglePrompt(
    skeleton,
    Array.isArray(opts.fields) ? opts.fields : [],
    textBlocks,
  );
  const parsed = await callCompatJson(opts.providerId, opts.apiFamily, prompt, {
    apiKey,
    model,
    images,
  });
  return mergeAiIntoValuesJson(skeleton, parsed);
}

async function fillBatchViaCompat(
  items: BatchFillItem[],
  sourceFiles: AiSourceFile[],
  opts: AiFillOpts & { providerId: string; apiFamily: CompatApiFamily },
): Promise<BatchFillResultItem[]> {
  if (!items.length) return [];
  if (items.length === 1) {
    const only = items[0];
    const valuesJson = await fillViaCompat(only.skeleton, sourceFiles, {
      ...opts,
      fields: only.fields,
    });
    return [{ id: only.id, filename: only.filename, valuesJson }];
  }
  const apiKey = resolveCompatApiKey(opts.apiFamily, opts.apiKey);
  const model = String(opts.model || "").trim();
  if (!apiKey) throw new Error("ยังไม่ได้ใส่ API key");
  if (!model) throw new Error("ยังไม่ได้เลือกโมเดล");
  if (!sourceFiles.length) throw new Error("ไม่มีไฟล์ต้นทางให้ AI อ่าน");

  const { textBlocks, images } = await sourceAsTextAndImages(sourceFiles);
  const prompt = buildBatchPrompt(items, textBlocks);
  const parsed = await callCompatJson(opts.providerId, opts.apiFamily, prompt, {
    apiKey,
    model,
    images,
  });

  const out: BatchFillResultItem[] = [];
  const missing: BatchFillItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const raw = parsed ? pickFilledRawForItem(parsed, item, i, items.length) : null;
    if (!raw) {
      missing.push(item);
      continue;
    }
    out.push({
      id: item.id,
      filename: item.filename,
      valuesJson: mergeAiIntoValuesJson(item.skeleton, raw),
    });
  }
  for (const item of missing) {
    const valuesJson = await fillViaCompat(item.skeleton, sourceFiles, {
      ...opts,
      fields: item.fields,
    });
    out.push({ id: item.id, filename: item.filename, valuesJson });
  }
  const byId = new Map(out.map((r) => [r.id, r]));
  return items.map((it) => {
    const hit = byId.get(it.id);
    if (!hit) throw new Error(`AI ไม่คืน JSON สำหรับเทมเพลต ${it.filename}`);
    return hit;
  });
}

export async function fillDocxFormValues(
  skeleton: DocxFormValuesJson,
  sourceFiles: AiSourceFile[],
  opts?: AiFillOpts,
): Promise<DocxFormValuesJson> {
  const provider = getAiProvider(opts?.provider) || getAiProvider("google")!;
  assertFormAiSupported(provider);
  if (provider.apiFamily === "gemini") {
    return geminiFillDocxFormValues(skeleton, sourceFiles, {
      apiKey: opts?.apiKey,
      model: opts?.model,
      fields: opts?.fields,
    });
  }
  if (
    provider.apiFamily !== "openai" &&
    provider.apiFamily !== "anthropic" &&
    provider.apiFamily !== "cursor"
  ) {
    throw new Error(`ผู้ให้บริการ ${provider.id} ยังไม่รองรับการกรอกฟอร์ม`);
  }
  return fillViaCompat(skeleton, sourceFiles, {
    ...opts,
    providerId: provider.id,
    apiFamily: provider.apiFamily,
  });
}

export async function fillDocxFormValuesBatch(
  items: BatchFillItem[],
  sourceFiles: AiSourceFile[],
  opts?: AiFillOpts,
): Promise<BatchFillResultItem[]> {
  const provider = getAiProvider(opts?.provider) || getAiProvider("google")!;
  assertFormAiSupported(provider);
  if (provider.apiFamily === "gemini") {
    return geminiFillDocxFormValuesBatch(items, sourceFiles, {
      apiKey: opts?.apiKey,
      model: opts?.model,
    });
  }
  if (
    provider.apiFamily !== "openai" &&
    provider.apiFamily !== "anthropic" &&
    provider.apiFamily !== "cursor"
  ) {
    throw new Error(`ผู้ให้บริการ ${provider.id} ยังไม่รองรับการกรอกฟอร์ม`);
  }
  return fillBatchViaCompat(items, sourceFiles, {
    ...opts,
    providerId: provider.id,
    apiFamily: provider.apiFamily,
  });
}

export type { BatchFillItem, BatchFillResultItem };
