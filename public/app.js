/** @typedef {{ name: string, type: 'text' }} TextField */
/** @typedef {{ name: string, type: 'image' }} ImageField */
/** @typedef {{ name: string, type: 'bool', trueText: string, falseText: string, label: string }} BoolField */
/** @typedef {{ name: string, type: 'auto', label: string }} AutoField */
/** @typedef {TextField | BoolField | AutoField} ListItemField */
/** @typedef {{ name: string, type: 'list', itemFields: ListItemField[] }} ListField */
/** @typedef {TextField | ImageField | ListField | BoolField | AutoField} FormField */

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

/**
 * @type {{
 *   file: File | null,
 *   filename: string,
 *   fields: FormField[],
 *   values: Record<string, any>,
 *   images: Record<string, File | null>,
 *   skip: Record<string, boolean>,
 *   rowSkip: Record<string, Record<string, boolean>[]>,
 *   showFullContent: boolean,
 *   fileContent: string,
 *   fileLayout: any[],
 *   objectUrls: string[],
 * }}
 */
const state = {
  file: null,
  filename: "",
  fields: [],
  values: {},
  images: {},
  skip: {},
  rowSkip: {},
  showFullContent: true,
  fileContent: "",
  fileLayout: [],
  objectUrls: [],
};

/**
 * Active source-map review session (Gemini attach), or null.
 * @type {null | {
 *   proposals: { path: string, candidates: { value: any, sourceFile: string, rule: string, confidence: number }[], selectedIndex: number, preferSkip?: boolean }[],
 *   extracted: { filename: string, kind: string, charCount: number, warning?: string }[],
 *   values: Record<string, any>,
 *   skip: Record<string, boolean>,
 *   rowSkip: Record<string, Record<string, boolean>[]>,
 *   status: string,
 *   statusText?: string,
 *   aiLabel?: string,
 *   logs?: { t: string, message: string }[],
 *   showLogs?: boolean,
 *   progress?: { step: number, total: number, label: string },
 *   startedAt?: number,
 * }}
 */
let sourceMapSession = null;
/** @type {{ connected: boolean, maskedKey?: string|null, model?: string, models?: {id:string,label:string}[], defaultModel?: string, studioUrl?: string }} */
let aiStatus = { connected: false, models: [], defaultModel: "gemini-3.8-flash" };

/**
 * Multi-template workspace (หนึ่งชุดเอกสารต้นทาง → หลายแบบฟอร์ม).
 * @type {{
 *   id: string,
 *   file: File,
 *   filename: string,
 *   fields: FormField[],
 *   values: Record<string, any>,
 *   images: Record<string, File | null>,
 *   skip: Record<string, boolean>,
 *   rowSkip: Record<string, Record<string, boolean>[]>,
 *   fileContent: string,
 *   fileLayout: any[],
 * }[]}
 */
let multiSlots = [];
/** @type {string | null} */
let multiActiveId = null;

function isMultiMode() {
  return multiSlots.length > 1;
}

function newSlotId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const FALLBACK_GEMINI_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (แนะนำ)" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
  { id: "gemini-flash-latest", label: "gemini-flash-latest" },
];

function geminiModelOptions() {
  return Array.isArray(aiStatus.models) && aiStatus.models.length
    ? aiStatus.models
    : FALLBACK_GEMINI_MODELS;
}

/** View-only column widths (px). Never written to the .docx. */
const viewTableColWidths = new Map();

const DRAFT_DB = "docx-form";
const DRAFT_STORE = "draft";
const NAMED_DRAFT_STORE = "namedDrafts";
const DRAFT_KEY = "current";
const DRAFT_DB_VERSION = 2;
let draftSaveTimer = 0;
let draftRestoring = false;

function openDraftDb() {
  const open = new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFT_DB, DRAFT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
      if (!db.objectStoreNames.contains(NAMED_DRAFT_STORE)) {
        db.createObjectStore(NAMED_DRAFT_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
  // Safari can stall forever on open when storage is locked/private.
  return withTimeout(open, 2500, "indexedDB.open");
}

/** @param {IDBTransactionMode} mode @param {string} storeName */
function openDraftObjectStore(mode, storeName) {
  return openDraftDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        resolve({ db, tx, store });
        tx.onerror = () => reject(tx.error || new Error("indexedDB tx failed"));
      }),
  );
}

function draftStore(mode) {
  return openDraftObjectStore(mode, DRAFT_STORE);
}

function namedDraftStore(mode) {
  return openDraftObjectStore(mode, NAMED_DRAFT_STORE);
}

async function draftGet() {
  const { store } = await draftStore("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(DRAFT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function draftSet(value) {
  const { store } = await draftStore("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(value, DRAFT_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function draftClear() {
  try {
    const { store } = await draftStore("readwrite");
    await new Promise((resolve, reject) => {
      const req = store.delete(DRAFT_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* ignore */
  }
}

async function namedDraftList() {
  const { store } = await namedDraftStore("readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const items = Array.isArray(req.result) ? req.result.slice() : [];
      items.sort((a, b) => String(b?.savedAt || "").localeCompare(String(a?.savedAt || "")));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

async function namedDraftGet(id) {
  const { store } = await namedDraftStore("readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function namedDraftPut(value) {
  const { store } = await namedDraftStore("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function namedDraftDelete(id) {
  const { store } = await namedDraftStore("readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function fileToDraftBlob(file) {
  if (!file) return null;
  const buffer = await file.arrayBuffer();
  return { name: file.name, type: file.type || "", buffer };
}

function draftBlobToFile(blob) {
  if (!blob?.buffer) return null;
  return new File([blob.buffer], blob.name || "file", {
    type: blob.type || "application/octet-stream",
  });
}

/** Lightweight fingerprint: filename + size + sampled FNV-1a of file bytes. */
async function computeTemplateFingerprint(file) {
  if (!file) return "";
  const buffer = await file.arrayBuffer();
  const view = new Uint8Array(buffer);
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(view.length / 4096));
  for (let i = 0; i < view.length; i += step) {
    hash ^= view[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${file.name}|${view.byteLength}|${(hash >>> 0).toString(16)}`;
}

function formatDraftDate(iso) {
  try {
    return new Date(iso).toLocaleString("th-TH", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return String(iso || "");
  }
}

async function buildDraftPayload() {
  /** @type {Record<string, any>} */
  const images = {};
  for (const [name, file] of Object.entries(state.images)) {
    images[name] = file ? await fileToDraftBlob(file) : null;
  }
  const fileBlob = await fileToDraftBlob(state.file);
  const templateFingerprint = state.file ? await computeTemplateFingerprint(state.file) : "";
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    filename: state.filename,
    templateFingerprint,
    fields: state.fields,
    values: state.values,
    skip: state.skip,
    rowSkip: state.rowSkip,
    showFullContent: state.showFullContent,
    fileContent: state.fileContent,
    fileLayout: state.fileLayout,
    viewColWidths: Object.fromEntries(viewTableColWidths),
    file: fileBlob,
    images,
  };
}

/**
 * Apply a draft payload into form state (auto or named).
 * @param {any} draft
 * @returns {Promise<boolean>}
 */
async function applyDraftPayload(draft) {
  if (!draft?.file?.buffer || !Array.isArray(draft.fields) || !draft.fields.length) {
    return false;
  }
  draftRestoring = true;
  try {
    revokeObjectUrls();
    state.file = draftBlobToFile(draft.file);
    state.filename = draft.filename || state.file?.name || "";
    state.fields = draft.fields;
    state.values = draft.values && typeof draft.values === "object" ? draft.values : {};
    state.skip = draft.skip && typeof draft.skip === "object" ? draft.skip : {};
    state.rowSkip = draft.rowSkip && typeof draft.rowSkip === "object" ? draft.rowSkip : {};
    state.showFullContent = draft.showFullContent !== false;
    state.fileContent = typeof draft.fileContent === "string" ? draft.fileContent : "";
    state.fileLayout = Array.isArray(draft.fileLayout) ? draft.fileLayout : [];
    state.images = {};
    if (draft.images && typeof draft.images === "object") {
      for (const [name, blob] of Object.entries(draft.images)) {
        state.images[name] = draftBlobToFile(blob);
      }
    }
    viewTableColWidths.clear();
    if (draft.viewColWidths && typeof draft.viewColWidths === "object") {
      for (const [k, widths] of Object.entries(draft.viewColWidths)) {
        if (Array.isArray(widths)) viewTableColWidths.set(k, widths.map(Number));
      }
    }
    sourceMapSession = null;
    return !!state.file;
  } finally {
    draftRestoring = false;
  }
}

async function saveDraftNow() {
  if (draftRestoring) return;
  if (!state.file) {
    await draftClear();
    return;
  }
  try {
    await draftSet(await buildDraftPayload());
  } catch (err) {
    console.warn("save draft failed", err);
  }
}

function scheduleSaveDraft() {
  if (draftRestoring) return;
  window.clearTimeout(draftSaveTimer);
  draftSaveTimer = window.setTimeout(() => {
    void saveDraftNow();
  }, 250);
}

/**
 * Reject if IndexedDB hangs (Safari private / blocked storage can stall forever
 * and leave #app blank after health check).
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (err) => {
        window.clearTimeout(t);
        reject(err);
      },
    );
  });
}

async function restoreDraft() {
  try {
    const draft = await withTimeout(draftGet(), 2500, "draftGet");
    return await withTimeout(applyDraftPayload(draft), 8000, "applyDraft");
  } catch (err) {
    console.warn("restore draft failed", err);
    return false;
  }
}

function defaultNamedDraftTitle() {
  const base = state.filename ? String(state.filename).replace(/\.docx$/i, "") : "ดราฟ";
  return `${base} · ${formatDraftDate(new Date().toISOString())}`;
}

async function promptSaveNamedDraft() {
  if (!state.file || !state.fields.length) {
    showBanner("ยังไม่มีเทมเพลตให้บันทึกดราฟ");
    return;
  }
  const result = await askDialog({
    title: "บันทึกดราฟ",
    body: "ตั้งชื่อดราฟเพื่อโหลดกลับภายหลัง (ข้ามวัน / สลับงานได้) — เก็บในเบราว์เซอร์นี้ผ่าน IndexedDB",
    input: {
      label: "ชื่อดราฟ (ไม่บังคับ)",
      placeholder: defaultNamedDraftTitle(),
      value: defaultNamedDraftTitle(),
      type: "text",
    },
    actions: [
      { id: "save", label: "บันทึก", kind: "primary" },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
  if (!result || result === "abort" || typeof result !== "object") return;
  const title = String(result.value || "").trim() || defaultNamedDraftTitle();
  try {
    const payload = await buildDraftPayload();
    await namedDraftPut({
      ...payload,
      id: crypto.randomUUID(),
      title,
    });
    showBanner(`บันทึกดราฟแล้ว: ${title}`, "success");
    setTimeout(() => showBanner(""), 2800);
  } catch (err) {
    console.warn("named draft save failed", err);
    showBanner("บันทึกดราฟไม่สำเร็จ");
  }
}

/**
 * @param {any} draft
 * @returns {Promise<boolean>}
 */
async function confirmLoadNamedDraft(draft) {
  if (!draft) return false;
  if (!state.file) return true;

  let currentFp = "";
  try {
    currentFp = await computeTemplateFingerprint(state.file);
  } catch {
    currentFp = "";
  }
  const draftFp = String(draft.templateFingerprint || "");
  const sameFile =
    (draftFp && currentFp && draftFp === currentFp) ||
    (!draftFp && draft.filename && draft.filename === state.filename);

  if (sameFile) return true;

  const choice = await askDialog({
    title: "เทมเพลตต่างจากดราฟ",
    body: `ดราฟนี้มาจาก «${draft.filename || "ไม่ทราบไฟล์"}» แต่ตอนนี้เปิด «${state.filename || "ยังไม่มีไฟล์"}» อยู่ — โหลดจะแทนที่ฟอร์มและไฟล์ปัจจุบันทั้งหมด`,
    actions: [
      { id: "ok", label: "โหลดแทนที่", kind: "primary" },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
  return choice === "ok";
}

async function loadNamedDraftById(id) {
  try {
    const draft = await namedDraftGet(id);
    if (!draft) {
      showBanner("ไม่พบดราฟที่เลือก");
      return false;
    }
    if (!(await confirmLoadNamedDraft(draft))) return false;
    const ok = await applyDraftPayload(draft);
    if (!ok) {
      showBanner("โหลดดราฟไม่สำเร็จ — ข้อมูลไม่ครบ");
      return false;
    }
    scheduleSaveDraft();
    renderForm();
    showBanner(`โหลดดราฟแล้ว: ${draft.title || draft.filename || ""}`, "success");
    setTimeout(() => showBanner(""), 2800);
    return true;
  } catch (err) {
    console.warn("named draft load failed", err);
    showBanner("โหลดดราฟไม่สำเร็จ");
    return false;
  }
}

/**
 * @param {any[]} drafts
 * @param {{ emptyHint?: string }} [opts]
 */
function renderNamedDraftListHtml(drafts, opts = {}) {
  const emptyHint =
    opts.emptyHint ||
    "ยังไม่มีดราฟที่บันทึกไว้ — กด «บันทึกดราฟ» ตอนกรอกฟอร์ม";
  if (!drafts.length) {
    return `<p class="draft-list-empty">${escapeHtml(emptyHint)}</p>`;
  }
  return `<ul class="draft-list">
    ${drafts
      .map(
        (d) => `<li class="draft-list-item" data-draft-id="${escapeAttr(d.id)}">
          <div class="draft-list-main">
            <strong class="draft-list-title">${escapeHtml(d.title || d.filename || "ไม่มีชื่อ")}</strong>
            <span class="draft-list-meta">${escapeHtml(d.filename || "—")} · ${escapeHtml(formatDraftDate(d.savedAt))}</span>
          </div>
          <div class="draft-list-actions">
            <button type="button" class="btn-secondary btn-compact" data-draft-load="${escapeAttr(d.id)}">โหลด</button>
            <button type="button" class="btn-ghost btn-compact" data-draft-delete="${escapeAttr(d.id)}">ลบ</button>
          </div>
        </li>`,
      )
      .join("")}
  </ul>`;
}

/**
 * Wire load/delete on a draft list container. Optionally close a dialog after load.
 * @param {ParentNode} root
 * @param {{ onAfterLoad?: () => void, onAfterDelete?: () => void }} [opts]
 */
function wireNamedDraftListActions(root, opts = {}) {
  root.querySelectorAll("[data-draft-load]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-draft-load");
      if (!id) return;
      opts.onAfterLoad?.();
      void loadNamedDraftById(id);
    });
  });
  root.querySelectorAll("[data-draft-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-draft-delete");
      if (!id) return;
      const choice = await askDialog({
        title: "ลบดราฟนี้?",
        body: "ลบแล้วกู้คืนไม่ได้ — ดราฟอื่นยังอยู่ครบ",
        actions: [
          { id: "ok", label: "ลบ", kind: "primary" },
          { id: "abort", label: "ยกเลิก", kind: "ghost" },
        ],
      });
      if (choice !== "ok") return;
      try {
        await namedDraftDelete(id);
        root.querySelector(`[data-draft-id="${cssAttrSelector(id)}"]`)?.remove();
        const list = root.querySelector(".draft-list");
        if (list && !list.children.length) {
          list.outerHTML = renderNamedDraftListHtml([]);
        }
        showBanner("ลบดราฟแล้ว", "success");
        setTimeout(() => showBanner(""), 2000);
        opts.onAfterDelete?.();
      } catch (err) {
        console.warn("named draft delete failed", err);
        showBanner("ลบดราฟไม่สำเร็จ");
      }
    });
  });
}

async function refreshEmptyDraftPanel() {
  const panel = document.getElementById("emptyDraftPanel");
  const body = document.getElementById("emptyDraftList");
  if (!panel || !body) return;
  let drafts = [];
  try {
    drafts = await namedDraftList();
  } catch (err) {
    console.warn("named draft list failed", err);
    body.innerHTML = `<p class="draft-list-empty">อ่านรายการดราฟไม่สำเร็จ</p>`;
    return;
  }
  body.innerHTML = renderNamedDraftListHtml(drafts, {
    emptyHint: "ยังไม่มีดราฟ — อัปโหลดเทมเพลต กรอกแล้วกด «บันทึกดราฟ» เพื่อกลับมาทำต่อที่นี่",
  });
  panel.dataset.count = String(drafts.length);
  wireNamedDraftListActions(body);
}

async function openNamedDraftPicker() {
  const existing = document.getElementById("namedDraftDialog");
  if (existing) existing.remove();

  let drafts = [];
  try {
    drafts = await namedDraftList();
  } catch (err) {
    console.warn("named draft list failed", err);
    showBanner("อ่านรายการดราฟไม่สำเร็จ");
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "namedDraftDialog";
  overlay.className = "dialog-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.innerHTML = `
    <div class="dialog-card dialog-card-wide">
      <h2 class="dialog-title">โหลดดราฟ</h2>
      <p class="dialog-body">เลือกดราฟที่บันทึกไว้ในเบราว์เซอร์นี้ (คงอยู่ข้ามวัน)</p>
      <div id="namedDraftDialogList">${renderNamedDraftListHtml(drafts)}</div>
      <div class="dialog-actions dialog-actions-stack">
        <button type="button" class="btn-ghost" data-draft-close>ปิด</button>
      </div>
    </div>
  `;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    if (document.getElementById("appDialog")) return;
    close();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector("[data-draft-close]")?.addEventListener("click", close);

  const listRoot = overlay.querySelector("#namedDraftDialogList");
  if (listRoot) {
    wireNamedDraftListActions(listRoot, {
      onAfterLoad: close,
      onAfterDelete: () => {
        if (document.getElementById("emptyDraftList")) void refreshEmptyDraftPanel();
      },
    });
  }

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

function showBanner(message, kind = "error") {
  banner.hidden = !message;
  banner.classList.remove("success", "progress");
  if (!message) {
    banner.textContent = "";
    banner.removeAttribute("aria-busy");
    return;
  }
  if (kind === "progress") {
    banner.classList.add("progress");
    banner.setAttribute("aria-busy", "true");
    banner.innerHTML = `<span class="banner-spinner" aria-hidden="true"></span><span class="banner-msg">${escapeHtml(message)}</span><span class="banner-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="banner-bar" aria-hidden="true"></span>`;
  } else if (kind === "success") {
    banner.classList.add("success");
    banner.removeAttribute("aria-busy");
    banner.textContent = message;
  } else {
    banner.removeAttribute("aria-busy");
    banner.textContent = message;
  }
  // Only scroll for errors — success/progress must not jump the viewport.
  if (kind === "error") {
    banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/**
 * In-page dialog (native confirm is often blocked in Simple Browser).
 * @param {{
 *   title: string,
 *   body: string,
 *   actions: { id: string, label: string, kind?: 'primary' | 'secondary' | 'ghost' }[],
 * }} opts
 * @returns {Promise<string>} action id, or "abort" on Escape / overlay click
 */
function askDialog(opts) {
  return new Promise((resolve) => {
    const existing = document.getElementById("appDialog");
    if (existing) existing.remove();

    const actionsHtml = opts.actions
      .map((a) => {
        const kind = a.kind || "secondary";
        const cls =
          kind === "primary" ? "btn-primary" : kind === "ghost" ? "btn-ghost" : "btn-secondary";
        return `<button type="button" class="${cls}" data-dialog="${escapeAttr(a.id)}">${escapeHtml(a.label)}</button>`;
      })
      .join("");

    const inputHtml = opts.input
      ? `<label class="dialog-input-label" for="dialogInput">${escapeHtml(opts.input.label || "")}
          <input id="dialogInput" class="dialog-input" type="${escapeAttr(opts.input.type || "text")}"
            placeholder="${escapeAttr(opts.input.placeholder || "")}" autocomplete="off" spellcheck="false"
            value="${escapeAttr(opts.input.value || "")}" />
        </label>`
      : "";

    const selectOpts = opts.select?.options || [];
    const selectValue = opts.select?.value || selectOpts[0]?.id || "";
    const knownIds = new Set(selectOpts.map((o) => o.id));
    const isCustom = selectValue && !knownIds.has(selectValue);
    const optionsHtml = selectOpts
      .map(
        (o) =>
          `<option value="${escapeAttr(o.id)}" ${!isCustom && o.id === selectValue ? "selected" : ""}>${escapeHtml(o.label)}</option>`,
      )
      .join("");
    const selectHtml = opts.select
      ? `<label class="dialog-input-label" for="dialogSelect">${escapeHtml(opts.select.label || "โมเดล")}
          <select id="dialogSelect" class="dialog-input dialog-select">
            ${optionsHtml}
            <option value="__custom__" ${isCustom ? "selected" : ""}>อื่นๆ (พิมพ์เอง)…</option>
          </select>
        </label>
        <label class="dialog-input-label" for="dialogCustomModel" id="dialogCustomModelWrap" ${isCustom ? "" : "hidden"}>
          รหัสโมเดล
          <input id="dialogCustomModel" class="dialog-input" type="text"
            placeholder="เช่น gemini-3.8-flash" autocomplete="off" spellcheck="false"
            value="${escapeAttr(isCustom ? selectValue : "")}" />
        </label>`
      : "";

    const linkHtml = opts.link
      ? `<p class="dialog-link-wrap"><a class="dialog-link" href="${escapeAttr(opts.link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(opts.link.label)}</a></p>`
      : "";

    const overlay = document.createElement("div");
    overlay.id = "appDialog";
    overlay.className = "dialog-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="dialog-card">
        <h2 class="dialog-title">${escapeHtml(opts.title)}</h2>
        <p class="dialog-body">${escapeHtml(opts.body)}</p>
        ${linkHtml}
        ${inputHtml}
        ${selectHtml}
        <div class="dialog-actions dialog-actions-stack">${actionsHtml}</div>
      </div>
    `;

    const readFields = () => {
      const input = /** @type {HTMLInputElement | null} */ (overlay.querySelector("#dialogInput"));
      const select = /** @type {HTMLSelectElement | null} */ (overlay.querySelector("#dialogSelect"));
      const custom = /** @type {HTMLInputElement | null} */ (overlay.querySelector("#dialogCustomModel"));
      let model = select?.value || "";
      if (model === "__custom__") model = String(custom?.value || "").trim();
      return {
        value: input?.value || "",
        model,
      };
    };

    const finish = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish("abort");
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish("abort");
    });

    const selectEl = /** @type {HTMLSelectElement | null} */ (overlay.querySelector("#dialogSelect"));
    const customWrap = overlay.querySelector("#dialogCustomModelWrap");
    const customEl = /** @type {HTMLInputElement | null} */ (overlay.querySelector("#dialogCustomModel"));
    selectEl?.addEventListener("change", () => {
      const show = selectEl.value === "__custom__";
      if (customWrap instanceof HTMLElement) customWrap.hidden = !show;
      if (show) customEl?.focus();
    });

    for (const a of opts.actions) {
      overlay
        .querySelector(`[data-dialog="${cssAttrSelector(a.id)}"]`)
        ?.addEventListener("click", () => {
          if ((opts.input || opts.select) && (a.id === "ok" || a.id === "save")) {
            const fields = readFields();
            finish({ id: a.id, value: fields.value, model: fields.model });
            return;
          }
          finish(a.id);
        });
    }
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    const inputEl = /** @type {HTMLInputElement | null} */ (overlay.querySelector("#dialogInput"));
    if (inputEl) {
      inputEl.focus();
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const fields = readFields();
          finish({ id: "ok", value: fields.value, model: fields.model });
        }
      });
    } else {
      const focusId = opts.actions.find((a) => a.kind === "primary")?.id || opts.actions[0]?.id;
      if (focusId) {
        /** @type {HTMLButtonElement | null} */ (
          overlay.querySelector(`[data-dialog="${cssAttrSelector(focusId)}"]`)
        )?.focus();
      }
    }
  });
}

/** @returns {Promise<'clear' | 'keep' | 'abort'>} */
function askClearAfterCreate() {
  return askDialog({
    title: "ล้างช่องหลังสร้างเอกสารไหม?",
    body: "จะสร้างและดาวน์โหลดไฟล์ก่อน จากนั้นเลือกได้ว่าจะล้างช่องที่กรอกไว้หรือเก็บค่าไว้กรอกต่อ (เทมเพลตยังอยู่)",
    actions: [
      { id: "clear", label: "สร้างและล้างช่อง", kind: "primary" },
      { id: "keep", label: "สร้างแต่เก็บค่าไว้", kind: "secondary" },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
}

/** @returns {Promise<'one' | 'all' | 'abort'>} */
function askCreateScope() {
  if (!isMultiMode()) return Promise.resolve("one");
  return askDialog({
    title: "สร้างเอกสารแบบไหน?",
    body: `ตอนนี้มี ${multiSlots.length} เทมเพลตบนหน้าจอ — สร้างเฉพาะไฟล์ที่เปิดอยู่ หรือสร้างทั้งหมดเป็น ZIP จากค่าที่กรอกไว้ (ไม่เรียก AI ซ้ำ)`,
    actions: [
      { id: "one", label: "เฉพาะเอกสารที่เปิดอยู่", kind: "primary" },
      {
        id: "all",
        label: `ทุกเทมเพลต (${multiSlots.length} ไฟล์) เป็น ZIP`,
        kind: "secondary",
      },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
}

/** @returns {Promise<boolean>} */
async function askGoHome() {
  const choice = await askDialog({
    title: "กลับหน้าหลัก?",
    body: "จะออกจากเทมเพลตนี้ และล้างค่าที่กรอก / รูปที่เลือกไว้ในหน้านี้",
    actions: [
      { id: "ok", label: "กลับหน้าหลัก", kind: "primary" },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
  return choice === "ok";
}

function clearFieldErrors() {
  app.querySelectorAll(".field-error, .has-error").forEach((el) => {
    if (el.classList.contains("field-error")) el.remove();
    else el.classList.remove("has-error");
  });
}

/** Highlight empty required fields and return their display names. */
function validateBeforeSubmit() {
  clearFieldErrors();
  /** @type {string[]} */
  const missing = [];

  for (const f of state.fields) {
    if (state.skip[f.name]) continue;

    if (f.type === "text") {
      if (!String(state.values[f.name] ?? "").trim()) {
        missing.push(f.name);
        markFieldError(`#f-${cssId(f.name)}`, f.name);
      }
    } else if (f.type === "bool") {
      // always true/false — no required check
    } else if (f.type === "image") {
      if (!state.images[f.name]) {
        missing.push(f.name);
        const wrap = app.querySelector(`[data-image-field="${cssAttrSelector(f.name)}"]`);
        if (wrap) {
          wrap.classList.add("has-error");
          wrap.insertAdjacentHTML(
            "beforeend",
            `<p class="field-error">กรุณาเลือกไฟล์ หรือติ๊ก “ข้าม”</p>`,
          );
        }
      }
    } else if (f.type === "list") {
      const rows = state.values[f.name] || [];
      if (rows.length === 0) {
        missing.push(`${f.name} (ต้องมีอย่างน้อย 1 แถว)`);
        const rep = app.querySelector(`[data-list-field="${cssAttrSelector(f.name)}"]`);
        if (rep) {
          rep.classList.add("has-error");
          rep.insertAdjacentHTML(
            "beforeend",
            `<p class="field-error">เพิ่มแถว หรือติ๊ก “ข้าม”</p>`,
          );
        }
        continue;
      }
      rows.forEach((row, idx) => {
        for (const item of f.itemFields) {
          if (item.type === "bool" || item.type === "auto") continue;
          if (state.rowSkip[f.name]?.[idx]?.[item.name]) continue;
          if (!String(row[item.name] ?? "").trim()) {
            const label = `${f.name} แถว ${idx + 1}.${item.name}`;
            missing.push(label);
            markFieldError(
              `#l-${cssId(f.name)}-${idx}-${cssId(item.name)}`,
              item.name,
            );
          }
        }
      });
    }
  }

  return missing;
}

function markFieldError(inputSelector, name) {
  let input = app.querySelector(inputSelector);
  if (!input && name) {
    input = app.querySelector(`[data-doc-field="${cssAttrSelector(name)}"]`);
  }
  if (!input) return;
  const field =
    input.closest(".field") ||
    input.closest(".doc-blank-wrap") ||
    input.parentElement;
  if (field) field.classList.add("has-error");
  if (!field?.querySelector(".field-error")) {
    input.insertAdjacentHTML(
      "afterend",
      `<p class="field-error">ยังไม่ได้กรอก — กรอกค่า หรือติ๊ก “ข้าม”</p>`,
    );
  }
}

function cssAttrSelector(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function revokeObjectUrls() {
  for (const u of state.objectUrls) URL.revokeObjectURL(u);
  state.objectUrls = [];
}

function resetFormState() {
  revokeObjectUrls();
  state.file = null;
  state.filename = "";
  state.fields = [];
  state.values = {};
  state.images = {};
  state.skip = {};
  state.rowSkip = {};
  // keep showFullContent preference across re-uploads in the same session
  state.fileContent = "";
  state.fileLayout = [];
  sourceMapSession = null;
  viewTableColWidths.clear();
  multiSlots = [];
  multiActiveId = null;
}

function persistActiveSlot() {
  if (!multiActiveId || !state.file) return;
  const idx = multiSlots.findIndex((s) => s.id === multiActiveId);
  if (idx < 0) return;
  multiSlots[idx] = {
    id: multiActiveId,
    file: state.file,
    filename: state.filename,
    fields: state.fields,
    values: structuredClone(state.values),
    images: { ...state.images },
    skip: structuredClone(state.skip),
    rowSkip: structuredClone(state.rowSkip),
    fileContent: state.fileContent,
    fileLayout: state.fileLayout,
  };
}

function applySlotToState(slot) {
  state.file = slot.file;
  state.filename = slot.filename;
  state.fields = slot.fields;
  state.values = structuredClone(slot.values);
  state.images = { ...slot.images };
  state.skip = structuredClone(slot.skip);
  state.rowSkip = structuredClone(slot.rowSkip);
  state.fileContent = slot.fileContent;
  state.fileLayout = slot.fileLayout;
  multiActiveId = slot.id;
  sourceMapSession = null;
}

function renderMultiTabs() {
  const slots =
    multiSlots.length > 0
      ? multiSlots
      : state.file
        ? [
            {
              id: multiActiveId || "current",
              filename: state.filename || "เทมเพลต",
            },
          ]
        : [];
  if (!slots.length) return "";
  const tabs = slots
    .map((s) => {
      const active = s.id === multiActiveId || slots.length === 1 ? "is-active" : "";
      const canClose = multiSlots.length > 0;
      return `<div class="multi-tab-item ${active}">
        <button type="button" class="multi-tab ${active}" data-multi-id="${escapeAttr(s.id)}" title="${escapeAttr(s.filename)}" role="tab" aria-selected="${active ? "true" : "false"}">${escapeHtml(s.filename)}</button>
        ${canClose ? `<button type="button" class="multi-tab-close" data-multi-close="${escapeAttr(s.id)}" title="ปิดเทมเพลตนี้" aria-label="ปิด ${escapeAttr(s.filename)}">×</button>` : ""}
      </div>`;
    })
    .join("");
  const label =
    slots.length === 1 ? "เทมเพลต" : `${slots.length} เทมเพลต`;
  return `<div class="multi-tabs" role="tablist" aria-label="เทมเพลต">
    <span class="multi-tabs-label">${label}</span>
    ${tabs}
    <button type="button" class="multi-tab multi-tab-add" id="addTemplateTabBtn" title="เพิ่มเทมเพลต .docx">+ เพิ่ม</button>
  </div>`;
}

/** Remove one template slot (wrong upload). Last one → กลับหน้าหลัก. */
async function removeMultiSlot(id) {
  if (!id) return;
  if (multiSlots.length <= 1) {
    if (!(await askGoHome())) return;
    resetFormState();
    void draftClear();
    showBanner("");
    renderEmpty();
    return;
  }
  persistActiveSlot();
  const idx = multiSlots.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const removedActive = multiSlots[idx].id === multiActiveId;
  multiSlots.splice(idx, 1);
  if (removedActive || !multiSlots.some((s) => s.id === multiActiveId)) {
    const next = multiSlots[Math.min(idx, multiSlots.length - 1)];
    applySlotToState(next);
    for (const f of state.fields) {
      if (f.type === "list") ensureListRows(f.name, f.itemFields);
    }
  }
  showBanner(
    multiSlots.length === 1
      ? `ปิดเทมเพลตแล้ว · เหลือ「${multiSlots[0].filename}」`
      : `ปิดเทมเพลตแล้ว · เหลือ ${multiSlots.length} ไฟล์`,
    "success",
  );
  setTimeout(() => showBanner(""), 2400);
  renderForm();
}

/** Clear entered values/images/skip flags but keep the loaded template. */
function clearFilledFields() {
  revokeObjectUrls();
  state.values = {};
  state.images = {};
  state.skip = {};
  state.rowSkip = {};
  for (const f of state.fields) {
    state.skip[f.name] = false;
    if (f.type === "text") state.values[f.name] = "";
    else if (f.type === "bool") state.values[f.name] = false;
    else if (f.type === "image") state.images[f.name] = null;
    else if (f.type === "list") ensureListRows(f.name, f.itemFields);
  }
  scheduleSaveDraft();
}

function skipCheckbox(fieldName, checked) {
  const id = `skip-${cssId(fieldName)}`;
  return `
    <label class="skip-opt" for="${id}">
      <input type="checkbox" id="${id}" data-skip-field="${escapeAttr(fieldName)}" ${checked ? "checked" : ""} />
      ข้าม
    </label>`;
}

function rowSkipCheckbox(listName, rowIdx, itemName, checked) {
  const id = `skip-${cssId(listName)}-${rowIdx}-${cssId(itemName)}`;
  return `
    <label class="skip-opt skip-opt-sm" for="${id}">
      <input type="checkbox" id="${id}"
        data-skip-list="${escapeAttr(listName)}"
        data-skip-row="${rowIdx}"
        data-skip-item="${escapeAttr(itemName)}"
        ${checked ? "checked" : ""} />
      ข้าม
    </label>`;
}

function ensureRowSkip(listName, rowCount, itemFields) {
  if (!Array.isArray(state.rowSkip[listName])) state.rowSkip[listName] = [];
  while (state.rowSkip[listName].length < rowCount) {
    const map = {};
    for (const f of itemFields) map[f.name] = false;
    state.rowSkip[listName].push(map);
  }
  if (state.rowSkip[listName].length > rowCount) {
    state.rowSkip[listName].length = rowCount;
  }
  for (const row of state.rowSkip[listName]) {
    for (const f of itemFields) {
      if (row[f.name] === undefined) row[f.name] = false;
    }
  }
}

function setCreditsVersion(version) {
  const label = version ? `v${String(version).replace(/^v/i, "")}` : "v…";
  const appVer = document.getElementById("appVersion");
  const creditsVer = document.getElementById("creditsVersion");
  if (appVer) appVer.textContent = label;
  if (creditsVer) creditsVer.textContent = label;
}

const AI_KEY_SS = "docx-form-web:geminiKey";
const AI_MODEL_SS = "docx-form-web:geminiModel";

function getClientAiKey() {
  try {
    return String(sessionStorage.getItem(AI_KEY_SS) || "").trim();
  } catch {
    return "";
  }
}

function getClientAiModel() {
  try {
    return String(sessionStorage.getItem(AI_MODEL_SS) || "").trim();
  } catch {
    return "";
  }
}

function setClientAi(apiKey, model) {
  try {
    if (apiKey) sessionStorage.setItem(AI_KEY_SS, String(apiKey).trim());
    if (model) sessionStorage.setItem(AI_MODEL_SS, String(model).trim());
  } catch {
    /* private mode */
  }
}

function clearClientAi() {
  try {
    sessionStorage.removeItem(AI_KEY_SS);
    sessionStorage.removeItem(AI_MODEL_SS);
  } catch {
    /* ignore */
  }
}

function maskClientKey(key) {
  const k = String(key || "");
  if (k.length < 10) return "••••";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** Headers so the server uses THIS user's key for the request only (not stored server-side). */
function aiAuthHeaders(extra = {}) {
  /** @type {Record<string, string>} */
  const h = { ...extra };
  const key = getClientAiKey();
  const model = getClientAiModel();
  if (key) h["X-Gemini-Api-Key"] = key;
  if (model) h["X-Gemini-Model"] = model;
  return h;
}

function applyAiStatus(data) {
  const clientKey = getClientAiKey();
  const clientModel = getClientAiModel();
  aiStatus = {
    connected: !!clientKey || !!data.connected,
    maskedKey: clientKey ? maskClientKey(clientKey) : data.maskedKey || null,
    model: clientModel || data.model || data.defaultModel || "gemini-3.8-flash",
    models: Array.isArray(data.models) ? data.models : geminiModelOptions(),
    defaultModel: data.defaultModel || "gemini-3.8-flash",
    studioUrl: data.studioUrl || "https://aistudio.google.com/apikey",
    byok: data.byok !== false,
  };
}

async function refreshAiStatus() {
  try {
    const res = await fetch("/api/ai/status", { headers: aiAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    applyAiStatus(data);
  } catch {
    /* ignore */
  }
}

async function connectGoogleAi() {
  if (aiStatus.connected || getClientAiKey()) {
    const choice = await askDialog({
      title: "Google AI (คีย์ของคุณ)",
      body: `คีย์อยู่ที่เบราว์เซอร์นี้เท่านั้น ไม่บันทึกลงเซิร์ฟเวอร์ — ${aiStatus.maskedKey || maskClientKey(getClientAiKey())}`,
      select: {
        label: "โมเดล Gemini",
        value: getClientAiModel() || aiStatus.model || aiStatus.defaultModel || "gemini-3.8-flash",
        options: geminiModelOptions(),
      },
      actions: [
        { id: "save", label: "บันทึกโมเดล", kind: "primary" },
        { id: "disconnect", label: "ลบคีย์จากเบราว์เซอร์", kind: "secondary" },
        { id: "abort", label: "ปิด", kind: "ghost" },
      ],
    });
    if (!choice || choice === "abort") return;
    if (choice === "disconnect") {
      clearClientAi();
      await fetch("/api/ai/google", { method: "DELETE", headers: aiAuthHeaders() }).catch(() => {});
      await refreshAiStatus();
      if (state.file) renderForm();
      else applyAiStatus({ connected: false, models: aiStatus.models, byok: true });
      showBanner("ลบคีย์จากเบราว์เซอร์แล้ว", "success");
      setTimeout(() => showBanner(""), 2200);
      return;
    }
    if (choice.id === "save") {
      const model = String(choice.model || "").trim();
      if (!model) {
        showBanner("ยังไม่ได้เลือกโมเดล");
        return;
      }
      setClientAi(getClientAiKey(), model);
      await refreshAiStatus();
      if (state.file) renderForm();
      showBanner(`ใช้โมเดล ${model} แล้ว (คีย์ยังอยู่ที่เครื่องคุณ)`, "success");
      setTimeout(() => showBanner(""), 2800);
    }
    return;
  }

  const result = await askDialog({
    title: "ใส่ Gemini API key ของคุณ",
    body: "ใช้คีย์จาก Google AI Studio ของคุณเอง — เก็บเฉพาะในเบราว์เซอร์นี้ (session) ไม่บันทึกลงเซิร์ฟเวอร์ของแอป เพื่อลดค่าใช้จ่ายฝั่งเรา",
    link: {
      href: aiStatus.studioUrl || "https://aistudio.google.com/apikey",
      label: "เปิด Google AI Studio (สร้าง API key)",
    },
    input: {
      label: "Gemini API key ของคุณ",
      type: "password",
      placeholder: "AIza…",
    },
    select: {
      label: "โมเดล Gemini",
      value: aiStatus.model || aiStatus.defaultModel || "gemini-3.8-flash",
      options: geminiModelOptions(),
    },
    actions: [
      { id: "ok", label: "ใช้คีย์นี้", kind: "primary" },
      { id: "abort", label: "ยกเลิก", kind: "ghost" },
    ],
  });
  if (!result || result === "abort" || result.id !== "ok") return;
  const apiKey = String(result.value || "").trim();
  const model = String(result.model || "").trim();
  if (!apiKey) {
    showBanner("ยังไม่ได้ใส่ API key");
    return;
  }
  if (!model) {
    showBanner("ยังไม่ได้เลือกโมเดล");
    return;
  }
  try {
    const res = await fetch("/api/ai/google", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...aiAuthHeaders() },
      body: JSON.stringify({ apiKey, model, persist: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showBanner(data.error || "ตรวจสอบ API key ไม่สำเร็จ");
      return;
    }
    setClientAi(apiKey, model);
    applyAiStatus({ ...data, connected: true, byok: true });
    if (state.file) renderForm();
    showBanner(`พร้อมใช้คีย์ของคุณ · ${model} — ไม่ได้เก็บลงเซิร์ฟเวอร์`, "success");
    setTimeout(() => showBanner(""), 3600);
  } catch {
    showBanner("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ขณะตรวจสอบ API key");
  }
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health", { headers: aiAuthHeaders() });
    if (!res.ok) throw new Error("bad");
    const data = await res.json().catch(() => ({}));
    setCreditsVersion(data.version || "0.0.0");
    if (data.ai && typeof data.ai === "object") {
      applyAiStatus(data.ai);
    } else {
      await refreshAiStatus();
    }
    statusDot.classList.add("ok");
    statusDot.classList.remove("bad");
    statusText.textContent = aiStatus.connected
      ? `localhost · คีย์คุณ · ${aiStatus.model || "Gemini"}`
      : "localhost · พร้อมใช้";
  } catch {
    statusDot.classList.remove("ok");
    statusDot.classList.add("bad");
    statusText.textContent = "เชื่อมต่อไม่ได้";
    showBanner("เซิร์ฟเวอร์ไม่ตอบสนอง — ลองรีเฟรชหน้า หรือรัน docx-form ใหม่");
  }
}

function summaryText(fields) {
  let text = 0;
  let image = 0;
  let list = 0;
  let bool = 0;
  for (const f of fields) {
    if (f.type === "text") text += 1;
    else if (f.type === "image") image += 1;
    else if (f.type === "bool") bool += 1;
    else list += 1;
  }
  const parts = [];
  if (text) parts.push(`${text} ข้อความ`);
  if (bool) parts.push(`${bool} ติ๊ก`);
  if (image) parts.push(`${image} รูป`);
  if (list) parts.push(`${list} รายการ`);
  return parts.join(" · ") || "ไม่มีฟิลด์";
}

function ensureListRows(name, itemFields) {
  if (!Array.isArray(state.values[name])) {
    state.values[name] = [{}];
  }
  for (const row of state.values[name]) {
    for (const f of itemFields) {
      if (row[f.name] === undefined) {
        if (f.type === "bool") row[f.name] = false;
        else if (f.type === "auto") row[f.name] = ""; // filled on submit by row index
        else row[f.name] = "";
      }
    }
  }
  ensureRowSkip(name, state.values[name].length, itemFields);
}

/**
 * Template-from-selection builder session.
 * @type {null | {
 *   originalFile: File,
 *   taggedFile: File | null,
 *   filename: string,
 *   originalPlainText: string,
 *   layout: any[],
 *   content: string,
 *   replacements: {
 *     id: string,
 *     plainText: string,
 *     occurrence: number,
 *     tag: string,
 *     kind: 'text'|'bool'|'auto'|'list'|'list-table'|'delete-p'|'delete-tr',
 *     label: string,
 *     mode?: 'replace'|'wrap'|'wrap-row'|'delete-p'|'delete-tr'|'fill-empty-tc',
 *     closeTag?: string,
 *     cellIndex?: number,
 *     tableIndex?: number,
 *     rowIndexInTable?: number,
 *     rowOffset?: number,
 *     plainStart?: number, // abs offset in originalPlainText (stable after prior tags)
 *     wrapTag?: string,
 *     wrapOccurrence?: number,
 *     domCellIndex?: number,
 *     trueText?: string,
 *     falseText?: string,
 *     source?: 'existing'|'session',
 *   }[],
 *   busy: boolean,
 * }}
 */
let taggerSession = null;

/**
 * During one preview paint: map each visible `{{…}}` (left→right, doc order) to the
 * matching replacement by *original* plain offset — not by first `tag` string match.
 * Same label in table 2 must not bind to table 1's op.
 * @type {null | ((full: string) => (NonNullable<typeof taggerSession>['replacements'][number] | undefined))}
 */
let taggerChipRepAt = null;

/**
 * @type {{
 *   plainText: string,
 *   occurrence: number,
 *   inTableRow: boolean,
 *   inTable?: boolean,
 *   multiTableRow?: boolean,
 *   multiline: boolean,
 *   rowCells: { text: string, occurrence: number }[],
 *   rowHeaders?: string[],
 *   lines: { text: string, occurrence: number }[],
 *   tableIndex?: number,
 *   rowIndexInTable?: number,
 * } | null}
 */
let taggerPendingSelection = null;

/** True while the user is pointer-dragging a text selection in the tagger preview. */
let taggerPointerSelecting = false;

/** Last plain text copied from the tagger preview (for paste into create-variable fields). */
let lastCopiedTaggerText = "";

/** @type {{ teardown: () => void } | null} */
let taggerSelectionBinding = null;

/** Dialogs + float btn live under #app.sheet which has backdrop-filter — that breaks position:fixed and thrash-repaints the preview. */
function removeTaggerDialogPortals() {
  taggerSelectionBinding?.teardown();
  taggerSelectionBinding = null;
  taggerPointerSelecting = false;
  document.getElementById("taggerDialog")?.remove();
  document.getElementById("taggerEditDialog")?.remove();
  document.getElementById("taggerDeleteDialog")?.remove();
  document.getElementById("taggerCreateBtn")?.remove();
  document.getElementById("taggerDeleteBtn")?.remove();
  document.getElementById("taggerCopyBtn")?.remove();
}

function portalTaggerDialogsToBody() {
  for (const id of [
    "taggerDialog",
    "taggerEditDialog",
    "taggerDeleteDialog",
    "taggerCreateBtn",
    "taggerDeleteBtn",
    "taggerCopyBtn",
  ]) {
    const el = document.getElementById(id);
    if (el) document.body.appendChild(el);
  }
}

function renderEmpty() {
  removeTaggerDialogPortals();
  app.innerHTML = `
    <h1 class="headline">เติมตัวแปรใน Word</h1>
    <p class="subhead">เริ่มจากอัปโหลดเทมเพลต หรือโหลดดราฟที่เคยบันทึกไว้ — อยู่หน้าเดียวกัน</p>
    <div class="upload-entry">
      <button type="button" class="dropzone" id="dropzone" aria-label="อัปโหลดไฟล์ Word">
        <div class="dropzone-kicker">เทมเพลตใหม่</div>
        <div class="dropzone-title">ลากไฟล์ .docx มาวางที่นี่</div>
        <div class="dropzone-sub">หรือ <span class="linkish">เลือกไฟล์</span> — เลือกได้หลายเทมเพลตถ้าเอกสารต้นทางใช้ร่วมกันได้</div>
      </button>
      <section class="draft-entry-panel" id="emptyDraftPanel" aria-label="โหลดดราฟ">
        <div class="draft-entry-head">
          <div>
            <p class="dropzone-kicker">ทำต่อจากเดิม</p>
            <h2 class="draft-entry-title">โหลดดราฟ</h2>
            <p class="draft-entry-sub">งานที่บันทึกในเบราว์เซอร์นี้ · กลับมาทำต่อข้ามวันได้</p>
          </div>
        </div>
        <div class="draft-entry-body" id="emptyDraftList">
          <p class="draft-list-empty">กำลังโหลดรายการดราฟ…</p>
        </div>
      </section>
    </div>
    <input class="sr-only" type="file" id="fileInput" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple />
    <div class="upload-layout upload-layout-secondary">
      <aside class="upload-side">
        <label class="upload-opt" for="showFullContent">
          <input type="checkbox" id="showFullContent" ${state.showFullContent ? "checked" : ""} />
          <span>
            <strong>แสดงรายละเอียดเนื้อหาในไฟล์ทั้งหมด</strong>
            <small>ข้อความเป็นตัวอักษร ส่วนตัวแปรเป็นช่องว่างให้กรอก เหมือนใน Word · อัปโหลดหลาย .docx ได้ถ้าจะแมปจากเอกสารต้นทางชุดเดียว</small>
          </span>
        </label>
        <div class="upload-tips">
          <p class="upload-tips-title">วิธีใส่ตัวแปรในเทมเพลต</p>
          <ul>
            <li><span>ข้อความ</span> <code>{{ชื่อ}}</code></li>
            <li>
              <span>ติ๊ก</span>
              <code>{{พบ?√,×}}</code>
              <small class="tip-note">หลัง <code>?</code> คือข้อความเมื่อจริง,เท็จ — เช่น {{ยินยอม?ใช่,ไม่ใช่}}</small>
            </li>
            <li>
              <span>รันเลข</span>
              <code>{{+ลำดับ}}</code>
              <small class="tip-note">ใช้ได้เฉพาะในลูป {{#…}}…{{/}} — ไล่เลขอัตโนมัติแต่ละแถว/รายการ</small>
            </li>
            <li>
              <span>รูป</span>
              <code>{{logo}}</code>
              <small class="tip-note">วางรูปใน Word → คลิกขวาที่รูป → View Alt Text / Edit Alt Text → ใส่แท็ก เช่น {{logo}}</small>
            </li>
            <li>
              <span>ลิสต์ (ย่อหน้า)</span>
              <code>{{#รายการ}}…{{/}}</code>
              <small class="tip-note">ห่อบล็อกซ้ำนอกตาราง — ข้างในใส่ {{ชื่อ}} / {{+ลำดับ}} ได้</small>
            </li>
            <li>
              <span>ตาราง / ลิสต์</span>
              <code>{{#รายการ}}</code> ต้นแถว · <code>{{/}}</code> ท้ายแถว
              <small class="tip-note">ห่อแถวต้นแบบ · ในเซลล์ใส่ {{คอลัมน์}} หรือ {{+ลำดับ}} · แถวอื่นในตาราง (เช่น ฟุตเตอร์) ไม่ถูกลบอัตโนมัติ</small>
            </li>
          </ul>
          <p class="tip-note tip-tagger-hint">หรือใช้ปุ่ม <strong>สร้างเทมเพลตจากเอกสาร</strong> — ในตารางแต่ละแถวมีกลุ่ม <strong>+ ตัวแปร</strong> / <strong>ลบ</strong> กดได้เลย หรือไฮไลต์ข้อความแล้วใช้ปุ่มลอย</p>
        </div>
      </aside>
      <section class="tagger-entry-card" aria-labelledby="taggerEntryTitle">
        <p class="dropzone-kicker">ทางลัด</p>
        <h2 class="tagger-entry-title" id="taggerEntryTitle">สร้างเทมเพลตจากเอกสาร</h2>
        <p class="tagger-entry-sub">ไฮไลต์ข้อความในไฟล์ตัวอย่าง แล้วแทนด้วย <code>{{ตัวแปร}}</code> — คงเลย์เอาต์ Word เดิม</p>
        <button type="button" class="btn-primary tagger-entry-cta" id="startTaggerMode">เริ่มสร้างเทมเพลต</button>
      </section>
    </div>
    <p class="hint-error" id="uploadError" hidden></p>
  `;

  const dropzone = document.getElementById("dropzone");
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById("fileInput"));
  const uploadError = document.getElementById("uploadError");
  const showFull = /** @type {HTMLInputElement} */ (document.getElementById("showFullContent"));
  const startTagger = document.getElementById("startTaggerMode");

  showFull.addEventListener("change", () => {
    state.showFullContent = showFull.checked;
  });

  const onFiles = (files) => {
    const list = files ? [...files] : [];
    if (!list.length) return;
    state.showFullContent = showFull.checked;
    if (list.length === 1) void parseFile(list[0], uploadError);
    else void parseMultipleTemplates(list, uploadError);
  };

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    onFiles(fileInput.files);
    fileInput.value = "";
  });
  startTagger?.addEventListener("click", () => {
    renderTaggerUpload();
  });
  void refreshEmptyDraftPanel();

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    onFiles(e.dataTransfer?.files);
  });
}

function renderTaggerUpload() {
  taggerSession = null;
  taggerPendingSelection = null;
  removeTaggerDialogPortals();
  app.innerHTML = `
    <div class="file-chip">
      <strong>สร้างเทมเพลตจากเอกสาร</strong>
      <span class="file-meta">อัปโหลด .docx ตัวอย่าง — คงดีไซน์เดิม แทนเฉพาะข้อความที่เลือก</span>
      <div class="file-chip-actions">
        <button type="button" class="linkish" id="taggerBackEmpty">← กลับ</button>
      </div>
    </div>
    <button type="button" class="dropzone" id="taggerDropzone" aria-label="อัปโหลดเอกสารตัวอย่าง">
      <div class="dropzone-title">ลากไฟล์ .docx ตัวอย่างมาวาง</div>
      <div class="dropzone-sub">หรือ <span class="linkish">เลือกไฟล์</span> แล้วไฮไลต์ข้อความเพื่อสร้างตัวแปร</div>
    </button>
    <input class="sr-only" type="file" id="taggerFileInput" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
    <p class="hint-error" id="taggerUploadError" hidden></p>
  `;

  document.getElementById("taggerBackEmpty")?.addEventListener("click", () => {
    taggerSession = null;
    renderEmpty();
  });

  const dropzone = document.getElementById("taggerDropzone");
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById("taggerFileInput"));
  const errorEl = document.getElementById("taggerUploadError");

  const onFiles = (files) => {
    const file = files?.[0];
    if (!file) return;
    void startTaggerSession(file, errorEl);
  };

  dropzone?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", () => onFiles(fileInput.files));
  ["dragenter", "dragover"].forEach((ev) => {
    dropzone?.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone?.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone?.addEventListener("drop", (e) => {
    onFiles(e.dataTransfer?.files);
  });
}

/**
 * @param {File} file
 * @param {HTMLElement | null} errorEl
 */
/**
 * Parse a single {{…}} inner body into kind + label (+ bool texts).
 * @param {string} inner
 */
function parseExistingTagInner(inner) {
  const raw = String(inner || "").trim();
  if (!raw || raw === "/" || raw.startsWith("/")) return null;
  if (raw.startsWith("#")) {
    const label = raw.slice(1).trim();
    if (!label) return null;
    return { kind: /** @type {'list'} */ ("list"), label };
  }
  if (raw.startsWith("+")) {
    const label = raw.slice(1).trim();
    if (!label) return null;
    return { kind: /** @type {'auto'} */ ("auto"), label };
  }
  const q = raw.indexOf("?");
  if (q >= 0) {
    const label = raw.slice(0, q).trim();
    if (!label) return null;
    const rest = raw.slice(q + 1);
    const comma = rest.indexOf(",");
    const trueText = comma >= 0 ? rest.slice(0, comma) : rest;
    const falseText = comma >= 0 ? rest.slice(comma + 1) : "";
    return { kind: /** @type {'bool'} */ ("bool"), label, trueText, falseText };
  }
  return { kind: /** @type {'text'} */ ("text"), label: raw };
}

/**
 * Seed clickable ops for tags already present in an uploaded .docx.
 * plainText = the tag itself (no sample prose left) → cancel/remove is disabled.
 * @param {string} plainText
 * @param {any[]} layout
 */
function seedExistingTaggerReplacements(plainText, layout) {
  /** @type {NonNullable<typeof taggerSession>['replacements']} */
  const ops = [];
  if (!plainText) return ops;
  const listNamesInTables = new Set(
    (Array.isArray(layout) ? layout : [])
      .filter((b) => b?.type === "table" && b.listName)
      .map((b) => String(b.listName)),
  );
  const seen = new Map();
  const re = /\{\{([^{}]+)\}\}/g;
  let m;
  let n = 0;
  while ((m = re.exec(plainText)) !== null) {
    const full = m[0];
    const parsed = parseExistingTagInner(m[1] || "");
    if (!parsed) continue;
    const occ = seen.get(full) || 0;
    seen.set(full, occ + 1);
    let kind = parsed.kind;
    if (kind === "list" && listNamesInTables.has(parsed.label)) kind = "list-table";
    ops.push({
      id: `existing_${n++}_${parsed.label}`,
      plainText: full,
      occurrence: occ,
      tag: full,
      kind,
      label: parsed.label,
      mode: "replace",
      source: "existing",
      ...(kind === "list" || kind === "list-table" ? { closeTag: "{{/}}" } : {}),
      ...(kind === "bool"
        ? { trueText: parsed.trueText || "", falseText: parsed.falseText || "" }
        : {}),
    });
  }
  return ops;
}

async function startTaggerSession(file, errorEl) {
  showBanner("");
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".doc") && !lower.endsWith(".docx")) {
    const msg = "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }
  if (!lower.endsWith(".docx")) {
    const msg = "ไฟล์ต้องเป็น .docx เท่านั้น";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }

  app.setAttribute("aria-busy", "true");
  try {
    const data = await callTemplateTag(file, []);
    const plain = typeof data.plainText === "string" ? data.plainText : "";
    const layout = Array.isArray(data.layout) ? data.layout : [];
    const existing = seedExistingTaggerReplacements(plain, layout);
    taggerSession = {
      originalFile: file,
      taggedFile: existing.length ? file : null,
      filename: file.name,
      originalPlainText: plain,
      layout,
      content: typeof data.content === "string" ? data.content : "",
      replacements: existing,
      busy: false,
    };
    if (existing.length) {
      showBanner(
        `พบแท็กในไฟล์ ${existing.length} รายการ — คลิกเพื่อแก้ชื่อได้ (ยกเลิกแท็กเดิมไม่ได้)`,
        "success",
      );
      setTimeout(() => showBanner(""), 4200);
    }
    renderTaggerWorkspace();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "อ่านเอกสารไม่สำเร็จ";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
  } finally {
    app.removeAttribute("aria-busy");
  }
}

/**
 * @param {File} file
 * @param {{ id: string, plainText: string, occurrence: number, tag: string }[]} replacements
 */
async function callTemplateTag(file, replacements) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("replacements", JSON.stringify(replacements));
  const res = await fetch("/api/template/tag", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "แท็กเทมเพลตไม่สำเร็จ");
  }
  return data;
}

function base64ToFile(b64, filename) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename || "template.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/**
 * Apply current session replacements to the original docx.
 * @returns {Promise<boolean>} false when the API/tag step failed
 */
async function applyTaggerReplacements() {
  if (!taggerSession) return false;
  taggerSession.busy = true;
  renderTaggerWorkspace();
  try {
    // Existing file tags are already in originalFile. Re-sending unchanged
    // {{#…}} markers as mode=replace fails validateTag ("ไม่ใช่แท็กลูป").
    // Only send them when renamed (tag !== plainText).
    const payload = taggerSession.replacements
      .filter((r) => !(r.source === "existing" && r.tag === r.plainText))
      .map((r) => {
        const pinned = ensureTaggerPlainStart(r);
        return {
          id: r.id,
          plainText: r.plainText,
          occurrence: r.occurrence,
          tag: isTaggerDeleteOp(r) ? "" : r.tag,
          mode: r.mode || (isTaggerDeleteOp(r) ? r.kind : "replace"),
          ...(r.closeTag ? { closeTag: r.closeTag } : {}),
          ...(typeof r.cellIndex === "number" ? { cellIndex: r.cellIndex } : {}),
          ...(typeof r.tableIndex === "number" && r.tableIndex >= 0
            ? { tableIndex: r.tableIndex }
            : {}),
          ...(typeof r.rowIndexInTable === "number" && r.rowIndexInTable >= 0
            ? { rowIndexInTable: r.rowIndexInTable }
            : {}),
          ...(typeof r.rowOffset === "number" && r.rowOffset !== 0
            ? { rowOffset: r.rowOffset }
            : {}),
          ...(typeof pinned === "number" && pinned >= 0 ? { plainStart: pinned } : {}),
          ...(r.wrapTag ? { wrapTag: r.wrapTag } : {}),
          ...(typeof r.wrapOccurrence === "number" && r.wrapOccurrence >= 0
            ? { wrapOccurrence: r.wrapOccurrence }
            : {}),
          ...(typeof r.domCellIndex === "number" && r.domCellIndex >= 0
            ? { domCellIndex: r.domCellIndex }
            : {}),
        };
      });
    const data = await callTemplateTag(taggerSession.originalFile, payload);
    taggerSession.layout = Array.isArray(data.layout) ? data.layout : [];
    taggerSession.content = typeof data.content === "string" ? data.content : "";
    if (typeof data.docxBase64 === "string") {
      taggerSession.taggedFile = base64ToFile(
        data.docxBase64,
        data.filename || taggerSession.filename.replace(/\.docx$/i, "") + "-tagged.docx",
      );
    }
    if (Array.isArray(data.warnings) && data.warnings.length) {
      showBanner(`แท็กแล้ว แต่บางเซลล์ว่างใส่ไม่สำเร็จ: ${data.warnings[0]}`);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "แท็กไม่สำเร็จ";
    const overlapMatch = msg.match(/ช่วงแท็กซ้อนกัน:\s*"([^"]*)"\s*กับ\s*"([^"]*)"/);
    const friendly = /ช่วงลิสต์ซ้อนกัน/.test(msg)
      ? "แถวนี้ถูกทำเป็นลิสต์ไปแล้ว — สร้างฟิลด์ย่อย (ข้อความ/รันเลข) ในแถวได้ แต่สร้างลิสต์ซ้อนไม่ได้"
      : overlapMatch
        ? `ข้อความ «${overlapMatch[1]}» ไปชนกับ «${overlapMatch[2]}» ที่แท็กไว้แล้ว — ลบแท็กที่ซ้อนแล้วทำใหม่ หรือเลือกช่วงให้ไม่ทับกัน`
        : /ช่วงแท็กซ้อนกัน/.test(msg)
          ? "ข้อความที่เลือกไปชนกับแท็กอื่นที่ทับช่วงเดียวกัน — ลบแท็กที่ซ้อนแล้วทำใหม่ หรือเลือกช่วงให้ไม่ทับกัน"
          : msg;
    showBanner(friendly);
    return false;
  } finally {
    if (taggerSession) taggerSession.busy = false;
    renderTaggerWorkspace();
  }
}

/**
 * Anchor of a replacement in the stable original <w:t> plain (before any tags).
 * Used to order same-named tags so preview chips bind by document position.
 * @param {NonNullable<typeof taggerSession>['replacements'][number]} r
 * @param {string} original
 */
function replacementPlainStart(r, original) {
  if (!r) return Number.MAX_SAFE_INTEGER;
  const needle = String(r.plainText ?? "");
  if (needle) {
    const at = nthOccurrenceStart(original, needle, Number(r.occurrence) || 0);
    if (at >= 0) return at;
  }
  // Empty-cell fill / pinned row ops: fall back to table/row/cell order.
  if (typeof r.tableIndex === "number" && r.tableIndex >= 0) {
    const row = typeof r.rowIndexInTable === "number" ? r.rowIndexInTable : 0;
    const cell = typeof r.cellIndex === "number" ? r.cellIndex : 0;
    return 1e15 + r.tableIndex * 1e8 + row * 1e4 + cell;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Start sequential chip→replacement resolve for one paint of the preview. */
function beginTaggerChipRepResolve() {
  const original = taggerSession?.originalPlainText || "";
  const reps = (taggerSession?.replacements || []).filter((r) => !isTaggerDeleteOp(r));

  /** @type {Map<string, typeof reps>} */
  const byTag = new Map();
  /** @type {Map<string, typeof reps>} */
  const byClose = new Map();

  for (const r of reps) {
    if (r.tag) {
      if (!byTag.has(r.tag)) byTag.set(r.tag, []);
      byTag.get(r.tag).push(r);
    }
    const isWrap =
      r.mode === "wrap" ||
      r.mode === "wrap-row" ||
      r.kind === "list" ||
      r.kind === "list-table";
    if (isWrap) {
      const c = r.closeTag || "{{/}}";
      if (!byClose.has(c)) byClose.set(c, []);
      byClose.get(c).push(r);
    }
  }

  const byStart = (a, b) =>
    replacementPlainStart(a, original) - replacementPlainStart(b, original) ||
    String(a.id).localeCompare(String(b.id));
  for (const list of byTag.values()) list.sort(byStart);
  for (const list of byClose.values()) list.sort(byStart);

  /** @type {Map<string, number>} */
  const usedTag = new Map();
  /** @type {Map<string, number>} */
  const usedClose = new Map();

  taggerChipRepAt = (full) => {
    const tagList = byTag.get(full);
    if (tagList?.length) {
      const i = usedTag.get(full) || 0;
      usedTag.set(full, i + 1);
      return tagList[Math.min(i, tagList.length - 1)];
    }
    const closeList = byClose.get(full);
    if (closeList?.length) {
      const i = usedClose.get(full) || 0;
      usedClose.set(full, i + 1);
      return closeList[Math.min(i, closeList.length - 1)];
    }
    return undefined;
  };
}

function endTaggerChipRepResolve() {
  taggerChipRepAt = null;
}

function renderTaggerWorkspace() {
  if (!taggerSession) {
    renderTaggerUpload();
    return;
  }
  const s = taggerSession;
  const chips = s.replacements
    .map((r) => {
      const isDelete = r.kind === "delete-p" || r.kind === "delete-tr" || r.mode === "delete-p" || r.mode === "delete-tr";
      const isList = r.kind === "list" || r.kind === "list-table";
      const label = isDelete
        ? "ลบแถว"
        : isList
          ? `${r.tag}…${r.closeTag || "{{/}}"}`
          : r.tag;
      const kindMeta = isDelete
        ? {
            hint: r.kind === "delete-tr" || r.mode === "delete-tr" ? "ลบแถวตาราง" : "ลบย่อหน้า",
            cls: "is-delete",
          }
        : r.kind === "list-table"
          ? { hint: "ตาราง/ลิสต์", cls: "is-list-table" }
          : r.kind === "list"
            ? { hint: "ลิสต์", cls: "is-list" }
            : r.kind === "auto"
              ? { hint: "รันเลข", cls: "is-auto" }
              : r.kind === "bool"
                ? { hint: "ติ๊ก", cls: "is-bool" }
                : { hint: "ข้อความ", cls: "is-text" };
      const fromFile = r.source === "existing";
      const srcText = fromFile
        ? "ในไฟล์เดิม · แก้ชื่อได้ / ยกเลิกไม่ได้"
        : `${r.plainText.slice(0, 48)}${r.plainText.length > 48 ? "…" : ""}`;
      return `
      <button type="button" class="tagger-chip-list-item ${kindMeta.cls}${fromFile ? " is-existing" : ""}" data-tagger-edit="${escapeAttr(r.id)}" title="${fromFile ? "คลิกเพื่อแก้ไขแท็กในไฟล์" : "คลิกเพื่อแก้หรือยกเลิก"}">
        <span class="tagger-chip-kind">${escapeHtml(kindMeta.hint)}${fromFile ? " · ไฟล์เดิม" : ""}</span>
        <code>${escapeHtml(label)}</code>
        <span class="tagger-chip-src">${escapeHtml(srcText)}</span>
      </button>`;
    })
    .join("");

  beginTaggerChipRepResolve();
  let previewHtml = "";
  try {
    previewHtml = renderTaggerPreview(s.layout, s.content);
  } finally {
    endTaggerChipRepResolve();
  }

  removeTaggerDialogPortals();
  app.innerHTML = `
    <div class="file-chip">
      <strong>${escapeHtml(s.filename)}</strong>
      <span class="file-meta">โหมดสร้างเทมเพลต · ${s.replacements.length} รายการ</span>
      <div class="file-chip-actions">
        <button type="button" class="linkish" id="taggerCancel">ยกเลิก</button>
      </div>
    </div>
    <p class="tagger-help">ลากเลือกข้อความในพรีวิว แล้วใช้ปุ่มลอยข้างช่วงที่เลือก: <strong>สร้างตัวแปร</strong> · <strong>ลบแถว</strong> · <strong>คัดลอกข้อความ</strong> — ข้อความ <code>{{ชื่อ}}</code> · รันเลข <code>{{+ชื่อ}}</code> (ในลูป) · <strong>ลิสต์ย่อหน้า</strong> / <strong>ตาราง</strong> ด้วย <code>{{#รายการ}}…{{/}}</code></p>
    <div class="doc-sheet tagger-sheet" id="taggerPreview">
      <div class="doc-sheet-label">พรีวิวเอกสาร (เลือกข้อความได้)</div>
      <div class="doc-body tagger-select-root" id="taggerSelectRoot">${previewHtml}</div>
    </div>
    <div class="tagger-chip-bar" id="taggerChipBar" ${s.replacements.length ? "" : "hidden"}>
      <span class="tagger-chip-bar-label">รายการแท็ก (คลิกเพื่อแก้ไข · แท็กจากไฟล์เดิมยกเลิกไม่ได้)</span>
      <div class="tagger-chip-list">${chips}</div>
    </div>
    <div class="sticky-bar tagger-actions">
      <button type="button" class="btn-primary" id="taggerCreateFromSel" disabled title="ลากเลือกข้อความในพรีวิวก่อน">สร้างจากที่เลือก</button>
      <button type="button" class="btn-secondary" id="taggerDownload" ${(s.taggedFile || s.replacements.length) && !s.busy ? "" : "disabled"}>ดาวน์โหลดเทมเพลต</button>
      <button type="button" class="btn-primary" id="taggerOpenFill" ${(s.taggedFile || s.replacements.length) && !s.busy ? "" : "disabled"}>ใช้กรอกต่อ</button>
    </div>
    <button type="button" class="tagger-float-btn" id="taggerCreateBtn" hidden aria-hidden="true">สร้างตัวแปร</button>
    <button type="button" class="tagger-float-btn tagger-float-delete" id="taggerDeleteBtn" hidden aria-hidden="true">ลบแถว</button>
    <button type="button" class="tagger-float-btn tagger-float-copy" id="taggerCopyBtn" hidden aria-hidden="true">คัดลอกข้อความ</button>
    <div class="tagger-dialog-backdrop" id="taggerDialog" hidden>
      <div class="tagger-dialog tagger-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="taggerDialogTitle">
        <h2 id="taggerDialogTitle">สร้างตัวแปร</h2>
        <p class="tagger-dialog-sample" id="taggerDialogSample"></p>
        <label class="field-label" for="taggerVarName" id="taggerVarNameLabel">ชื่อตัวแปร</label>
        <div class="tagger-field-row">
          <input type="text" id="taggerVarName" class="field-input" autocomplete="off" placeholder="เช่น customer_name, พบ หรือ items" />
          <button type="button" class="btn-secondary btn-compact tagger-paste-btn" data-paste-into="taggerVarName" title="วางข้อความที่คัดลอกไว้">วาง</button>
        </div>
        <p class="tagger-paste-hint" id="taggerPasteHint" hidden></p>
        <fieldset class="tagger-kind">
          <legend>ประเภท</legend>
          <label class="kind-text" data-kind="text"><input type="radio" name="taggerKind" value="text" checked /> ข้อความ <code>{{ชื่อ}}</code></label>
          <label class="kind-bool" data-kind="bool"><input type="radio" name="taggerKind" value="bool" /> ติ๊ก <code>{{ชื่อ?จริง,เท็จ}}</code></label>
          <label class="kind-auto" id="taggerKindAuto" data-kind="auto"><input type="radio" name="taggerKind" value="auto" /> รันเลข (auto) <code>{{+ชื่อ}}</code></label>
          <label class="kind-list" id="taggerKindList" data-kind="list" hidden><input type="radio" name="taggerKind" value="list" /> ลิสต์ (ย่อหน้า) <code>{{#ชื่อ}}…{{/}}</code></label>
          <label class="kind-list-table" id="taggerKindTable" data-kind="list-table" hidden><input type="radio" name="taggerKind" value="list-table" /> ตาราง/ลิสต์ (แถว) <code>{{#ชื่อ}}…{{/}}</code></label>
        </fieldset>
        <p class="tagger-kind-hint" id="taggerKindHint" hidden></p>
        <div class="tagger-bool-fields" id="taggerBoolFields" hidden>
          <label class="field-label" for="taggerTrueText">ข้อความเมื่อติ๊ก (จริง)</label>
          <div class="tagger-field-row">
            <input type="text" id="taggerTrueText" class="field-input" />
            <button type="button" class="btn-secondary btn-compact tagger-paste-btn" data-paste-into="taggerTrueText" title="วางข้อความที่คัดลอกไว้">วาง</button>
          </div>
          <label class="field-label" for="taggerFalseText">ข้อความเมื่อไม่ติ๊ก (เท็จ)</label>
          <div class="tagger-field-row">
            <input type="text" id="taggerFalseText" class="field-input" placeholder="ว่างได้" />
            <button type="button" class="btn-secondary btn-compact tagger-paste-btn" data-paste-into="taggerFalseText" title="วางข้อความที่คัดลอกไว้">วาง</button>
          </div>
        </div>
        <div class="tagger-list-fields" id="taggerListFields" hidden>
          <p class="tagger-list-hint" id="taggerListHint"></p>
          <div id="taggerListItemFields"></div>
        </div>
        <p class="hint-error" id="taggerDialogError" hidden></p>
        <div class="tagger-dialog-actions">
          <button type="button" class="btn-secondary" id="taggerDialogCancel">ยกเลิก</button>
          <button type="button" class="btn-primary" id="taggerDialogConfirm">ยืนยัน</button>
        </div>
      </div>
    </div>
    <div class="tagger-dialog-backdrop" id="taggerDeleteDialog" hidden>
      <div class="tagger-dialog" role="dialog" aria-modal="true" aria-labelledby="taggerDeleteTitle">
        <h2 id="taggerDeleteTitle">ลบแถว</h2>
        <p class="tagger-dialog-sample" id="taggerDeleteSample"></p>
        <p class="tagger-kind-hint" id="taggerDeleteHint"></p>
        <div class="tagger-dialog-actions">
          <button type="button" class="btn-secondary" id="taggerDeleteCancel">ยกเลิก</button>
          <button type="button" class="btn-secondary danger" id="taggerDeleteConfirm">ยืนยันลบ</button>
        </div>
      </div>
    </div>
    <div class="tagger-dialog-backdrop" id="taggerEditDialog" hidden>
      <div class="tagger-dialog tagger-dialog-wide" role="dialog" aria-modal="true">
        <h2 id="taggerEditTitle">แก้ตัวแปร</h2>
        <p class="tagger-dialog-sample" id="taggerEditSample"></p>
        <div id="taggerEditFields" class="tagger-edit-fields" hidden></div>
        <p class="tagger-edit-preview-label">แท็ก</p>
        <code id="taggerEditTag"></code>
        <p class="hint-error" id="taggerEditError" hidden></p>
        <div class="tagger-dialog-actions">
          <button type="button" class="btn-secondary" id="taggerEditClose">ปิด</button>
          <button type="button" class="btn-primary" id="taggerEditSave" hidden>บันทึก</button>
          <button type="button" class="btn-secondary danger" id="taggerEditRemove">ยกเลิกแท็ก</button>
        </div>
      </div>
    </div>
  `;

  // Escape .sheet backdrop-filter containing block so fixed = viewport.
  portalTaggerDialogsToBody();

  document.getElementById("taggerCancel")?.addEventListener("click", () => {
    taggerSession = null;
    taggerPendingSelection = null;
    renderEmpty();
  });
  document.getElementById("taggerDownload")?.addEventListener("click", () => downloadTaggedTemplate());
  document.getElementById("taggerOpenFill")?.addEventListener("click", () => openTaggedInFillForm());
  document.getElementById("taggerCreateFromSel")?.addEventListener("click", () => openTaggerCreateDialog());
  document.getElementById("taggerCreateBtn")?.addEventListener("click", () => openTaggerCreateDialog());
  document.getElementById("taggerDeleteBtn")?.addEventListener("click", () => openTaggerDeleteDialog());
  document.getElementById("taggerCopyBtn")?.addEventListener("click", () => void copyTaggerSelectionText());
  document.getElementById("taggerDialog")?.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-paste-into]");
    if (!btn) return;
    const targetId = btn.getAttribute("data-paste-into");
    if (!targetId) return;
    void pasteCopiedTaggerTextInto(targetId);
  });
  document.getElementById("taggerDialogCancel")?.addEventListener("click", () => closeTaggerDialog());
  document.getElementById("taggerDialogConfirm")?.addEventListener("click", () => void confirmTaggerVariable());
  document.getElementById("taggerDeleteCancel")?.addEventListener("click", () => closeTaggerDeleteDialog());
  document.getElementById("taggerDeleteConfirm")?.addEventListener("click", () => void confirmTaggerDelete());
  document.getElementById("taggerEditClose")?.addEventListener("click", () => {
    const el = document.getElementById("taggerEditDialog");
    if (el) el.hidden = true;
  });
  document.getElementById("taggerEditSave")?.addEventListener("click", () => {
    void saveTaggerEdit();
  });
  document.getElementById("taggerEditRemove")?.addEventListener("click", () => {
    const id = document.getElementById("taggerEditRemove")?.getAttribute("data-id");
    if (id) void removeTaggerReplacement(id);
  });
  document.getElementById("taggerEditFields")?.addEventListener("input", () => {
    syncTaggerEditTagPreview();
  });
  document.getElementById("taggerEditFields")?.addEventListener("change", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t?.getAttribute?.("name") === "taggerEditKind") {
      syncTaggerEditKindFields();
    }
    syncTaggerEditTagPreview();
  });

  for (const radio of /** @type {NodeListOf<HTMLInputElement>} */ (
    document.querySelectorAll('input[name="taggerKind"]')
  )) {
    radio.addEventListener("change", () => {
      syncTaggerKindFields();
      renderTaggerListItemFields();
    });
  }

  for (const btn of document.querySelectorAll("[data-tagger-edit]")) {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-tagger-edit");
      if (id) openTaggerEditDialog(id);
    });
  }

  const selectRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  if (selectRoot) {
    decorateTaggerListFrames(selectRoot);
    decorateTaggerTableRowActions(selectRoot);
  }

  bindTaggerSelection();
}

/**
 * @param {any[]} layout
 * @param {string} content
 */
function renderTaggerPreview(layout, content) {
  if (layout?.length) {
    return layout
      .map((b) => {
        if (b.type === "text") return renderTaggerPlainBlock(b.text || "");
        if (b.type === "table") return renderTaggerTableBlock(b);
        return "";
      })
      .join("");
  }
  if (content) return renderTaggerPlainBlock(content);
  return `<p class="dropzone-hint">ไม่มีข้อความในไฟล์</p>`;
}

function renderTaggerPlainBlock(text) {
  return `<div class="tagger-para">${renderTaggerRichText(text)}</div>`;
}

/**
 * @param {string} inner
 * @param {{ kind?: string, tag?: string, label?: string } | undefined} rep
 */
function classifyTaggerChip(inner, rep) {
  let chipKind = "text";
  let chipTitle = "ข้อความ";
  if (rep?.kind === "bool" || (!rep && inner.includes("?"))) {
    chipKind = "bool";
    chipTitle = "ติ๊ก";
  } else if (rep?.kind === "auto" || (!rep && inner.startsWith("+"))) {
    chipKind = "auto";
    chipTitle = "รันเลข (auto)";
  } else if (
    rep?.kind === "list" ||
    rep?.kind === "list-table" ||
    inner.startsWith("#") ||
    inner === "/" ||
    inner.startsWith("/")
  ) {
    chipKind = rep?.kind === "list-table" ? "list-table" : "list";
    chipTitle = chipKind === "list-table" ? "ตาราง/ลิสต์" : "ลิสต์";
  } else if (rep?.kind === "text") {
    chipKind = "text";
    chipTitle = "ข้อความ";
  }
  return { chipKind, chipTitle };
}

/**
 * @param {string} full
 * @param {string} inner
 * @param {{ id?: string, kind?: string, tag?: string, label?: string } | undefined} rep
 */
function renderTaggerChipHtml(full, inner, rep) {
  const idAttr = rep?.id ? ` data-tag-id="${escapeAttr(rep.id)}"` : "";
  const { chipKind, chipTitle } = classifyTaggerChip(inner, rep);
  const tip = rep?.id ? `${chipTitle} — คลิกเพื่อแก้ชื่อ` : chipTitle;
  return `<span class="tagger-chip is-${chipKind}" contenteditable="false"${idAttr} title="${escapeAttr(tip)}">${escapeHtml(full)}</span>`;
}

/** Short badge for list frames — name already appears on {{#…}} chips. */
function taggerListFrameLabelText(kind) {
  return kind === "list-table" ? "ตาราง/ลิสต์" : "ลิสต์";
}

/** @param {string} name @param {'list'|'list-table'} kind @param {string} innerHtml */
function renderTaggerListFrame(name, kind, innerHtml) {
  const shown = name || "รายการ";
  return `<span class="tagger-list-frame is-${kind}" data-list-name="${escapeAttr(shown)}"><span class="tagger-list-frame-label">${escapeHtml(taggerListFrameLabelText(kind))}</span>${innerHtml}</span>`;
}

function renderTaggerRichText(text) {
  const re = /\{\{([^{}]+)\}\}/g;
  /** @type {{ name: string, kind: 'list'|'list-table', html: string }[]} */
  const stack = [];
  let html = "";
  let last = 0;
  let m;

  const append = (chunk) => {
    if (!chunk) return;
    if (stack.length) stack[stack.length - 1].html += chunk;
    else html += chunk;
  };

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) append(formatPlainText(text.slice(last, m.index)));
    const full = m[0];
    const inner = (m[1] || "").trim();
    // Prefer position-ordered resolver (set during preview paint). Never .find by tag
    // alone — duplicate names across tables would always hit the first op.
    const rep = taggerChipRepAt
      ? taggerChipRepAt(full)
      : taggerSession?.replacements.find((r) => r.tag === full);
    const chipHtml = renderTaggerChipHtml(full, inner, rep);
    const isClose = inner === "/" || inner.startsWith("/");
    const isOpen =
      !isClose &&
      (inner.startsWith("#") ||
        ((rep?.kind === "list" || rep?.kind === "list-table") && rep.tag === full));

    if (isOpen) {
      const name = inner.startsWith("#")
        ? inner.slice(1).trim()
        : String(rep?.label || "").trim();
      const kind = rep?.kind === "list-table" ? "list-table" : "list";
      stack.push({ name, kind, html: chipHtml });
    } else if (isClose && stack.length) {
      const frame = stack.pop();
      frame.html += chipHtml;
      append(renderTaggerListFrame(frame.name, frame.kind, frame.html));
    } else {
      append(chipHtml);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) append(formatPlainText(text.slice(last)));
  while (stack.length) {
    const frame = stack.pop();
    append(renderTaggerListFrame(frame.name, frame.kind, frame.html));
  }
  return html;
}

/**
 * Select an entire table row in the tagger preview so create/delete can map cells.
 * @param {HTMLTableRowElement} tr
 */
function selectTaggerTableRow(tr) {
  if (!tr) return false;
  const cells = [...tr.querySelectorAll(":scope > td, :scope > th")];
  if (!cells.length) return false;
  const range = document.createRange();
  try {
    range.setStartBefore(cells[0]);
    range.setEndAfter(cells[cells.length - 1]);
  } catch {
    try {
      range.selectNodeContents(cells[0]);
    } catch {
      return false;
    }
  }
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return true;
}

/**
 * Preview table index among #taggerSelectRoot tables (matches Word <w:tbl> order).
 * @param {HTMLTableElement} table
 */
function getTaggerPreviewTableIndex(table) {
  const root = document.getElementById("taggerSelectRoot");
  if (!root || !table) return -1;
  return [...root.querySelectorAll("table.doc-table, table")].indexOf(table);
}

/**
 * Preview rows shrink after delete-tr; session always replays on originalFile.
 * Map preview row → original row by re-inserting prior deletes in this table
 * (same idea as chip binding: identity is original position, not current DOM index).
 * @param {number} tableIndex
 * @param {number} previewRowIndex
 */
function previewRowIndexToOriginal(tableIndex, previewRowIndex) {
  let orig = previewRowIndex;
  if (!taggerSession?.replacements?.length) return orig;
  const prior = taggerSession.replacements
    .filter(
      (r) =>
        (r.mode === "delete-tr" || r.kind === "delete-tr") &&
        r.tableIndex === tableIndex &&
        typeof r.rowIndexInTable === "number",
    )
    .map((r) => /** @type {number} */ (r.rowIndexInTable))
    .sort((a, b) => a - b);
  for (const d of prior) {
    if (d <= orig) orig += 1;
  }
  return orig;
}

/**
 * @param {HTMLTableRowElement} tr
 * @returns {{ tableIndex: number, rowIndexInTable: number, previewRowIndex: number } | null}
 */
function resolveTaggerDeleteRowPin(tr) {
  const table = /** @type {HTMLTableElement | null} */ (tr?.closest?.("table"));
  if (!table) return null;
  const tableIndex = getTaggerPreviewTableIndex(table);
  if (tableIndex < 0) return null;
  const rows = /** @type {HTMLTableRowElement[]} */ ([...table.querySelectorAll("tr")]);
  const previewRowIndex = rows.indexOf(tr);
  if (previewRowIndex < 0) return null;
  return {
    tableIndex,
    previewRowIndex,
    rowIndexInTable: previewRowIndexToOriginal(tableIndex, previewRowIndex),
  };
}

/**
 * Delete an empty/unmapped table row pinned by original table/row index.
 * @param {HTMLTableRowElement} tr
 * @returns {{ ops: object[], summary: string, detail: string } | { error: string }}
 */
function buildTaggerDeleteOpsForUnmappedRow(tr) {
  if (!taggerSession || !tr) return { error: "ไม่พบแถวตาราง" };
  const root = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  const pin = resolveTaggerDeleteRowPin(tr);
  if (!root || !pin) return { error: "ไม่พบตาราง" };
  const table = tr.closest("table");
  const rows = /** @type {HTMLTableRowElement[]} */ ([...table.querySelectorAll("tr")]);
  const original = taggerSession.originalPlainText || "";
  const idBase = `d${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  // Optional neighbor plain for the confirm dialog preview only.
  let preview = `(แถวที่ ${pin.rowIndexInTable + 1} ในตารางที่ ${pin.tableIndex + 1})`;
  let locatorPlain = "";
  for (let i = pin.previewRowIndex - 1; i >= 0; i--) {
    if (!selectTaggerTableRow(rows[i])) continue;
    const info = readTaggerSelection(root);
    if (!info?.inTableRow) continue;
    const rowParts = (info.rowCells || []).filter((c) => c.text && c.occurrence >= 0);
    if (!rowParts.length) continue;
    const spanned = resolveTableRowPlainSpan(rowParts, original);
    if (!spanned?.plainText) continue;
    locatorPlain = spanned.plainText;
    preview =
      spanned.plainText.length > 48
        ? `${spanned.plainText.slice(0, 48)}…`
        : spanned.plainText;
    break;
  }

  return {
    ops: [
      {
        id: idBase,
        // Pin by table/row index only — do not locate via plain (avoids jumping tables).
        plainText: "",
        occurrence: 0,
        tag: "",
        mode: "delete-tr",
        kind: "delete-tr",
        label: "ลบแถวตาราง",
        tableIndex: pin.tableIndex,
        rowIndexInTable: pin.rowIndexInTable,
      },
    ],
    summary: `จะลบแถวว่าง/ไม่มีข้อความ (ตารางที่ ${pin.tableIndex + 1} แถวที่ ${pin.rowIndexInTable + 1}${locatorPlain ? ` · ใกล้ “${preview}”` : ""})`,
    detail: "ลบ <w:tr> ทั้งแถวจากไฟล์ .docx — คงหัวตารางและแถวอื่นไว้",
  };
}

/**
 * Build pending selection from a table row and open create or delete dialog.
 * @param {HTMLTableRowElement} tr
 * @param {'add'|'delete'} action
 */
function activateTaggerTableRowAction(tr, action) {
  if (!taggerSession || !tr) return;
  if (taggerSession.busy) {
    showBanner("กำลังประมวลผลอยู่ — รอสักครู่", "progress");
    return;
  }
  const root = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  if (!root || !root.contains(tr)) return;
  if (!selectTaggerTableRow(tr)) {
    showBanner("เลือกแถวตารางนี้ไม่ได้");
    return;
  }
  const info = readTaggerSelection(root);
  if (!info || !info.inTableRow) {
    if (action === "delete") {
      const built = buildTaggerDeleteOpsForUnmappedRow(tr);
      if ("error" in built) {
        showBanner(built.error);
        return;
      }
      showBanner("");
      openTaggerDeleteDialogWithOps(built);
      return;
    }
    showBanner("จับคู่แถวกับข้อความต้นฉบับไม่ได้ — ลองเลือกข้อความในเซลล์เอง แล้วใช้ปุ่มลอย");
    return;
  }
  taggerPendingSelection = info;
  showBanner("");
  if (action === "delete") {
    const built = buildTaggerDeleteOps(info, tr);
    if ("error" in built) {
      showBanner(built.error);
      return;
    }
    openTaggerDeleteDialogWithOps(built);
  } else openTaggerCreateDialog();
}

/**
 * Per-row chrome in tables: compact group with add-variable / delete-row.
 * @param {HTMLElement} root
 */
function decorateTaggerTableRowActions(root) {
  if (!root) return;
  for (const tr of root.querySelectorAll("table.doc-table tr")) {
    if (tr.querySelector(".tagger-row-group")) continue;
    const firstCell = tr.querySelector(":scope > td, :scope > th");
    if (!firstCell) continue;
    // Drop standalone list-frame labels — the row group replaces them.
    for (const lab of firstCell.querySelectorAll(".tagger-list-frame-label")) {
      if (!lab.closest(".tagger-row-group")) lab.remove();
    }
    const listName = (tr.getAttribute("data-list-name") || "").trim();
    // List chrome only on rows that actually have tag chips — never paint sibling
    // rows just because the session has a single wrap-row.
    const hasChips = [...tr.querySelectorAll(".tagger-chip")].some((chip) => {
      if (chip.getAttribute("data-tag-id")) return true;
      const t = normalizeTaggerDomPlain(chip.textContent || "").trim();
      return /^\{\{[^{}]+\}\}$/.test(t);
    });
    const wrapRep = hasChips ? findTaggerWrapRepForRow(tr) : null;
    const asList = !!wrapRep;
    const wrapLabel =
      (wrapRep?.label || "").trim() ||
      (asList ? listName : "") ||
      (wrapRep?.tag?.startsWith("{{#")
        ? String(wrapRep.tag).replace(/^\{\{#|\}\}$/g, "").trim()
        : "");
    const group = document.createElement("div");
    group.className = `tagger-row-group${asList ? " is-list-table" : ""}${wrapRep ? " is-tagged" : ""}`;
    group.setAttribute("contenteditable", "false");
    group.setAttribute("data-tagger-row-chrome", "1");
    const label = asList ? taggerListFrameLabelText("list-table") : "แถว";
    const nameHtml = asList && wrapLabel
      ? `<button type="button" class="tagger-row-group-name tagger-row-list-edit" data-list-name="${escapeAttr(wrapLabel)}" title="คลิกเพื่อแก้ชื่อลิสต์">${escapeHtml(wrapLabel)}</button>`
      : asList
        ? `<button type="button" class="tagger-row-group-name tagger-row-list-edit is-unnamed" title="คลิกเพื่อตั้งชื่อลิสต์">ตั้งชื่อลิสต์</button>`
        : "";
    const actsHtml = wrapRep
      ? `<button type="button" class="tagger-row-group-hint tagger-row-edit-tags" title="แก้ชื่อลิสต์ของแถวนี้">แก้ชื่อลิสต์</button>`
      : `
      <button type="button" class="tagger-row-act tagger-row-act-add" title="เพิ่มตัวแปรในแถวนี้">+ ตัวแปร</button>
      <button type="button" class="tagger-row-act tagger-row-act-del" title="ลบแถวนี้จากเทมเพลต">ลบ</button>`;
    group.innerHTML = `
      <span class="tagger-row-group-label">${escapeHtml(label)}</span>
      ${nameHtml}
      ${actsHtml}
    `;
    firstCell.insertBefore(group, firstCell.firstChild);
  }
}

/**
 * Find the list/list-table replacement for a tagged table row (supports duplicate names).
 * @param {HTMLTableRowElement} tr
 */
function findTaggerListRepForRow(tr) {
  if (!taggerSession || !tr) return null;
  const listName = (tr.getAttribute("data-list-name") || "").trim();
  const tag = listName ? `{{#${listName}}}` : "";
  const candidates = taggerSession.replacements.filter(
    (r) =>
      (r.kind === "list-table" ||
        r.kind === "list" ||
        r.mode === "wrap-row" ||
        r.mode === "wrap") &&
      (listName
        ? r.label === listName || r.tag === tag
        : r.kind === "list-table" || r.mode === "wrap-row"),
  );
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const root = document.getElementById("taggerSelectRoot");
  const rows = [...(root?.querySelectorAll("tr.tagger-list-frame-row") || [])].filter((el) => {
    if (!listName) return true;
    return el.getAttribute("data-list-name") === listName;
  });
  const idx = rows.indexOf(tr);
  const sorted = [...candidates].sort(
    (a, b) =>
      (typeof a.plainStart === "number" ? a.plainStart : a.occurrence) -
      (typeof b.plainStart === "number" ? b.plainStart : b.occurrence),
  );
  if (idx >= 0 && idx < sorted.length) return sorted[idx];
  return sorted[0];
}

/**
 * The list/wrap-row that owns this table row — not a field chip inside the row.
 * @param {HTMLTableRowElement} tr
 */
function findTaggerWrapRepForRow(tr) {
  if (!taggerSession || !tr) return null;
  if (tr.classList.contains("tagger-list-frame-row")) {
    const framed = findTaggerListRepForRow(tr);
    if (framed) return framed;
  }
  // {{#name}} chip rendered in this row
  for (const chip of tr.querySelectorAll(".tagger-chip")) {
    const text = normalizeTaggerDomPlain(chip.textContent || "").trim();
    const open = /^\{\{#([^{}]+)\}\}$/.exec(text);
    if (!open) continue;
    const byId = chip.getAttribute("data-tag-id");
    if (byId) {
      const r = taggerSession.replacements.find((x) => x.id === byId);
      if (r) return r;
    }
    const name = open[1].trim();
    const hit = taggerSession.replacements.find(
      (r) =>
        (r.mode === "wrap-row" ||
          r.mode === "wrap" ||
          r.kind === "list-table" ||
          r.kind === "list") &&
        (r.tag === text || r.label === name),
    );
    if (hit) return hit;
  }
  // Field chip in row → parent wrap via wrapTag meta or original plain span
  const original = taggerSession.originalPlainText || "";
  const wraps = taggerSession.replacements.filter(
    (r) =>
      r.mode === "wrap-row" ||
      r.kind === "list-table" ||
      r.mode === "wrap" ||
      r.kind === "list",
  );
  if (!wraps.length) return null;
  for (const chip of tr.querySelectorAll(".tagger-chip")) {
    const text = normalizeTaggerDomPlain(chip.textContent || "").trim();
    if (/^\{\{#/.test(text) || text === "{{/}}" || /^\{\{\//.test(text)) continue;
    const id = chip.getAttribute("data-tag-id");
    const field = id
      ? taggerSession.replacements.find((x) => x.id === id)
      : taggerSession.replacements.find((r) => r.tag === text);
    if (!field || isTaggerDeleteOp(field)) continue;
    if (
      field.mode === "wrap-row" ||
      field.mode === "wrap" ||
      field.kind === "list" ||
      field.kind === "list-table"
    ) {
      return field;
    }
    if (field.wrapTag) {
      const byMeta = wraps.filter((w) => w.tag === field.wrapTag);
      if (byMeta.length === 1) return byMeta[0];
      if (
        typeof field.wrapOccurrence === "number" &&
        field.wrapOccurrence >= 0 &&
        field.wrapOccurrence < byMeta.length
      ) {
        return byMeta[field.wrapOccurrence];
      }
      // Same-id prefix: wrap id + "_cN"
      const parentId = String(field.id || "").replace(/_c\d+$/, "");
      const byId = byMeta.find((w) => w.id === parentId);
      if (byId) return byId;
    }
    const fieldStart = ensureTaggerPlainStart(field, original);
    if (typeof fieldStart !== "number" || fieldStart < 0) continue;
    for (const w of wraps) {
      const wStart = ensureTaggerPlainStart(w, original);
      if (typeof wStart !== "number" || wStart < 0) continue;
      const wEnd = wStart + String(w.plainText || "").length;
      if (fieldStart >= wStart && fieldStart < wEnd) return w;
    }
  }
  return null;
}

/**
 * When {{#…}} / {{/}} sit in different cells or paragraphs, wrap the group visually.
 * @param {HTMLElement} root
 */
function decorateTaggerListFrames(root) {
  if (!root) return;
  const chips = [...root.querySelectorAll(".tagger-chip")];
  /** @type {{ open: HTMLElement, name: string, kind: string }[]} */
  const stack = [];

  for (const chip of chips) {
    if (chip.closest(".tagger-list-frame")) continue;
    const text = (chip.textContent || "").trim();
    const open = /^\{\{#([^}]*)\}\}$/.exec(text);
    const isClose = text === "{{/}}" || /^\{\{\/[^}]*\}\}$/.test(text);
    if (open) {
      stack.push({
        open: /** @type {HTMLElement} */ (chip),
        name: open[1].trim() || "รายการ",
        kind: chip.classList.contains("is-list-table") ? "list-table" : "list",
      });
      continue;
    }
    if (!isClose || !stack.length) continue;
    const frame = stack.pop();
    if (!frame) continue;
    const openEl = frame.open;
    const closeEl = /** @type {HTMLElement} */ (chip);
    if (openEl.closest(".tagger-list-frame") || closeEl.closest(".tagger-list-frame")) continue;

    const openRow = openEl.closest("tr");
    const closeRow = closeEl.closest("tr");
    if (openRow && openRow === closeRow) {
      openRow.classList.add("tagger-list-frame-row", `is-${frame.kind}`);
      openRow.setAttribute("data-list-name", frame.name);
      if (!openRow.querySelector(".tagger-list-frame-label")) {
        const firstTd = openRow.querySelector("td, th");
        if (firstTd) {
          const lab = document.createElement("span");
          lab.className = "tagger-list-frame-label";
          lab.textContent = taggerListFrameLabelText(frame.kind);
          firstTd.insertBefore(lab, firstTd.firstChild);
        }
      }
      continue;
    }

    const openPara = openEl.closest(".tagger-para");
    const closePara = closeEl.closest(".tagger-para");
    if (openPara && closePara && openPara.parentElement === closePara.parentElement) {
      const parent = openPara.parentElement;
      if (!parent) continue;
      const wrap = document.createElement("div");
      wrap.className = `tagger-list-frame tagger-list-frame-block is-${frame.kind}`;
      wrap.setAttribute("data-list-name", frame.name);
      const lab = document.createElement("span");
      lab.className = "tagger-list-frame-label";
      lab.textContent = taggerListFrameLabelText(frame.kind);
      wrap.appendChild(lab);
      const kids = [...parent.children];
      const a = kids.indexOf(openPara);
      const b = kids.indexOf(closePara);
      if (a < 0 || b < 0 || b < a) continue;
      parent.insertBefore(wrap, openPara);
      for (let i = a; i <= b; i++) wrap.appendChild(kids[i]);
    }
  }
}

/** Prefer Word column widths in tagger preview so long {{tags}} don't reshape the table. */
function taggerTableClass(block) {
  const fixed = Array.isArray(block.colWidths) && block.colWidths.length > 0;
  return fixed
    ? "doc-table doc-table-stretch doc-table-resizable"
    : "doc-table doc-table-stretch";
}

function renderTaggerTableBlock(block) {
  const tableClass = taggerTableClass(block);
  const colgroup = renderColgroup(block, false);
  if (block.staticRows?.length) {
    const rows = block.staticRows
      .map((r) => {
        const joined = r
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .join("");
        const open = /\{\{#([^}]*)\}\}/.exec(joined);
        const cells = r
          .map((c) => {
            const { text, attrs } = layoutCellAttrs(typeof c === "string" ? { text: c } : c);
            return `<td${attrs}>${renderTaggerRichText(text)}</td>`;
          })
          .join("");
        if (open) {
          const name = open[1].trim() || "รายการ";
          return `<tr class="tagger-list-frame-row is-list-table" data-list-name="${escapeAttr(name)}">${cells}</tr>`;
        }
        return `<tr>${cells}</tr>`;
      })
      .join("");
    return `<div class="doc-table-scroll doc-table-real"><table class="${tableClass}">${colgroup}${rows}</table></div>`;
  }
  const headers = (block.headerRows || [])
    .map(
      (r) =>
        `<tr>${r
          .map((c) => {
            const { text, attrs } = layoutCellAttrs(c);
            return `<th${attrs}>${renderTaggerRichText(text)}</th>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const listName = block.listName ? String(block.listName) : "";
  const listOpen = listName ? `{{#${listName}}}` : "";
  const tmpl = (block.templateCells || [])
    .map((c, i) => {
      const { text, attrs } = layoutCellAttrs(typeof c === "string" ? { text: c } : c);
      // Doc order: {{#}} → cell fields → {{/}}. Resolve chips in that order so
      // position-based binding stays aligned with original plain offsets.
      let body = "";
      if (listOpen && i === 0) {
        const listRep =
          (taggerChipRepAt ? taggerChipRepAt(listOpen) : null) ||
          taggerSession?.replacements.find(
            (r) =>
              (r.kind === "list" || r.kind === "list-table") &&
              (r.tag === listOpen || r.label === listName),
          ) ||
          null;
        const label = `<span class="tagger-list-frame-label">${escapeHtml(taggerListFrameLabelText("list-table"))}</span>`;
        const openChip = renderTaggerChipHtml(listOpen, `#${listName}`, {
          id: listRep?.id,
          kind: "list-table",
          tag: listOpen,
          label: listName,
        });
        body = `${label}${openChip}`;
      }
      body += renderTaggerRichText(text);
      if (listOpen && i === (block.templateCells.length || 1) - 1) {
        const closeRep = taggerChipRepAt ? taggerChipRepAt("{{/}}") : undefined;
        body += renderTaggerChipHtml("{{/}}", "/", closeRep);
      }
      return `<td${attrs}>${body}</td>`;
    })
    .join("");
  const trailing = (block.trailingRows || [])
    .map((r) => {
      const cells = r
        .map((c) => {
          const { text, attrs } = layoutCellAttrs(typeof c === "string" ? { text: c } : c);
          return `<td${attrs}>${renderTaggerRichText(text)}</td>`;
        })
        .join("");
      return `<tr class="tagger-trailing-row" title="แถวใต้ต้นแบบลิสต์ (อาจเป็นตัวอย่างหรือฟุตเตอร์) — ลบเองด้วย «ลบแถว» ถ้าไม่ต้องการ">${cells}</tr>`;
    })
    .join("");
  const rowClass = listName
    ? ` class="tagger-list-frame-row is-list-table" data-list-name="${escapeAttr(listName)}"`
    : "";
  return `<div class="doc-table-scroll doc-table-real"><table class="${tableClass}">${colgroup}<thead>${headers}</thead><tbody><tr${rowClass}>${tmpl}</tr>${trailing}</tbody></table></div>`;
}

/** Node.contains excludes the node itself — multi-block selections often use root as ancestor. */
function isInsideTaggerRoot(root, node) {
  if (!root || !node) return false;
  if (node === root) return true;
  return root.contains(node);
}

/** Quiet console diagnostics for tagger selection sync (`window.__TAGGER_SEL_DEBUG = true`). */
const TAGGER_SEL_DEBUG = false;

/**
 * True when the live window selection has non-empty trimmed text inside the preview root.
 * Used to force-enable create controls even if occurrence mapping fails.
 * @param {HTMLElement} root
 */
function hasTaggerPreviewSelectionText(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!isInsideTaggerRoot(root, range.commonAncestorContainer)) return false;
  return (sel.toString() || "").trim().length > 0;
}

/**
 * Patch the floating "สร้างตัวแปร" button (+ always-visible toolbar) only — never re-render
 * the preview (innerHTML would destroy the browser selection mid-drag).
 * @param {HTMLElement} root
 * @param {HTMLElement} [floatBtnHint]
 */
/**
 * Hide a portaled float control.
 * @param {HTMLElement | null} el
 */
function hideTaggerFloatEl(el) {
  if (!el) return;
  el.hidden = true;
  el.setAttribute("aria-hidden", "true");
}

/**
 * Show float buttons in a row: create + delete as one cluster, copy as a second group.
 * @param {HTMLElement[]} buttons
 * @param {number} top
 * @param {number} preferredLeft
 * @param {number} [groupGap]
 */
function placeTaggerFloatRow(buttons, top, preferredLeft, groupGap = 14) {
  const visible = buttons.filter(Boolean);
  if (!visible.length) return;
  for (const btn of visible) {
    btn.hidden = false;
    btn.setAttribute("aria-hidden", "false");
    btn.style.top = "0px";
    btn.style.left = "0px";
  }
  let x = preferredLeft;
  for (let i = 0; i < visible.length; i++) {
    const btn = visible[i];
    const w = Math.max(btn.offsetWidth || 0, 96);
    const gapBefore = i === 0 ? 0 : btn.classList.contains("tagger-float-copy") ? groupGap + 6 : 8;
    x += gapBefore;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, x));
    btn.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    x = left + w;
  }
}

/**
 * Preview snippet for banners / hints.
 * @param {string} text
 * @param {number} [max]
 */
function previewCopiedText(text, max = 48) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function syncTaggerPasteUi() {
  const has = !!lastCopiedTaggerText.trim();
  const hint = document.getElementById("taggerPasteHint");
  if (hint) {
    if (has) {
      hint.hidden = false;
      hint.textContent = `ข้อความที่คัดลอกไว้: “${previewCopiedText(lastCopiedTaggerText, 72)}” — กด «วาง» ที่ช่องที่ต้องการ`;
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
  document.querySelectorAll(".tagger-paste-btn").forEach((btn) => {
    if (btn instanceof HTMLButtonElement) btn.disabled = !has;
  });
}

/**
 * @param {string} inputId
 */
async function pasteCopiedTaggerTextInto(inputId) {
  let text = lastCopiedTaggerText.trim();
  if (!text && navigator.clipboard?.readText) {
    try {
      text = (await navigator.clipboard.readText()).replace(/\u00a0/g, " ").trim();
      if (text) lastCopiedTaggerText = text;
    } catch {
      /* clipboard read may be denied */
    }
  }
  if (!text) {
    showBanner("ยังไม่มีข้อความที่คัดลอกไว้ — เลือกข้อความแล้วกด «คัดลอกข้อความ» ก่อน");
    return;
  }
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(inputId));
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.select();
  syncTaggerPasteUi();
  showBanner(`วางข้อความแล้ว: “${previewCopiedText(text)}”`, "success");
  setTimeout(() => showBanner(""), 2200);
}

async function copyTaggerSelectionText() {
  const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  const info =
    taggerPendingSelection || (liveRoot ? readTaggerSelection(liveRoot) : null);
  let text = (info?.plainText || "").trim();
  if (!text) {
    const live = window.getSelection()?.toString() || "";
    text = live.replace(/\u00a0/g, " ").trim();
  }
  if (!text) {
    showBanner("ยังไม่ได้เลือกข้อความ");
    return;
  }
  // In-app paste buffer must work even when system clipboard is denied.
  lastCopiedTaggerText = text;
  syncTaggerPasteUi();
  const preview = previewCopiedText(text);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showBanner(`คัดลอกข้อความแล้ว: “${preview}”`, "success");
  } catch (err) {
    console.warn("system clipboard write failed; in-app paste still available", err);
    showBanner(`คัดลอกข้อความแล้ว: “${preview}” (ใช้ปุ่มวางในแอปได้)`, "success");
  }
  setTimeout(() => showBanner(""), 3200);

  const floatCopy = document.getElementById("taggerCopyBtn");
  if (floatCopy && !floatCopy.hidden) {
    const prev = floatCopy.textContent;
    floatCopy.textContent = "คัดลอกแล้ว";
    floatCopy.classList.add("is-copied");
    setTimeout(() => {
      if (floatCopy.textContent === "คัดลอกแล้ว") floatCopy.textContent = prev || "คัดลอกข้อความ";
      floatCopy.classList.remove("is-copied");
    }, 1600);
  }
}

function syncTaggerFloatButton(root, floatBtnHint) {
  const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  if (!liveRoot) return;
  // Always re-query after portal — stale node refs from pre-portal bind must not win.
  const floatBtn =
    /** @type {HTMLElement | null} */ (document.getElementById("taggerCreateBtn")) || floatBtnHint || null;
  const floatDeleteBtn = /** @type {HTMLElement | null} */ (
    document.getElementById("taggerDeleteBtn")
  );
  const floatCopyBtn = /** @type {HTMLElement | null} */ (
    document.getElementById("taggerCopyBtn")
  );

  const hideCreateUi = () => {
    hideTaggerFloatEl(floatBtn);
    hideTaggerFloatEl(floatDeleteBtn);
    hideTaggerFloatEl(floatCopyBtn);
  };

  const info = readTaggerSelection(liveRoot);
  // Opening a dialog / clicking float controls collapses the live range.
  // selectionchange then syncs with null — never wipe a good snapshot here.
  // Pending is cleared explicitly when the user starts a new drag (onPointerDown).
  if (!isTaggerCreateDialogOpen() && !isTaggerDeleteDialogOpen() && info) {
    taggerPendingSelection = info;
  }
  // Create/delete need a mappable selection (occurrence). Live text alone is not enough —
  // otherwise the float shows and openTaggerCreateDialog fails with a false banner.
  const hasText = !!info;
  const busy = !!taggerSession?.busy;

  if (TAGGER_SEL_DEBUG || (typeof window !== "undefined" && window.__TAGGER_SEL_DEBUG)) {
    console.debug("[tagger-sel]", {
      hasText,
      info: info ? { plain: info.plainText, occ: info.occurrence } : null,
      busy,
      float: !!floatBtn,
      selecting: taggerPointerSelecting,
    });
  }

  const fromSelBtn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("taggerCreateFromSel")
  );
  if (fromSelBtn) {
    fromSelBtn.disabled = !hasText || busy;
    fromSelBtn.title = hasText
      ? `สร้างตัวแปรจาก “${previewCopiedText(info?.plainText || "", 32)}”`
      : "ลากเลือกข้อความในพรีวิวก่อน";
  }

  if (!hasText || busy) {
    hideCreateUi();
    return;
  }

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    hideCreateUi();
    return;
  }
  const range = sel.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  // Cross-line / table selections can report a zero union box — fall back to client rects.
  if (!rect.width && !rect.height) {
    const rects = range.getClientRects();
    rect = rects.length ? rects[rects.length - 1] : rect;
  }
  if (!rect.width && !rect.height) {
    // Selection mapped but browser reports no box (common near tabs) — sticky bar still works.
    hideCreateUi();
    return;
  }
  // Prefer just under the selection; clamp into the visible viewport.
  const top = Math.min(
    Math.max(72, rect.bottom + 8),
    Math.max(72, window.innerHeight - 56),
  );
  const preferredLeft = Math.min(
    window.innerWidth - 360,
    Math.max(12, rect.left + rect.width / 2 - 170),
  );
  placeTaggerFloatRow(
    /** @type {HTMLElement[]} */ ([floatBtn, floatDeleteBtn, floatCopyBtn].filter(Boolean)),
    top,
    preferredLeft,
  );
}

function bindTaggerSelection() {
  // Portal may have moved #taggerCreateBtn to body — always query fresh.
  const root = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  let floatBtn = /** @type {HTMLElement | null} */ (document.getElementById("taggerCreateBtn"));
  if (!root || !floatBtn) return;

  taggerSelectionBinding?.teardown();
  taggerSelectionBinding = null;
  taggerPointerSelecting = false;
  floatBtn.hidden = true;
  floatBtn.setAttribute("aria-hidden", "true");
  const floatDeleteBtn = /** @type {HTMLElement | null} */ (
    document.getElementById("taggerDeleteBtn")
  );
  const floatCopyBtn = /** @type {HTMLElement | null} */ (
    document.getElementById("taggerCopyBtn")
  );
  hideTaggerFloatEl(floatDeleteBtn);
  hideTaggerFloatEl(floatCopyBtn);

  const resolveFloat = () =>
    /** @type {HTMLElement | null} */ (document.getElementById("taggerCreateBtn")) || floatBtn;

  // Keep the browser selection (and taggerPendingSelection) when pressing float controls.
  // Snapshot on pointerdown — some engines clear the range before click handlers run
  // (especially when the selection includes contenteditable=false chips in a table row).
  const onCreatePointerDown = (e) => {
    // Keep the browser selection + pending snapshot; some engines clear the
    // range before the click handler (especially near contenteditable=false chips).
    e.preventDefault();
    e.stopPropagation();
    const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
    if (!liveRoot || isTaggerCreateDialogOpen() || isTaggerDeleteDialogOpen()) return;
    const snap = readTaggerSelection(liveRoot);
    if (snap) {
      taggerPendingSelection = snap;
    } else if (!taggerPendingSelection && hasTaggerPreviewSelectionText(liveRoot)) {
      // Live range already collapsing — keep whatever sync last stored; if empty, try once more next tick.
      requestAnimationFrame(() => {
        const again = readTaggerSelection(liveRoot);
        if (again) taggerPendingSelection = again;
      });
    }
  };

  const runSync = () => {
    const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
    const btn = resolveFloat();
    if (!liveRoot || !btn) return;
    syncTaggerFloatButton(liveRoot, btn);
  };

  const finalizeSelectionUi = () => {
    // Double-rAF: some engines commit the final range only after pointerup paints.
    requestAnimationFrame(() => {
      requestAnimationFrame(runSync);
    });
  };

  /** Force-show path: any pointer/mouse/touch end inside/out — never stuck selecting forever. */
  const endPointerSelect = () => {
    const wasSelecting = taggerPointerSelecting;
    taggerPointerSelecting = false;
    if (wasSelecting) {
      finalizeSelectionUi();
      return;
    }
    // Backup: selection may exist without our pointerdown (OS/long-press/keyboard extend).
    if (hasTaggerPreviewSelectionText(root)) finalizeSelectionUi();
  };

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    // Don't treat chip clicks / create/delete controls as a drag-select start.
    const t = /** @type {HTMLElement} */ (e.target);
    if (
      t?.closest?.(
        ".tagger-chip, .tagger-row-group, .tagger-row-act, .tagger-row-list-edit, .tagger-row-edit-tags, #taggerCreateBtn, #taggerDeleteBtn, #taggerCopyBtn",
      )
    ) {
      return;
    }
    taggerPointerSelecting = true;
    taggerPendingSelection = null;
    hideTaggerFloatEl(resolveFloat());
    hideTaggerFloatEl(document.getElementById("taggerDeleteBtn"));
    hideTaggerFloatEl(document.getElementById("taggerCopyBtn"));
  };

  const onKeyUp = (e) => {
    if (taggerPointerSelecting) return;
    // Shift+arrows / Cmd+A style selection ends on keyup.
    if (
      e.key === "Shift" ||
      e.key.startsWith("Arrow") ||
      e.key === "A" ||
      e.key === "a" ||
      e.key === "Home" ||
      e.key === "End"
    ) {
      runSync();
    }
  };

  // selectionchange fires continuously while dragging — ignore until pointer up.
  // After pointer up (or keyboard/touch handle select), sync float + toolbar without
  // touching preview HTML.
  const onSelectionChange = () => {
    if (taggerPointerSelecting) return;
    if (!document.getElementById("taggerSelectRoot")) {
      taggerSelectionBinding?.teardown();
      taggerSelectionBinding = null;
      return;
    }
    runSync();
  };

  // If pointerup is lost (tab blur, OS gesture), don't leave selecting stuck forever.
  const onVisOrBlur = () => {
    if (!taggerPointerSelecting) return;
    taggerPointerSelecting = false;
    finalizeSelectionUi();
  };

  /**
   * Resolve a preview chip to a replacement id (data-tag-id or tag text + order).
   * @param {Element} chip
   */
  const resolveChipRepId = (chip) => {
    let id = chip.getAttribute("data-tag-id");
    if (id || !taggerSession) return id;
    const tagText = normalizeTaggerDomPlain(chip.textContent || "").trim();
    const hits = taggerSession.replacements.filter((r) => r.tag === tagText);
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) {
      const chips = [...root.querySelectorAll(".tagger-chip")].filter(
        (c) => normalizeTaggerDomPlain(c.textContent || "").trim() === tagText,
      );
      const n = chips.indexOf(chip);
      const sorted = [...hits].sort(
        (a, b) =>
          (typeof a.plainStart === "number" ? a.plainStart : a.occurrence) -
          (typeof b.plainStart === "number" ? b.plainStart : b.occurrence),
      );
      if (n >= 0 && n < sorted.length) return sorted[n].id;
    }
    return null;
  };

  const onChipClick = (e) => {
    const listEdit = /** @type {HTMLElement} */ (e.target)?.closest?.(".tagger-row-list-edit");
    if (listEdit && root.contains(listEdit)) {
      e.preventDefault();
      e.stopPropagation();
      const tr = /** @type {HTMLTableRowElement | null} */ (listEdit.closest("tr"));
      const rep = tr ? findTaggerWrapRepForRow(tr) || findTaggerListRepForRow(tr) : null;
      if (rep?.id) openTaggerEditDialog(rep.id);
      else showBanner("ไม่พบลิสต์ของแถวนี้ — ลองคลิกแท็ก {{#…}} ในรายการด้านล่าง");
      return;
    }
    const editTags = /** @type {HTMLElement} */ (e.target)?.closest?.(".tagger-row-edit-tags");
    if (editTags && root.contains(editTags)) {
      e.preventDefault();
      e.stopPropagation();
      const tr = /** @type {HTMLTableRowElement | null} */ (editTags.closest("tr"));
      if (!tr) return;
      // Row chrome edits the list/wrap — never a field chip inside the loop.
      const wrapRep = findTaggerWrapRepForRow(tr);
      if (wrapRep?.id) {
        openTaggerEditDialog(wrapRep.id);
        return;
      }
      // Wrap was cancelled / not found — open create so the row can be wrapped again.
      activateTaggerTableRowAction(tr, "add");
      return;
    }
    const rowAct = /** @type {HTMLElement} */ (e.target)?.closest?.(".tagger-row-act");
    if (rowAct && root.contains(rowAct)) {
      e.preventDefault();
      e.stopPropagation();
      const tr = /** @type {HTMLTableRowElement | null} */ (rowAct.closest("tr"));
      if (!tr) return;
      activateTaggerTableRowAction(
        tr,
        rowAct.classList.contains("tagger-row-act-del") ? "delete" : "add",
      );
      return;
    }
    const chip = /** @type {HTMLElement} */ (e.target)?.closest?.(".tagger-chip");
    if (chip && root.contains(chip)) {
      const id = resolveChipRepId(chip);
      if (id) openTaggerEditDialog(id);
    }
  };

  floatBtn.addEventListener("pointerdown", onCreatePointerDown);
  floatBtn.addEventListener("mousedown", onCreatePointerDown);
  floatDeleteBtn?.addEventListener("pointerdown", onCreatePointerDown);
  floatDeleteBtn?.addEventListener("mousedown", onCreatePointerDown);
  floatCopyBtn?.addEventListener("pointerdown", onCreatePointerDown);
  floatCopyBtn?.addEventListener("mousedown", onCreatePointerDown);
  root.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", endPointerSelect);
  document.addEventListener("pointercancel", endPointerSelect);
  // mouseup/touchend backup when pointer events are flaky (some WebKit selection UIs).
  document.addEventListener("mouseup", endPointerSelect);
  document.addEventListener("touchend", endPointerSelect, { passive: true });
  root.addEventListener("keyup", onKeyUp);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("visibilitychange", onVisOrBlur);
  window.addEventListener("blur", onVisOrBlur);
  root.addEventListener("click", onChipClick, true);

  taggerSelectionBinding = {
    teardown() {
      taggerPointerSelecting = false;
      const btn = resolveFloat();
      btn?.removeEventListener("pointerdown", onCreatePointerDown);
      btn?.removeEventListener("mousedown", onCreatePointerDown);
      document
        .getElementById("taggerDeleteBtn")
        ?.removeEventListener("pointerdown", onCreatePointerDown);
      document
        .getElementById("taggerDeleteBtn")
        ?.removeEventListener("mousedown", onCreatePointerDown);
      document
        .getElementById("taggerCopyBtn")
        ?.removeEventListener("pointerdown", onCreatePointerDown);
      document
        .getElementById("taggerCopyBtn")
        ?.removeEventListener("mousedown", onCreatePointerDown);
      root.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", endPointerSelect);
      document.removeEventListener("pointercancel", endPointerSelect);
      document.removeEventListener("mouseup", endPointerSelect);
      document.removeEventListener("touchend", endPointerSelect);
      root.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("visibilitychange", onVisOrBlur);
      window.removeEventListener("blur", onVisOrBlur);
      root.removeEventListener("click", onChipClick, true);
    },
  };
}

/**
 * @param {HTMLElement} root
 * @returns {{
 *   plainText: string,
 *   occurrence: number,
 *   inTableRow: boolean,
 *   inTable: boolean,
 *   multiTableRow: boolean,
 *   multiline: boolean,
 *   rowCells: { text: string, occurrence: number }[],
 *   lines: { text: string, occurrence: number }[],
 * } | null}
 */
function readTaggerSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!isInsideTaggerRoot(root, range.commonAncestorContainer)) return null;

  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (range.startContainer)
      : range.startContainer.parentElement;
  const endEl =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? /** @type {Element} */ (range.endContainer)
      : range.endContainer.parentElement;
  // Entirely inside one chip → edit that chip; do not treat as a new create selection.
  const startChip = startEl?.closest?.(".tagger-chip") || null;
  const endChip = endEl?.closest?.(".tagger-chip") || null;
  if (startChip && startChip === endChip) return null;

  const frag = range.cloneContents();
  // Text-node walk matches concatenated <w:t> (no synthetic newlines between blocks).
  // NBSP from formatPlainText("  "→" &nbsp;") is normalized back to regular spaces.
  // Table selections often stringify with \t between cells — walk ignores those.
  let plainText = fragToRemainingPlain(frag);
  if (!plainText || !plainText.trim()) return null;
  if (!taggerSession) return null;

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeFrag = beforeRange.cloneContents();
  const remainingBefore = fragToRemainingPlain(beforeFrag);

  const startRow = startEl?.closest?.("tr") || null;
  const endRow = endEl?.closest?.("tr") || null;
  const startTable = startEl?.closest?.("table") || null;
  const endTable = endEl?.closest?.("table") || null;
  let tableEl = startTable && endTable && startTable === endTable ? startTable : null;
  if (!tableEl) {
    // Selection may start/end on tbody/tr wrappers — still count as in-table.
    const ancestor = range.commonAncestorContainer;
    const ancEl =
      ancestor.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (ancestor)
        : ancestor.parentElement;
    tableEl = ancEl?.closest?.("table") || null;
    if (tableEl && !root.contains(tableEl)) tableEl = null;
  }
  const inTable = !!tableEl;
  /** @type {HTMLTableRowElement[]} */
  const touchedRowEls = [];
  if (tableEl && typeof range.intersectsNode === "function") {
    for (const tr of tableEl.querySelectorAll("tr")) {
      try {
        if (range.intersectsNode(tr)) touchedRowEls.push(/** @type {HTMLTableRowElement} */ (tr));
      } catch {
        /* ignore stale nodes */
      }
    }
  }
  const touchedRows = touchedRowEls.length;
  const multiTableRow = !!(inTable && touchedRows > 1);
  /** Anchor row for list-table — start/end tr, or the single intersected row. */
  let anchorRow =
    startRow && endRow && startRow === endRow && root.contains(startRow)
      ? /** @type {HTMLTableRowElement} */ (startRow)
      : null;
  if (!anchorRow && touchedRows === 1) anchorRow = touchedRowEls[0];
  const inTableRow = !!anchorRow && !multiTableRow;

  const startPara = startEl?.closest?.(".tagger-para") || null;
  const endPara = endEl?.closest?.(".tagger-para") || null;
  const crossPara = !!(startPara && endPara && startPara !== endPara);
  // Multiline = spans paragraphs or has interior newlines.
  // Browser line-select often includes a trailing <br> → toString() ends with "\n";
  // that must NOT flip a single visual line into list/multiline mode.
  const selVisible = (range.toString() || "").replace(/^\n+|\n+$/g, "");
  const multiline = crossPara || /\n/.test(selVisible);

  /** @type {{ text: string, occurrence: number, startCol?: number, colspan?: number, tcIndex?: number, filledTag?: string }[]} */
  let rowCells = [];
  if (inTableRow && anchorRow) {
    const slotted = getTableRowCellSlots(anchorRow);
    const cells = slotted.map((s) => s.el);
    const rowStartBefore = (() => {
      const br = document.createRange();
      br.selectNodeContents(root);
      const firstCell = cells[0];
      if (!firstCell) return remainingBefore;
      try {
        br.setEndBefore(firstCell);
      } catch {
        try {
          br.setEnd(firstCell, 0);
        } catch {
          return remainingBefore;
        }
      }
      return fragToRemainingPlain(br.cloneContents());
    })();
    let cursorBefore = rowStartBefore;
    for (const slot of slotted) {
      const cell = slot.el;
      const tcIndex = wordTcIndexForSlot(slotted, slot);
      // Prefer the session replacement behind a chip — occurrenceInOriginal would
      // otherwise return -1 once that cell span is fully "taken".
      const chip = cell.querySelector?.(".tagger-chip[data-tag-id]");
      const chipRep =
        chip && taggerSession.replacements
          ? taggerSession.replacements.find((r) => r.id === chip.getAttribute("data-tag-id"))
          : null;
      // fill-empty-tc stores the row-wrap anchor as plainText (often "1…") — that must
      // NOT be treated as this cell's text or column mapping / selection latches onto "1".
      if (chipRep?.mode === "fill-empty-tc") {
        rowCells.push({
          text: "",
          occurrence: -1,
          startCol: slot.startCol,
          colspan: slot.colspan,
          tcIndex,
          filledTag: chipRep.tag,
        });
        continue;
      }
      if (
        chipRep &&
        chipRep.mode !== "wrap" &&
        chipRep.mode !== "wrap-row" &&
        chipRep.plainText
      ) {
        rowCells.push({
          text: chipRep.plainText,
          occurrence: chipRep.occurrence,
          startCol: slot.startCol,
          colspan: slot.colspan,
          tcIndex,
        });
        cursorBefore += chipRep.plainText;
        continue;
      }
      const text = elementToTaggerPlain(cell);
      // Whitespace-only (nbsp / " ") is still an empty data cell in Word — must
      // NOT join rowParts or resolveTableRowPlainSpan will latch onto spaces in headers.
      if (!text || !String(text).trim()) {
        rowCells.push({
          text: "",
          occurrence: -1,
          startCol: slot.startCol,
          colspan: slot.colspan,
          tcIndex,
        });
        continue;
      }
      const resolved = resolveRowCellPlain(
        text,
        cursorBefore,
        taggerSession.originalPlainText,
        taggerSession.replacements,
      );
      rowCells.push({
        text: resolved.text,
        occurrence: resolved.occurrence,
        plainStart: resolved.plainStart,
        startCol: slot.startCol,
        colspan: slot.colspan,
        tcIndex,
      });
      cursorBefore += resolved.text;
    }
  }

  const rowHeaders =
    inTableRow && anchorRow ? getTableHeaderLabelsForRow(anchorRow, rowCells) : [];

  let occurrence = -1;
  /** @type {number | undefined} */
  let selectionPlainStart;
  const caretHit = resolvePlainAtCaret(
    remainingBefore,
    plainText,
    taggerSession.originalPlainText,
    taggerSession.replacements,
  );
  if (caretHit) {
    occurrence = caretHit.occurrence;
    if (caretHit.plainStart >= 0) selectionPlainStart = caretHit.plainStart;
  }

  // Table row selections often fail whole-span occurrence (tabs / partial TR anchors).
  // Fall back to a cell-based span so wrap-row / list-table still opens.
  if (occurrence < 0 && inTableRow && rowCells.length) {
    const parts = rowCells.filter((c) => c.text && c.occurrence >= 0);
    if (parts.length) {
      const spanned = resolveTableRowPlainSpan(parts, taggerSession.originalPlainText || "");
      if (spanned) {
        plainText = spanned.plainText;
        occurrence = spanned.occurrence;
        if (typeof spanned.plainStart === "number") selectionPlainStart = spanned.plainStart;
      } else {
        plainText = parts[0].text;
        occurrence = parts[0].occurrence;
        if (typeof parts[0].plainStart === "number") selectionPlainStart = parts[0].plainStart;
      }
    }
  }

  if (typeof window !== "undefined" && window.__TAGGER_SEL_DEBUG) {
    window.__lastTaggerSelDump = {
      plainText,
      occurrence,
      inTableRow,
      multiTableRow,
      rowCells: rowCells.map((c) => ({
        text: c.text,
        occurrence: c.occurrence,
        startCol: c.startCol,
        tcIndex: c.tcIndex,
        filledTag: c.filledTag || null,
      })),
      rowHeaders,
      rowStartTail:
        inTableRow && anchorRow
          ? (() => {
              const slotted = getTableRowCellSlots(anchorRow);
              const br = document.createRange();
              br.selectNodeContents(root);
              try {
                br.setEndBefore(slotted[0]?.el);
              } catch {
                return "";
              }
              return fragToRemainingPlain(br.cloneContents()).slice(-80);
            })()
          : null,
    };
  }

  if (occurrence < 0) {
    if (typeof window !== "undefined" && window.__TAGGER_SEL_DEBUG) {
      console.debug("[tagger-sel] occurrence miss", {
        plainText,
        remainingMatchIndex,
        beforeTail: remainingBefore.slice(-60),
        originalHas: taggerSession.originalPlainText.includes(plainText),
        inTableRow,
        rowCells: rowCells.length,
      });
    }
    return null;
  }

  /** @type {{ text: string, occurrence: number }[]} */
  let lines = [];
  // Always collect paragraph lines for non-table selections (single or multi) so
  // kind "ลิสต์" can wrap {{#…}}…{{/}} and optionally name per-line fields.
  if (!inTableRow) {
    const paras = [];
    if (startPara && endPara && startPara !== endPara) {
      let walking = false;
      for (const p of root.querySelectorAll(".tagger-para")) {
        if (p === startPara) walking = true;
        if (walking) paras.push(p);
        if (p === endPara) break;
      }
    } else if (startPara) {
      paras.push(startPara);
    }
    let cursorBefore = remainingBefore;
    for (const p of paras) {
      const text = elementToTaggerPlain(p);
      if (!text || !plainText.includes(text)) continue;
      const rem = countOccurrences(cursorBefore, text);
      const occ = occurrenceInOriginal(
        taggerSession.originalPlainText,
        text,
        rem,
        taggerSession.replacements,
      );
      if (occ >= 0) {
        lines.push({ text, occurrence: occ });
        cursorBefore += text;
      }
    }
    if (!lines.length && plainText.trim()) {
      lines = [{ text: plainText, occurrence }];
    }
  }

  const rowPin = inTableRow && anchorRow ? resolveTaggerDeleteRowPin(anchorRow) : null;

  return {
    plainText,
    occurrence,
    plainStart: selectionPlainStart,
    inTableRow,
    inTable,
    multiTableRow,
    multiline: multiline || lines.length > 1,
    rowCells,
    rowHeaders,
    lines,
    ...(rowPin
      ? { tableIndex: rowPin.tableIndex, rowIndexInTable: rowPin.rowIndexInTable }
      : {}),
  };
}

/**
 * Effective column count of a row (honours colspan).
 * @param {HTMLTableRowElement} row
 */
function tableRowEffectiveCols(row) {
  let n = 0;
  for (const cell of row.querySelectorAll(":scope > th, :scope > td")) {
    n += Math.max(1, Number(cell.getAttribute("colspan") || 1) || 1);
  }
  return n;
}

/**
 * Word <w:tc> index for a slotted DOM cell: counts real cells and rowspan
 * continuation holes (HTML omits them; OOXML still has a <w:tc>).
 * @param {{ el: HTMLTableCellElement, startCol: number, colspan: number }[]} slots
 * @param {{ el: HTMLTableCellElement, startCol: number, colspan: number }} slot
 */
function wordTcIndexForSlot(slots, slot) {
  if (!slots?.length || !slot) return -1;
  const gridWidth = Math.max(
    ...slots.map((s) => (s.startCol || 0) + (s.colspan || 1)),
    (slot.startCol || 0) + (slot.colspan || 1),
    1,
  );
  /** @type {Map<number, { el: HTMLTableCellElement, startCol: number, colspan: number }>} */
  const byStart = new Map(slots.map((s) => [s.startCol, s]));
  let tcIndex = 0;
  let col = 0;
  while (col < gridWidth) {
    const owner = byStart.get(col);
    if (owner) {
      if (owner.el === slot.el) return tcIndex;
      tcIndex += 1;
      col += owner.colspan || 1;
      continue;
    }
    // Rowspan hole from a cell above — Word still has a <w:tc w:vMerge>.
    tcIndex += 1;
    col += 1;
  }
  return slots.findIndex((s) => s.el === slot.el);
}

/**
 * Map each visible cell in a row to its starting grid column, accounting for
 * rowspan from earlier rows (so headers align with the correct data cells).
 * @param {HTMLTableRowElement} targetRow
 * @returns {{ el: HTMLTableCellElement, startCol: number, colspan: number }[]}
 */
function getTableRowCellSlots(targetRow) {
  const table = targetRow.closest("table");
  if (!table) {
    return [...targetRow.querySelectorAll(":scope > td, :scope > th")].map((el, i) => ({
      el: /** @type {HTMLTableCellElement} */ (el),
      startCol: i,
      colspan: Math.max(1, Number(el.getAttribute("colspan") || 1) || 1),
    }));
  }
  const allRows = /** @type {HTMLTableRowElement[]} */ ([...table.querySelectorAll("tr")]);
  /** @type {Map<number, number>} col → rowspan rows still covering below the current row */
  let spanBelow = new Map();
  /** @type {{ el: HTMLTableCellElement, startCol: number, colspan: number }[]} */
  let result = [];

  for (const row of allRows) {
    const occupied = new Set(spanBelow.keys());
    /** @type {Map<number, number>} */
    const nextBelow = new Map();
    for (const [c, left] of spanBelow) {
      if (left > 1) nextBelow.set(c, left - 1);
    }
    const cells = [...row.querySelectorAll(":scope > td, :scope > th")];
    let col = 0;
    /** @type {{ el: HTMLTableCellElement, startCol: number, colspan: number }[]} */
    const slots = [];
    for (const el of cells) {
      const cell = /** @type {HTMLTableCellElement} */ (el);
      while (occupied.has(col)) col += 1;
      const colspan = Math.max(1, Number(cell.getAttribute("colspan") || 1) || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute("rowspan") || 1) || 1);
      slots.push({ el: cell, startCol: col, colspan });
      for (let c = col; c < col + colspan; c++) {
        occupied.add(c);
        if (rowspan > 1) nextBelow.set(c, Math.max(nextBelow.get(c) || 0, rowspan - 1));
      }
      col += colspan;
    }
    spanBelow = nextBelow;
    if (row === targetRow) {
      result = slots;
      break;
    }
  }
  return result;
}

/**
 * Column-indexed header labels for the row above the selection.
 * @param {HTMLTableRowElement} anchorRow
 * @param {{ startCol?: number, colspan?: number }[]} [dataCells]
 * @returns {string[]} labels aligned to data cell indices (not raw grid)
 */
function getTableHeaderLabelsForRow(anchorRow, dataCells) {
  const table = anchorRow.closest("table");
  if (!table) return [];

  const dataSlots = dataCells?.length
    ? dataCells
    : getTableRowCellSlots(anchorRow).map((s) => ({
        startCol: s.startCol,
        colspan: s.colspan,
      }));
  if (!dataSlots.length) return [];

  const gridWidth = Math.max(
    ...dataSlots.map((c) => (c.startCol || 0) + (c.colspan || 1)),
    tableRowEffectiveCols(anchorRow),
    1,
  );
  const allRows = /** @type {HTMLTableRowElement[]} */ ([...table.querySelectorAll("tr")]);
  const idx = allRows.indexOf(anchorRow);
  // Skip single-cell banner/title rows when collecting headers.
  const minCols = Math.max(2, Math.ceil(gridWidth * 0.5));

  /** @type {string[]} grid-indexed — nearer header rows win, then fill gaps from rows above */
  const byCol = Array(gridWidth).fill("");
  for (let i = idx - 1; i >= 0; i--) {
    const cand = allRows[i];
    const cols = tableRowEffectiveCols(cand);
    if (cols < minCols && !cand.querySelector(":scope > th") && !cand.closest("thead")) {
      continue;
    }
    for (const slot of getTableRowCellSlots(cand)) {
      // elementToTaggerPlain skips row-action chrome (+ ตัวแปร / ลบ).
      const text = normalizeTaggerDomPlain(elementToTaggerPlain(slot.el))
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      // Skip checkbox-only header fragments.
      if (/^[✓√✖×xX\-–—·.•]+$/u.test(text)) continue;
      for (let c = slot.startCol; c < slot.startCol + slot.colspan && c < gridWidth; c++) {
        if (!byCol[c]) byCol[c] = text;
      }
    }
  }

  // Map each data cell → label at its start column (fall back across its colspan).
  return dataSlots.map((cell) => {
    const start = cell.startCol || 0;
    const span = cell.colspan || 1;
    for (let c = start; c < start + span; c++) {
      if (byCol[c]) return byCol[c];
    }
    return "";
  });
}

/**
 * Turn header text into a unique field name suggestion (empty if unusable).
 * @param {string} headerText
 * @param {Set<string>} used
 */
function suggestFieldNameFromHeader(headerText, used) {
  const raw = String(headerText || "").trim();
  if (!raw) return "";
  // Skip pure punctuation / checkbox marks as header names.
  if (/^[✓√✖×xX\-–—·.•]+$/u.test(raw)) return "";
  // Normalize separators first so "เขต / อำเภอ" → เขต_อำเภอ (not dropped).
  let base = suggestTaggerName(raw);
  if (!base || base === "field") {
    base = suggestTaggerName(raw.replace(/[/\\|·•]+/g, " "));
  }
  if (!base || base === "field") return "";
  if (!/^[\w\u0E00-\u0E7F.-]+$/u.test(base)) return "";
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/**
 * Map DOM text back to Word <w:t> plain: formatPlainText uses &nbsp; for double
 * spaces so visual lines keep gaps, but occurrence matching needs U+0020.
 * @param {string} s
 */
function normalizeTaggerDomPlain(s) {
  return String(s || "").replace(/\u00A0/g, " ");
}

/**
 * Map a preview chip back to the original plain text it replaced.
 * Session replacements keep originalPlainText stable while the DOM shows {{tags}}.
 * @param {Element} el
 * @returns {string | null}
 */
function chipToOriginalPlain(el) {
  if (!el?.classList?.contains("tagger-chip")) return null;
  const id = el.getAttribute("data-tag-id");
  if (id && taggerSession?.replacements?.length) {
    const rep = taggerSession.replacements.find((r) => r.id === id);
    if (
      rep?.plainText != null &&
      rep.mode !== "wrap" &&
      rep.mode !== "wrap-row" &&
      rep.mode !== "fill-empty-tc"
    ) {
      return String(rep.plainText);
    }
    // Loop open/close chips / empty-cell fills — not a plain replace span.
    if (rep && (rep.mode === "wrap" || rep.mode === "wrap-row" || rep.mode === "fill-empty-tc")) {
      return "";
    }
  }
  const label = normalizeTaggerDomPlain(el.textContent || "").trim();
  // Synthetic loop markers shown on template cells (no data-tag-id) — skip in plain.
  if (/^\{\{#.+\}\}$/.test(label) || label === "{{/}}" || /^\{\{\/.*\}\}$/.test(label)) {
    return "";
  }
  return null;
}

/** Preview-only chrome that must not enter Word plain matching. */
function isTaggerUiChrome(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const node = /** @type {Element} */ (el);
  return (
    node.hasAttribute("data-tagger-row-chrome") ||
    node.classList.contains("tagger-row-group") ||
    node.classList.contains("tagger-row-act") ||
    node.classList.contains("tagger-list-frame-label")
  );
}

/** @param {Element} el */
function elementToTaggerPlain(el) {
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return normalizeTaggerDomPlain(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const elNode = /** @type {Element} */ (node);
    if (isTaggerUiChrome(elNode)) return "";
    const fromChip = chipToOriginalPlain(elNode);
    if (fromChip != null) return fromChip;
    let out = "";
    for (const child of elNode.childNodes) out += walk(child);
    return out;
  };
  return walk(el);
}

/**
 * Walk a Range cloneContents() DocumentFragment (or Element subtree).
 * CRITICAL: DocumentFragment.nodeType is 11 — must not treat it like a non-element
 * leaf, or every in-text selection yields "" and create-variable UI stays hidden.
 * Skips <br> (layout newlines) so plain matches collectWtNodes (no newlines between paras).
 * Normalizes NBSP → space so formatPlainText double-space rendering still matches.
 * Maps .tagger-chip back to original plain via session replacements.
 * @param {DocumentFragment | Node} frag
 */
function fragToRemainingPlain(frag) {
  const walk = (node) => {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return normalizeTaggerDomPlain(node.textContent || "");
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {Element} */ (node);
      if (el.tagName === "BR") return "";
      if (isTaggerUiChrome(el)) return "";
      const fromChip = chipToOriginalPlain(el);
      if (fromChip != null) return fromChip;
      let out = "";
      for (const child of node.childNodes) out += walk(child);
      return out;
    }
    // DocumentFragment (11) and other containers — recurse into children.
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      let out = "";
      for (const child of node.childNodes) out += walk(child);
      return out;
    }
    return "";
  };
  return walk(frag);
}

/**
 * True when this cell's original text is already covered by a field/bool/auto replacement.
 * @param {{ text: string, occurrence: number }} cell
 */
function isTaggerCellAlreadyReplaced(cell) {
  if (!taggerSession) return false;
  // Empty cell already filled via fill-empty-tc (chip shows the tag).
  if (cell?.filledTag) return true;
  if (!cell?.text || cell.occurrence < 0) return false;
  return taggerSession.replacements.some(
    (r) =>
      r.mode !== "wrap" &&
      r.mode !== "wrap-row" &&
      r.mode !== "fill-empty-tc" &&
      r.mode !== "delete-p" &&
      r.mode !== "delete-tr" &&
      r.plainText === cell.text &&
      r.occurrence === cell.occurrence,
  );
}

function isTaggerDeleteOp(r) {
  return (
    r?.mode === "delete-p" ||
    r?.mode === "delete-tr" ||
    r?.kind === "delete-p" ||
    r?.kind === "delete-tr"
  );
}

/**
 * True when this plain/occurrence range overlaps an existing replace (or ops in `extra`).
 * Used so a short digit like "1" never lands on the leading char of an already-tagged
 * "1โฉนด…" — list-table then falls back to fill-empty-tc (scoped to the row/cell).
 * @param {string} plain
 * @param {number} occ
 * @param {object[]} [extra]
 */
function overlapsExistingTaggerPlain(plain, occ, extra = []) {
  if (!taggerSession || !plain || occ < 0) return false;
  const original = taggerSession.originalPlainText || "";
  const start = nthOccurrenceStart(original, plain, occ);
  if (start < 0) return true;
  const end = start + plain.length;
  const pool = [...(taggerSession.replacements || []), ...extra];
  for (const r of pool) {
    if (!r?.plainText || isTaggerDeleteOp(r)) continue;
    if (r.mode === "wrap" || r.mode === "wrap-row" || r.mode === "fill-empty-tc") continue;
    const rs = nthOccurrenceStart(original, r.plainText, Number(r.occurrence) || 0);
    if (rs < 0) continue;
    const re = rs + r.plainText.length;
    if (start < re && end > rs) return true;
  }
  return false;
}

/**
 * Pure-digit needles must not be a *prefix* of a longer number — "2" ≠ leading
 * digit of "281". Short runnos also must not steal "1" from "1โฉนด…". Longer IDs
 * (tax / ทะเบียน) often sit flush against the next Thai label with no tab —
 * those must still match. Only the next char is checked (left digit OK).
 * @param {string} haystack
 * @param {number} idx
 * @param {string} needle
 */
function plainMatchAllowed(haystack, idx, needle) {
  if (!/^\d+$/.test(needle)) return true;
  const next = haystack[idx + needle.length] || "";
  if (/\d/.test(next)) return false;
  if (needle.length <= 4 && /[\u0E00-\u0E7F]/u.test(next)) return false;
  return true;
}

/** @param {string} haystack @param {string} needle @param {number} [from] */
function indexOfPlainMatch(haystack, needle, from = 0) {
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

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const idx = indexOfPlainMatch(haystack, needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + Math.max(1, needle.length);
  }
  return count;
}

/**
 * Match a table cell's DOM text to original <w:t> plain — try trim / checkmark
 * variants when the DOM adds padding spaces that Word plain does not have.
 * @param {string} rawText
 * @param {string} cursorBefore
 * @param {string} original
 * @param {{ plainText: string, occurrence: number, mode?: string }[]} replacements
 * @returns {{ text: string, occurrence: number }}
 */
function resolveRowCellPlain(rawText, cursorBefore, original, replacements) {
  const raw = String(rawText || "");
  if (!raw) return { text: "", occurrence: -1, plainStart: -1 };
  /** @type {string[]} */
  const variants = [];
  const add = (v) => {
    if (v && !variants.includes(v)) variants.push(v);
  };
  add(raw);
  add(raw.trim());
  add(raw.replace(/\u00A0/g, " ").trim());
  const trimmed = raw.trim();
  // Checkbox / tick marks often differ between preview and OOXML plain.
  if (/^[✓√✔☑✖×xX]$/u.test(trimmed)) {
    for (const mark of ["√", "✓", "✔", "☑", "×", "x", "X", "✖"]) add(mark);
  }
  for (const needle of variants) {
    const hit = resolvePlainAtCaret(cursorBefore, needle, original, replacements);
    if (hit && hit.occurrence >= 0) {
      return { text: hit.plainText, occurrence: hit.occurrence, plainStart: hit.plainStart };
    }
  }
  return { text: raw, occurrence: -1, plainStart: -1 };
}

/**
 * Absolute start of a replacement in original plain, if known or derivable.
 * @param {{ plainText?: string, occurrence?: number, plainStart?: number }} r
 * @param {string} [original]
 */
function ensureTaggerPlainStart(r, original) {
  if (!r) return undefined;
  if (typeof r.plainStart === "number" && Number.isFinite(r.plainStart) && r.plainStart >= 0) {
    return r.plainStart;
  }
  const orig = original ?? taggerSession?.originalPlainText ?? "";
  const needle = String(r.plainText ?? "");
  if (!needle || !orig) return undefined;
  const at = nthOccurrenceStart(orig, needle, Number(r.occurrence) || 0);
  if (at < 0) return undefined;
  r.plainStart = at;
  return at;
}

/**
 * Map preview "how many matches of needle appear before the caret" → occurrence in
 * the stable original plain.
 *
 * Preview walk (fragToRemainingPlain) expands replace chips back to their original
 * plainText, so those spans are still visible in remainingBefore — do NOT skip them.
 * Only delete-p / delete-tr remove text from the preview; skip those ranges only.
 *
 * @param {string} original
 * @param {string} needle
 * @param {number} remainingMatchIndex
 * @param {{ plainText: string, occurrence: number, mode?: string, kind?: string, plainStart?: number }[]} replacements
 */
function occurrenceInOriginal(original, needle, remainingMatchIndex, replacements) {
  const taken = [];
  for (const r of replacements) {
    if (!isTaggerDeleteOp(r)) continue;
    const start =
      typeof r.plainStart === "number" && r.plainStart >= 0
        ? r.plainStart
        : r.plainText
          ? nthOccurrenceStart(original, r.plainText, Number(r.occurrence) || 0)
          : -1;
    if (start < 0) continue;
    const len = String(r.plainText || "").length;
    // Empty-row deletes have no plain — they don't shift <w:t> offsets.
    if (len <= 0) continue;
    taken.push({ start, end: start + len });
  }
  taken.sort((a, b) => a.start - b.start);

  let rem = -1;
  let from = 0;
  let occ = -1;
  while (from <= original.length) {
    const idx = indexOfPlainMatch(original, needle, from);
    if (idx < 0) break;
    occ += 1;
    const end = idx + needle.length;
    const covered = taken.some((t) => idx >= t.start && end <= t.end);
    if (!covered) {
      rem += 1;
      if (rem === remainingMatchIndex) return occ;
    }
    from = idx + Math.max(1, needle.length);
  }
  return -1;
}

/**
 * Prefer absolute caret mapping when the preview walk reconstructed an exact
 * prefix of original (typical after prior tags — chips expand to plain).
 * @param {string} remainingBefore
 * @param {string} plainText
 * @param {string} original
 * @param {object[]} replacements
 * @returns {{ plainText: string, occurrence: number, plainStart: number } | null}
 */
function resolvePlainAtCaret(remainingBefore, plainText, original, replacements) {
  const before = String(remainingBefore || "");
  const needle = String(plainText || "");
  if (!needle || !original) return null;
  if (original.startsWith(before) && original.slice(before.length, before.length + needle.length) === needle) {
    const plainStart = before.length;
    if (!plainMatchAllowed(original, plainStart, needle) && /^\d+$/.test(needle)) {
      // Digit glued to following Thai/number — not a safe absolute hit.
    } else {
      const occurrence = occurrenceAtOffset(original, needle, plainStart);
      if (occurrence >= 0) return { plainText: needle, occurrence, plainStart };
    }
  }
  const remIdx = countOccurrences(before, needle);
  const occurrence = occurrenceInOriginal(original, needle, remIdx, replacements);
  if (occurrence < 0) return null;
  const plainStart = nthOccurrenceStart(original, needle, occurrence);
  if (plainStart < 0) return { plainText: needle, occurrence, plainStart: -1 };
  return { plainText: needle, occurrence, plainStart };
}

/**
 * Index of the Nth occurrence of needle in haystack, or -1.
 * @param {string} haystack
 * @param {string} needle
 * @param {number} occurrence
 */
/**
 * Which occurrence index of needle starts at exactly `offset`, or -1.
 * @param {string} haystack
 * @param {string} needle
 * @param {number} offset
 */
function occurrenceAtOffset(haystack, needle, offset) {
  if (!needle || offset < 0) return -1;
  if (haystack.slice(offset, offset + needle.length) !== needle) return -1;
  if (!plainMatchAllowed(haystack, offset, needle)) return -1;
  let from = 0;
  let found = -1;
  while (from <= offset) {
    const idx = indexOfPlainMatch(haystack, needle, from);
    if (idx < 0 || idx > offset) return -1;
    found += 1;
    if (idx === offset) return found;
    from = idx + Math.max(1, needle.length);
  }
  return -1;
}

function nthOccurrenceStart(haystack, needle, occurrence) {
  if (!needle || occurrence < 0) return -1;
  let from = 0;
  let found = -1;
  while (from <= haystack.length) {
    const idx = indexOfPlainMatch(haystack, needle, from);
    if (idx < 0) return -1;
    found += 1;
    if (found === occurrence) return idx;
    from = idx + Math.max(1, needle.length);
  }
  return -1;
}

/**
 * Plain span covering a table row in original <w:t> text.
 * Uses the most distinctive cell as anchor, then expands to nearby siblings
 * so short tokens like "1" don't latch onto the wrong occurrence.
 * @param {{ text: string, occurrence: number }[]} rowParts
 * @param {string} original
 * @returns {{ plainText: string, occurrence: number } | null}
 */
function resolveTableRowPlainSpan(rowParts, original) {
  if (!rowParts?.length || !original) return null;

  // Ignore whitespace-only "cells" — a single space matches everywhere and
  // pulls the span back into header text within the fuzzy window.
  const parts = rowParts.filter((p) => String(p?.text || "").trim());
  if (!parts.length) return null;

  const score = (t) => {
    const s = String(t || "");
    if (/^\d+$/.test(s.trim())) return s.length * 0.25;
    if (/^[✓√✔☑✖×xX\-–—]$/u.test(s.trim())) return 0.4;
    return s.length + (/\p{L}/u.test(s) ? 10 : 0);
  };
  const distToRange = (at, len, start, end) => {
    const partEnd = at + len;
    if (partEnd <= start) return start - partEnd;
    if (at >= end) return at - end;
    return 0;
  };
  // Keep row span local — short tokens ("2","-") often have wrong occurrences
  // after earlier tables are tagged and must not stretch the span across the doc.
  const MAX_GAP = 96;
  const MAX_SPAN = 360;

  const ordered = [...parts].sort((a, b) => score(b.text) - score(a.text));
  const anchorPart = ordered[0];
  let anchorAt = nthOccurrenceStart(original, anchorPart.text, anchorPart.occurrence);
  if (anchorAt < 0) anchorAt = nthOccurrenceStart(original, anchorPart.text, 0);
  if (anchorAt < 0) return null;

  let start = anchorAt;
  let end = anchorAt + anchorPart.text.length;

  for (const part of ordered) {
    if (part === anchorPart) continue;
    const len = part.text.length;
    // Prefer recorded occurrence only when it sits near the cluster.
    let at = nthOccurrenceStart(original, part.text, part.occurrence);
    if (at >= 0 && distToRange(at, len, start, end) <= MAX_GAP) {
      start = Math.min(start, at);
      end = Math.max(end, at + len);
      continue;
    }
    // Rematch nearest hit to the growing cluster; skip outliers entirely.
    let best = -1;
    let bestDist = Infinity;
    let from = 0;
    while (from <= original.length) {
      const i = original.indexOf(part.text, from);
      if (i < 0) break;
      const d = distToRange(i, len, start, end);
      if (d < bestDist && d <= MAX_GAP) {
        bestDist = d;
        best = i;
      }
      from = i + Math.max(1, len);
    }
    if (best >= 0) {
      start = Math.min(start, best);
      end = Math.max(end, best + len);
    }
  }

  if (end - start > MAX_SPAN) {
    // Safety: collapse to distinctive cells only around the anchor.
    start = anchorAt;
    end = anchorAt + anchorPart.text.length;
    for (const part of ordered) {
      if (score(part.text) < 5) continue;
      const len = part.text.length;
      let best = -1;
      let bestDist = Infinity;
      let from = 0;
      while (from <= original.length) {
        const i = original.indexOf(part.text, from);
        if (i < 0) break;
        const d = distToRange(i, len, start, end);
        if (d < bestDist && d <= MAX_GAP) {
          bestDist = d;
          best = i;
        }
        from = i + Math.max(1, len);
      }
      if (best >= 0) {
        start = Math.min(start, best);
        end = Math.max(end, best + len);
      }
    }
  }

  const plainText = original.slice(start, end);
  if (!plainText) return null;
  const occurrence = occurrenceAtOffset(original, plainText, start);
  if (occurrence < 0) return null;
  return { plainText, occurrence, plainStart: start };
}

/**
 * Resolve a cell needle to the occurrence that sits inside an already-chosen
 * row span (avoids tagging the wrong "1" / "√" elsewhere).
 * @param {string} needle
 * @param {string} spanPlain
 * @param {number} spanOcc
 * @param {string} original
 * @returns {{ plainText: string, occurrence: number } | null}
 */
function rematchPlainInsideSpan(needle, spanPlain, spanOcc, original) {
  const n = String(needle || "");
  if (!n || !spanPlain || spanOcc < 0) return null;
  const spanStart = nthOccurrenceStart(original, spanPlain, spanOcc);
  if (spanStart < 0) return null;
  const slice = original.slice(spanStart, spanStart + spanPlain.length);
  // Prefer a boundary match so "1" doesn't latch onto "อาคารที่1",
  // and "2" doesn't latch onto "281".
  let local = -1;
  if (slice.startsWith(n) && plainMatchAllowed(slice, 0, n)) {
    local = 0;
  } else {
    let from = 0;
    while (from <= slice.length) {
      const i = indexOfPlainMatch(slice, n, from);
      if (i < 0) break;
      const prev = i === 0 ? "" : slice[i - 1];
      const next = slice[i + n.length] || "";
      const prevOk = !/[\w\u0E00-\u0E7F]/u.test(prev);
      const nextOk = !/[\w\u0E00-\u0E7F]/u.test(next);
      if (prevOk && (n.length > 1 || nextOk || next === "" || /\s/.test(next))) {
        local = i;
        break;
      }
      // Digit token already validated by indexOfPlainMatch; accept it.
      if (/^\d+$/.test(n)) {
        local = i;
        break;
      }
      from = i + Math.max(1, n.length);
    }
  }
  if (local < 0) {
    // Concatenated cells ("1บางนา"): allow after digit/mark, but never nest inside a
    // longer word — "ปทุมธานี" must not latch onto "เมืองปทุมธานี".
    // Digit needles also reject being a prefix/infix of a longer number ("2" in "281").
    let from = 0;
    while (from <= slice.length) {
      const i = indexOfPlainMatch(slice, n, from);
      if (i < 0) break;
      const prev = i === 0 ? "" : slice[i - 1];
      const prevIsLetter = /[\p{L}\u0E00-\u0E7F]/u.test(prev);
      if (!prevIsLetter) {
        local = i;
        break;
      }
      from = i + Math.max(1, n.length);
    }
  }
  if (local < 0) return null;
  const abs = spanStart + local;
  const occurrence = occurrenceAtOffset(original, n, abs);
  if (occurrence < 0) return null;
  return { plainText: n, occurrence, plainStart: abs };
}

/**
 * Place each non-empty cell text in document order inside the row span.
 * Avoids shorter values nesting inside longer siblings (เมืองปทุมธานี vs ปทุมธานี).
 * @param {{ text?: string }[]} rowCells
 * @param {string} spanPlain
 * @param {number} spanOcc
 * @param {string} original
 * @returns {({ plainText: string, occurrence: number } | null)[]}
 */
function rematchCellsSequentiallyInSpan(rowCells, spanPlain, spanOcc, original) {
  const spanStart = nthOccurrenceStart(original, spanPlain, spanOcc);
  if (spanStart < 0) return (rowCells || []).map(() => null);
  const slice = original.slice(spanStart, spanStart + spanPlain.length);
  let cursor = 0;
  return (rowCells || []).map((cell) => {
    const text = String(cell?.text || "");
    if (!text.trim()) return null;
    // Walk left→right with exact cell text. Digit tokens that only exist glued to
    // the next cell ("1"+"โฉนด…") won't get a global occurrence — caller uses fill-empty-tc.
    const at = slice.indexOf(text, cursor);
    if (at < 0) return null;
    const abs = spanStart + at;
    cursor = at + text.length;
    const occurrence = occurrenceAtOffset(original, text, abs);
    if (occurrence < 0) return null;
    return { plainText: text, occurrence, plainStart: abs };
  });
}

/** Flatten tagger layout / content for scanning existing {{#…}} wraps. */
function getTaggerFlatContent() {
  if (!taggerSession) return "";
  const layout = taggerSession.layout;
  if (Array.isArray(layout) && layout.length) {
    const parts = [];
    for (const b of layout) {
      if (b?.type === "text") parts.push(b.text || "");
      else if (b?.type === "table") {
        if (b.staticRows?.length) {
          for (const row of b.staticRows) {
            for (const c of row) {
              parts.push(typeof c === "string" ? c : c?.text || "");
            }
          }
        } else {
          for (const row of b.headerRows || []) {
            for (const c of row) parts.push(typeof c === "string" ? c : c?.text || "");
          }
          for (const c of b.templateCells || []) {
            parts.push(typeof c === "string" ? c : c?.text || "");
          }
        }
      }
    }
    return parts.join("");
  }
  return taggerSession.content || "";
}

/**
 * For run-number tags, replace only the digits (e.g. "1" in "จำเลยที่1" / "ที่ 1"),
 * not the whole selection, line, or cell — otherwise the surrounding labels disappear.
 * @param {string} spanText
 * @param {number} spanOccurrence
 * @returns {{ plainText: string, occurrence: number } | null}
 */
function resolveAutoReplaceTarget(spanText, spanOccurrence) {
  if (!taggerSession || !spanText) return null;
  const original = taggerSession.originalPlainText || "";
  const spanStart = nthOccurrenceStart(original, spanText, spanOccurrence);
  if (spanStart < 0) return null;

  const trimmed = spanText.trim();
  /** @type {string | null} */
  let needle = null;
  let localIdx = -1;

  if (/^\d+$/.test(trimmed)) {
    needle = trimmed;
    localIdx = spanText.indexOf(trimmed);
  } else {
    // Prefer the number right after «ที่» (จำเลยที่1 / จำเลยที่ 1).
    const afterThi = /ที่\s*(\d+)/u.exec(spanText);
    if (afterThi) {
      needle = afterThi[1];
      localIdx = afterThi.index + afterThi[0].length - needle.length;
    } else {
      // Short standalone runno (1–4 digits), avoid long tax IDs.
      const shortRe = /(\d{1,4})/g;
      let m;
      while ((m = shortRe.exec(spanText)) !== null) {
        const before = spanText[m.index - 1];
        const after = spanText[m.index + m[1].length];
        if (before && /\d/.test(before)) continue;
        if (after && /\d/.test(after)) continue;
        needle = m[1];
        localIdx = m.index;
        break;
      }
    }
  }

  if (!needle || localIdx < 0) return null;
  const absolute = spanStart + localIdx;
  const occ = occurrenceAtOffset(original, needle, absolute);
  if (occ < 0) return null;
  return { plainText: needle, occurrence: occ };
}

/**
 * True when the selection sits inside a list/table loop (session wrap or existing {{#…}} in content).
 * Auto/runno only makes sense inside loops (engine fills 1, 2, 3… per row).
 * @param {{ plainText: string, occurrence: number }} sel
 */
function isSelectionInsideListLoop(sel) {
  if (!taggerSession || !sel?.plainText) return false;
  const original = taggerSession.originalPlainText || "";
  const start = nthOccurrenceStart(original, sel.plainText, sel.occurrence);
  if (start < 0) return false;
  const end = start + sel.plainText.length;

  for (const r of taggerSession.replacements) {
    const isList =
      r.kind === "list" ||
      r.kind === "list-table" ||
      r.mode === "wrap" ||
      r.mode === "wrap-row";
    if (!isList) continue;
    const rStart = nthOccurrenceStart(original, r.plainText, r.occurrence);
    if (rStart < 0) continue;
    const rEnd = rStart + r.plainText.length;
    if (start >= rStart && end <= rEnd) return true;
  }

  // Already-tagged sample: scan current preview text for open list containers around needle.
  const content = getTaggerFlatContent();
  if (!content) return false;
  let from = 0;
  let found = -1;
  let pos = -1;
  while (from <= content.length) {
    const idx = content.indexOf(sel.plainText, from);
    if (idx < 0) break;
    // Skip matches that are inside tag markup itself.
    const before = content.slice(Math.max(0, idx - 2), idx);
    if (before !== "{{") {
      found += 1;
      // Prefer remaining occurrence index when possible; fall back to first usable hit.
      if (found === sel.occurrence || (sel.occurrence === 0 && pos < 0)) {
        pos = idx;
        if (found === sel.occurrence) break;
      }
    }
    from = idx + Math.max(1, sel.plainText.length);
  }
  if (pos < 0) return false;
  const head = content.slice(0, pos);
  const opens = (head.match(/\{\{#[^{}]*\}\}/g) || []).length;
  const closes = (head.match(/\{\{\/[^{}]*\}\}/g) || []).length;
  return opens > closes;
}

function syncTaggerKindFields() {
  const kind = /** @type {HTMLInputElement | null} */ (
    document.querySelector('input[name="taggerKind"]:checked')
  )?.value;
  const boolBox = document.getElementById("taggerBoolFields");
  const listBox = document.getElementById("taggerListFields");
  const nameLabel = document.getElementById("taggerVarNameLabel");
  const kindHint = document.getElementById("taggerKindHint");
  if (boolBox) boolBox.hidden = kind !== "bool";
  if (listBox) listBox.hidden = kind !== "list" && kind !== "list-table";
  if (nameLabel) {
    nameLabel.textContent =
      kind === "list" || kind === "list-table"
        ? "ชื่อลิสต์"
        : kind === "auto"
          ? "ชื่อรันเลข"
          : "ชื่อตัวแปร";
  }
  const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("taggerVarName"));
  if (nameInput) {
    nameInput.placeholder =
      kind === "list" || kind === "list-table"
        ? "เช่น items หรือ รายการ"
        : kind === "auto"
          ? "เช่น ลำดับ หรือ runno"
          : "เช่น customer_name หรือ พบ";
  }
  if (kindHint && taggerPendingSelection) {
    kindHint.hidden = false;
    if (kind === "auto") {
      const narrowed = resolveAutoReplaceTarget(
        taggerPendingSelection.plainText,
        taggerPendingSelection.occurrence,
      );
      if (narrowed && narrowed.plainText !== taggerPendingSelection.plainText.trim()) {
        kindHint.textContent = `รันเลขจะแทนที่เฉพาะ “${narrowed.plainText}” ในข้อความที่เลือก (ไม่ลบคำว่าจำเลยที่ / ป้ายข้างๆ)`;
      } else {
        kindHint.textContent =
          "รันเลข ({{+ชื่อ}}) ใช้ในลูป — เลือกเฉพาะตัวเลข หรือข้อความที่มีเลขหลัง «ที่»";
      }
    } else {
      updateTaggerKindContextHint(kindHint, taggerPendingSelection);
    }
  }
}

/**
 * Context hint under «ประเภท» based on selection (not the selected radio).
 * @param {HTMLElement} kindHint
 * @param {NonNullable<typeof taggerPendingSelection>} sel
 */
function updateTaggerKindContextHint(kindHint, sel) {
  const insideLoop = isSelectionInsideListLoop(sel);
  kindHint.hidden = false;
  if (sel.multiTableRow) {
    kindHint.textContent =
      "เลือกหลายแถวตารางพร้อมกันไม่ได้ — เลือกข้อความในแถวเดียว แล้วใช้ชนิด «ตาราง/ลิสต์»";
  } else if (insideLoop && sel.inTableRow) {
    kindHint.textContent =
      "แถวนี้อยู่ในลิสต์แล้ว — สร้างฟิลด์ข้อความ / รันเลข / ติ๊กภายในลูปได้ แต่สร้างลิสต์ซ้อนไม่ได้";
  } else if (sel.inTableRow) {
    kindHint.textContent =
      "เลือกอยู่ในแถวตาราง — ใช้ชนิด «ตาราง/ลิสต์» เพื่อห่อแถวด้วย {{#ชื่อ}}…{{/}} (แถวอื่นในตารางไม่ถูกลบอัตโนมัติ)";
  } else if (sel.inTable) {
    kindHint.textContent =
      "การเลือกอยู่ในตาราง — เลือกข้อความในแถวเดียวเพื่อสร้าง «ตาราง/ลิสต์»";
  } else {
    kindHint.textContent =
      "ข้อความนอกตาราง — เลือกชนิด «ลิสต์ (ย่อหน้า)» เพื่อห่อบล็อกซ้ำด้วย {{#ชื่อ}}…{{/}}";
  }
}

function renderTaggerListItemFields() {
  const host = document.getElementById("taggerListItemFields");
  const hint = document.getElementById("taggerListHint");
  if (!host || !taggerPendingSelection) return;
  const kind = /** @type {HTMLInputElement | null} */ (
    document.querySelector('input[name="taggerKind"]:checked')
  )?.value;

  if (kind === "list-table") {
    if (hint) {
      hint.textContent =
        "จะห่อทั้งแถวตารางด้วย {{#ชื่อ}} … {{/}} — ชื่อฟิลด์ดึงจากหัวคอลัมน์ · เลือกประเภทท้ายช่อง (ข้อความ / รันเลข / ติ๊ก) · แถวอื่นไม่ถูกลบอัตโนมัติ";
    }
    const cells = taggerPendingSelection.rowCells || [];
    const headers = taggerPendingSelection.rowHeaders || [];
    const usedNames = new Set();
    host.innerHTML = cells
      .map((c, i) => {
        const cellText = String(c.text || "").trim();
        const preview = cellText
          ? cellText.slice(0, 36) + (cellText.length > 36 ? "…" : "")
          : "(ว่าง)";
        if (isTaggerCellAlreadyReplaced(c)) {
          const existing = c.filledTag
            ? { tag: c.filledTag }
            : taggerSession?.replacements.find(
                (r) =>
                  r.mode !== "wrap" &&
                  r.mode !== "wrap-row" &&
                  r.mode !== "fill-empty-tc" &&
                  r.plainText === c.text &&
                  r.occurrence === c.occurrence,
              );
          return `
        <p class="tagger-list-note">เซลล์ ${i + 1}: “${escapeHtml(preview)}” — แท็กแล้ว <code>${escapeHtml(existing?.tag || "")}</code></p>
      `;
        }
        // Prefill from column header only — type comes from the ★ dropdown.
        const suggested = suggestFieldNameFromHeader(headers[i] || "", usedNames);
        const headerLabel = headers[i] ? String(headers[i]) : "";
        const headerHint = headerLabel
          ? ` · หัวตาราง: “${escapeHtml(headerLabel.slice(0, 24))}${headerLabel.length > 24 ? "…" : ""}”`
          : !cellText
            ? " · ว่าง (ข้ามได้)"
            : "";
        const emptyPh = suggested
          ? "ชื่อจากหัว — จะใส่แท็กในเซลล์ว่าง"
          : "เซลล์ว่าง — ใส่ชื่อจากหัว หรือข้าม";
        return `
        <label class="field-label" for="taggerCellField${i}">เซลล์ ${i + 1}: “${escapeHtml(preview)}”${headerHint}</label>
        <div class="tagger-field-row">
          <div class="tagger-name-combo">
            <input type="text" id="taggerCellField${i}" class="field-input tagger-cell-field" data-cell-index="${i}" autocomplete="off" value="${escapeAttr(suggested)}" placeholder="${cellText ? "ชื่อตัวแปร (ว่างได้)" : emptyPh}" />
            <label class="tagger-kind-star" title="ประเภทตัวแปร">
              <select class="tagger-cell-kind" data-cell-index="${i}" aria-label="ประเภทตัวแปรเซลล์ ${i + 1}">
                <option value="text" selected>ข้อความ</option>
                <option value="auto">รันเลข</option>
                <option value="bool">ติ๊ก</option>
              </select>
            </label>
          </div>
          <button type="button" class="btn-secondary btn-compact tagger-paste-btn" data-paste-into="taggerCellField${i}" title="วางข้อความที่คัดลอกไว้">วาง</button>
        </div>
      `;
      })
      .join("");
    syncTaggerPasteUi();
    return;
  }

  if (kind === "list") {
    if (hint) {
      hint.textContent =
        "ห่อย่อหน้า/บล็อกที่เลือกด้วย {{#ชื่อ}} … {{/}} (ไม่ต้องอยู่ในตาราง) — ใช้กับรายการซ้ำ เช่น จำเลย · แท็กฟิลด์ในลูปทีหลังได้ หรือตั้งชื่อทีละบรรทัดด้านล่าง";
    }
    const lines = taggerPendingSelection.lines || [];
    if (lines.length > 1) {
      host.innerHTML = lines
        .map((ln, i) => {
          const preview = ln.text.slice(0, 36) + (ln.text.length > 36 ? "…" : "");
          return `
          <label class="field-label" for="taggerLineField${i}">บรรทัด ${i + 1}: “${escapeHtml(preview)}”</label>
          <div class="tagger-field-row">
            <input type="text" id="taggerLineField${i}" class="field-input tagger-line-field" data-line-index="${i}" autocomplete="off" placeholder="เช่น name หรือ +ลำดับ (ว่าง = ห่อลูปอย่างเดียว)" />
            <button type="button" class="btn-secondary btn-compact tagger-paste-btn" data-paste-into="taggerLineField${i}" title="วางข้อความที่คัดลอกไว้">วาง</button>
          </div>
        `;
        })
        .join("");
    } else {
      host.innerHTML = `<p class="tagger-list-note">จะห่อย่อหน้านี้เป็นต้นแบบรายการซ้ำ — หลังสร้างลูปแล้ว เลือกข้อความภายในลูปเพื่อแท็กฟิลด์ (เช่น รันเลข / ชื่อ) ได้ตามปกติ</p>`;
    }
    syncTaggerPasteUi();
  }
}

function openTaggerCreateDialog() {
  if (!taggerSession) return;
  // Prefer a fresh live read; if the range already collapsed (float click), keep pending snapshot.
  const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  if (liveRoot) {
    const fresh = readTaggerSelection(liveRoot);
    if (fresh) taggerPendingSelection = fresh;
  }
  if (!taggerPendingSelection) {
    showBanner("เลือกข้อความในพรีวิวก่อน แล้วกดสร้างตัวแปรอีกครั้ง");
    return;
  }
  showBanner("");
  const dlg = document.getElementById("taggerDialog");
  const sample = document.getElementById("taggerDialogSample");
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById("taggerVarName"));
  const trueInput = /** @type {HTMLInputElement} */ (document.getElementById("taggerTrueText"));
  const falseInput = /** @type {HTMLInputElement} */ (document.getElementById("taggerFalseText"));
  const err = document.getElementById("taggerDialogError");
  const tableOpt = document.getElementById("taggerKindTable");
  const listOpt = document.getElementById("taggerKindList");
  const kindHint = document.getElementById("taggerKindHint");
  if (!dlg || !nameInput) return;

  const sel = taggerPendingSelection;
  const preview = sel.plainText.length > 80 ? `${sel.plainText.slice(0, 80)}…` : sel.plainText;
  const insideLoop = isSelectionInsideListLoop(sel);
  if (sample) {
    const where = sel.multiTableRow
      ? "หลายแถวตาราง"
      : sel.inTableRow
        ? "ในแถวตาราง"
        : sel.multiline
          ? "หลายย่อหน้า"
          : "ย่อหน้า";
    sample.textContent = `ที่เลือก (${where}): “${preview}”`;
  }

  // Kind gating:
  // - ตาราง/ลิสต์: only a single table row, and not already inside a loop
  // - ลิสต์ (ย่อหน้า): non-table text only (wrapping across table rows breaks OOXML)
  if (tableOpt) {
    const allowTableList = !!sel.inTableRow && !insideLoop && !sel.multiTableRow;
    tableOpt.hidden = !allowTableList;
    tableOpt.classList.toggle("is-emphasized", allowTableList);
  }
  if (listOpt) {
    const allowParaList = !sel.inTable && !sel.inTableRow && !sel.multiTableRow;
    listOpt.hidden = !allowParaList;
    listOpt.classList.toggle("is-emphasized", allowParaList && !!sel.multiline);
  }
  if (kindHint) updateTaggerKindContextHint(kindHint, sel);

  const autoOpt = document.getElementById("taggerKindAuto");
  if (autoOpt) {
    // Always available; emphasize when inside a loop or table row (typical runno spot).
    autoOpt.classList.toggle("is-emphasized", insideLoop || sel.inTableRow);
  }

  if (trueInput) trueInput.value = sel.plainText.slice(0, 24);
  if (falseInput) falseInput.value = "";

  // Pure digits outside a list (tax ID / ทะเบียน / เลขที่) → text field, never
  // auto or list-table — those IDs are labels, not runnos or row wraps.
  const plainTrim = String(sel.plainText || "").trim();
  const isDigits = /^\d+$/.test(plainTrim);
  let defaultKind = "text";
  if (isDigits && !insideLoop) {
    defaultKind = "text";
  } else if (sel.inTableRow && !insideLoop && !sel.multiTableRow) {
    defaultKind = "list-table";
  } else if (sel.multiline && !insideLoop && !sel.inTable) {
    defaultKind = "list";
  } else if (insideLoop && isDigits) {
    defaultKind = "auto";
  }

  if (defaultKind === "list" || defaultKind === "list-table") {
    nameInput.value = "items";
  } else if (defaultKind === "auto") {
    nameInput.value = isDigits ? "ลำดับ" : suggestTaggerName(sel.plainText) || "ลำดับ";
  } else if (isDigits) {
    // Prefer nearby label (ทะเบียนลูกค้า) over the raw digits as the variable name.
    nameInput.value = suggestTaggerNameFromContext(sel) || "field";
  } else {
    nameInput.value = suggestTaggerName(sel.plainText);
  }

  const radio = /** @type {HTMLInputElement | null} */ (
    document.querySelector(`input[name="taggerKind"][value="${defaultKind}"]`)
  );
  const radioLabel = radio?.closest("label");
  if (radio && radioLabel && !radioLabel.hidden) {
    radio.checked = true;
  } else {
    const textRadio = /** @type {HTMLInputElement | null} */ (
      document.querySelector('input[name="taggerKind"][value="text"]')
    );
    if (textRadio) textRadio.checked = true;
  }

  syncTaggerKindFields();
  renderTaggerListItemFields();
  syncTaggerPasteUi();
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  dlg.hidden = false;
  nameInput.focus();
  nameInput.select();
}

function closeTaggerDialog() {
  const dlg = document.getElementById("taggerDialog");
  if (dlg) dlg.hidden = true;
}

function isTaggerCreateDialogOpen() {
  const dlg = document.getElementById("taggerDialog");
  return !!(dlg && !dlg.hidden);
}

function isTaggerDeleteDialogOpen() {
  const dlg = document.getElementById("taggerDeleteDialog");
  return !!(dlg && !dlg.hidden);
}

function closeTaggerDeleteDialog() {
  const dlg = document.getElementById("taggerDeleteDialog");
  if (dlg) dlg.hidden = true;
}

/**
 * Build delete op(s) from the current selection: full paragraph(s) or one table row.
 * @param {{
 *   plainText: string,
 *   occurrence: number,
 *   inTableRow: boolean,
 *   multiline: boolean,
 *   rowCells: { text: string, occurrence: number }[],
 *   lines: { text: string, occurrence: number }[],
 * }} sel
 * @param {HTMLTableRowElement} [trEl] optional row to pin rowIndexInTable (same <w:tbl> only)
 * @returns {{ ops: object[], summary: string, detail: string } | { error: string }}
 */
function buildTaggerDeleteOps(sel, trEl) {
  if (!taggerSession || !sel) return { error: "ไม่พบข้อความที่เลือก" };
  const original = taggerSession.originalPlainText || "";
  const idBase = `d${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  if (sel.inTableRow) {
    const rowParts = (sel.rowCells || []).filter((c) => c.text && c.occurrence >= 0);
    if (!rowParts.length) {
      return { error: "จับคู่แถวตารางกับข้อความต้นฉบับไม่ได้ — ลองเลือกข้อความในเซลล์อีกครั้ง" };
    }
    const spanned = resolveTableRowPlainSpan(rowParts, original);
    const wrapPlain = spanned?.plainText || rowParts[0].text;
    const wrapOcc = spanned?.occurrence ?? rowParts[0].occurrence;
    const preview = wrapPlain.length > 80 ? `${wrapPlain.slice(0, 80)}…` : wrapPlain;
    const pin = trEl ? resolveTaggerDeleteRowPin(trEl) : null;
    return {
      ops: [
        {
          id: idBase,
          plainText: wrapPlain,
          occurrence: wrapOcc,
          tag: "",
          mode: "delete-tr",
          kind: "delete-tr",
          label: "ลบแถวตาราง",
          ...(pin
            ? { tableIndex: pin.tableIndex, rowIndexInTable: pin.rowIndexInTable }
            : {}),
        },
      ],
      summary: `จะลบทั้งแถวตารางที่มีข้อความ: “${preview}”`,
      detail: "ลบ <w:tr> ทั้งแถวจากไฟล์ .docx — คงหัวตารางและแถวอื่นไว้",
    };
  }

  const lines = (sel.lines || []).filter((ln) => ln.text && ln.occurrence >= 0);
  const targets = lines.length ? lines : [{ text: sel.plainText, occurrence: sel.occurrence }];
  if (!targets.length || !targets[0].text) {
    return { error: "ไม่พบย่อหน้าที่จะลบ" };
  }
  const ops = targets.map((ln, i) => ({
    id: `${idBase}_${i}`,
    plainText: ln.text,
    occurrence: ln.occurrence,
    tag: "",
    mode: "delete-p",
    kind: "delete-p",
    label: "ลบย่อหน้า",
  }));
  const preview = targets
    .map((t) => (t.text.length > 40 ? `${t.text.slice(0, 40)}…` : t.text))
    .join(" · ");
  return {
    ops,
    summary:
      ops.length > 1
        ? `จะลบ ${ops.length} ย่อหน้า: “${preview}”`
        : `จะลบทั้งย่อหน้า: “${preview}”`,
    detail: "ลบ <w:p> ทั้งย่อหน้าจากไฟล์ .docx — คงเลย์เอาต์รอบข้าง",
  };
}

/**
 * @param {{ ops: object[], summary: string, detail: string }} built
 */
function openTaggerDeleteDialogWithOps(built) {
  const dlg = document.getElementById("taggerDeleteDialog");
  const sample = document.getElementById("taggerDeleteSample");
  const hint = document.getElementById("taggerDeleteHint");
  if (sample) sample.textContent = built.summary;
  if (hint) {
    hint.hidden = false;
    hint.textContent = `${built.detail} สามารถยกเลิกได้จากรายการด้านล่างหลังลบ`;
  }
  const confirmBtn = document.getElementById("taggerDeleteConfirm");
  if (confirmBtn) confirmBtn.setAttribute("data-ops", JSON.stringify(built.ops));
  if (dlg) dlg.hidden = false;
}

function openTaggerDeleteDialog() {
  if (!taggerSession) return;
  const liveRoot = /** @type {HTMLElement | null} */ (document.getElementById("taggerSelectRoot"));
  if (liveRoot) {
    const fresh = readTaggerSelection(liveRoot);
    if (fresh) taggerPendingSelection = fresh;
  }
  if (!taggerPendingSelection) {
    showBanner("เลือกข้อความในพรีวิวก่อน แล้วกดลบแถวอีกครั้ง");
    return;
  }
  showBanner("");
  // Cross-row table selection is not a single deletable unit.
  const sel = window.getSelection();
  if (sel?.rangeCount && !taggerPendingSelection.inTableRow) {
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (range.startContainer)
        : range.startContainer.parentElement;
    const endEl =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? /** @type {Element} */ (range.endContainer)
        : range.endContainer.parentElement;
    const startTr = startEl?.closest?.("tr");
    const endTr = endEl?.closest?.("tr");
    if (startTr && endTr && startTr !== endTr) {
      showBanner("ลบแถวตารางได้ทีละแถว — เลือกข้อความในแถวเดียวแล้วลองใหม่");
      return;
    }
  }
  const built = buildTaggerDeleteOps(taggerPendingSelection);
  if ("error" in built) {
    showBanner(built.error);
    return;
  }
  openTaggerDeleteDialogWithOps(built);
}

async function confirmTaggerDelete() {
  if (!taggerSession) return;
  const confirmBtn = document.getElementById("taggerDeleteConfirm");
  let ops = [];
  try {
    ops = JSON.parse(confirmBtn?.getAttribute("data-ops") || "[]");
  } catch {
    ops = [];
  }
  if (!Array.isArray(ops) || !ops.length) {
    // Rebuild from pending selection if stash was lost.
    if (!taggerPendingSelection) {
      showBanner("ไม่พบรายการที่จะลบ — เลือกใหม่แล้วลองอีกครั้ง");
      return;
    }
    const built = buildTaggerDeleteOps(taggerPendingSelection);
    if ("error" in built) {
      showBanner(built.error);
      return;
    }
    ops = built.ops;
  }
  taggerPendingSelection = null;
  closeTaggerDeleteDialog();
  window.getSelection()?.removeAllRanges();
  await commitTaggerOps(ops);
}

/**
 * Push ops, apply to docx, roll back session ops if the server rejects them.
 * @param {typeof taggerSession.replacements} ops
 */
async function commitTaggerOps(ops) {
  if (!taggerSession || !ops?.length) return false;
  for (const op of ops) {
    if (!op.source) op.source = "session";
  }
  const prevLen = taggerSession.replacements.length;
  taggerSession.replacements.push(...ops);
  const ok = await applyTaggerReplacements();
  if (!ok && taggerSession) {
    taggerSession.replacements.length = prevLen;
    renderTaggerWorkspace();
  }
  return ok;
}

function suggestTaggerName(plain) {
  const cleaned = String(plain)
    .trim()
    .replace(/[/\\|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^\w\u0E00-\u0E7F.-]/gu, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || "field";
}

/**
 * For digit-only selections, prefer the Thai/Latin label just before the number
 * (e.g. "ทะเบียนลูกค้า\\t62014610" → ทะเบียนลูกค้า).
 * @param {{ plainText?: string, plainStart?: number } | null} sel
 */
function suggestTaggerNameFromContext(sel) {
  if (!sel || !taggerSession) return "";
  const original = taggerSession.originalPlainText || "";
  const needle = String(sel.plainText || "");
  let at =
    typeof sel.plainStart === "number" && sel.plainStart >= 0
      ? sel.plainStart
      : -1;
  if (at < 0 && needle) {
    at = nthOccurrenceStart(original, needle, Number(sel.occurrence) || 0);
  }
  if (at <= 0) return "";
  const before = original.slice(Math.max(0, at - 48), at);
  // Label immediately before tabs/spaces: "...ทะเบียนลูกค้า\t"
  const m = /([\u0E00-\u0E7Fa-zA-Z][\u0E00-\u0E7Fa-zA-Z0-9._-]{0,39})\s*$/u.exec(
    before.replace(/[\t ]+$/u, ""),
  );
  if (!m) return "";
  return suggestTaggerName(m[1]);
}

function buildTaggerTag(kind, name, trueText, falseText) {
  const n = String(name || "").trim();
  if (kind === "bool") {
    return `{{${n}?${trueText},${falseText}}}`;
  }
  if (kind === "auto") {
    // Engine: {{+ลำดับ}} → type auto (name includes leading +).
    return `{{+${n}}}`;
  }
  return `{{${n}}}`;
}

/**
 * Read a list-table cell field: name input + ★ type select (same combo object).
 * Leading "+" in the name still forces auto for paste/compat.
 * @param {HTMLInputElement} input
 * @returns {{ fieldName: string, fieldKind: 'text'|'auto'|'bool', idx: number } | null}
 */
function readTaggerCellFieldInput(input) {
  if (!input) return null;
  const idx = Number(input.getAttribute("data-cell-index"));
  if (!Number.isFinite(idx) || idx < 0) return null;
  const row = input.closest(".tagger-field-row");
  const kindSel = /** @type {HTMLSelectElement | null} */ (
    row?.querySelector(`.tagger-cell-kind[data-cell-index="${idx}"]`) ||
      row?.querySelector(".tagger-cell-kind")
  );
  /** @type {'text'|'auto'|'bool'} */
  let fieldKind = "text";
  const rawKind = kindSel?.value || "text";
  if (rawKind === "auto" || rawKind === "bool") fieldKind = rawKind;
  let fieldName = String(input.value || "").trim();
  if (fieldName.startsWith("+")) {
    fieldKind = "auto";
    fieldName = fieldName.slice(1).trim();
  }
  return { fieldName, fieldKind, idx };
}

function showTaggerDialogError(msg) {
  const err = document.getElementById("taggerDialogError");
  if (err) {
    err.hidden = false;
    err.textContent = msg;
  }
  showBanner(msg);
}

async function confirmTaggerVariable() {
  if (!taggerSession) return;
  if (!taggerPendingSelection) {
    showTaggerDialogError("ไม่พบข้อความที่เลือก — ปิดแล้วเลือกใหม่แล้วกดสร้างตัวแปรอีกครั้ง");
    return;
  }
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById("taggerVarName"));
  const kind =
    /** @type {HTMLInputElement | null} */ (document.querySelector('input[name="taggerKind"]:checked'))
      ?.value || "text";
  const trueText =
    /** @type {HTMLInputElement} */ (document.getElementById("taggerTrueText"))?.value ?? "";
  const falseText =
    /** @type {HTMLInputElement} */ (document.getElementById("taggerFalseText"))?.value ?? "";
  const name = nameInput?.value?.trim() || "";
  if (!name) {
    showTaggerDialogError(
      kind === "list" || kind === "list-table"
        ? "กรุณาใส่ชื่อลิสต์"
        : kind === "auto"
          ? "กรุณาใส่ชื่อรันเลข"
          : "กรุณาใส่ชื่อตัวแปร",
    );
    return;
  }
  if (name.startsWith("+")) {
    showTaggerDialogError('ไม่ต้องใส่เครื่องหมาย + นำหน้า — ระบบจะสร้างเป็น {{+ชื่อ}} ให้');
    return;
  }
  if (!/^[\w\u0E00-\u0E7F.-]+$/u.test(name)) {
    showTaggerDialogError("ชื่อใช้ได้เฉพาะตัวอักษร ตัวเลข _ . -");
    return;
  }

  if (kind === "auto" && !isSelectionInsideListLoop(taggerPendingSelection)) {
    showTaggerDialogError(
      "รันเลข ({{+ชื่อ}}) ใช้ได้เฉพาะภายในลูป {{#…}} — สร้างตาราง/ลิสต์ก่อน แล้วเลือกข้อความในลูปนั้น",
    );
    return;
  }

  const idBase = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  /** @type {typeof taggerSession.replacements} */
  const toAdd = [];

  if (kind === "list-table") {
    if (taggerPendingSelection.multiTableRow) {
      showTaggerDialogError(
        "เลือกหลายแถวตารางพร้อมกันไม่ได้ — เลือกข้อความในแถวเดียวแล้วลองใหม่",
      );
      return;
    }
    if (!taggerPendingSelection.inTableRow) {
      showTaggerDialogError("ต้องเลือกข้อความในแถวตาราง");
      return;
    }
    if (isSelectionInsideListLoop(taggerPendingSelection)) {
      showTaggerDialogError(
        "แถวนี้ถูกห่อเป็นลิสต์ไปแล้ว — สร้างฟิลด์ย่อยในแถวแทน (ข้อความ / รันเลข / ติ๊ก)",
      );
      return;
    }
    // Prefer the full row plain span (first→last matched cell in original),
    // including whitespace from empty cells (nbsp) that join("") drops.
    const rowParts = (taggerPendingSelection.rowCells || []).filter(
      (c) => c.text && c.occurrence >= 0,
    );
    if (!rowParts.length) {
      showTaggerDialogError("จับคู่แถวตารางกับข้อความต้นฉบับไม่ได้ — ลองเลือกข้อความในเซลล์อีกครั้ง");
      return;
    }
    const original = taggerSession.originalPlainText || "";
    const spanned = resolveTableRowPlainSpan(rowParts, original);
    let wrapPlain = spanned?.plainText || rowParts[0].text;
    let wrapOcc = spanned?.occurrence ?? rowParts[0].occurrence;
    const wrapStart =
      typeof spanned?.plainStart === "number"
        ? spanned.plainStart
        : typeof rowParts[0].plainStart === "number"
          ? rowParts[0].plainStart
          : undefined;
    const wrapTag = `{{#${name}}}`;
    // Index among wraps with this tag *before* pushing the current one (0-based).
    const wrapOccurrence = taggerSession.replacements.filter(
      (r) => (r.mode === "wrap-row" || r.kind === "list-table") && r.tag === wrapTag,
    ).length;
    toAdd.push({
      id: idBase,
      plainText: wrapPlain,
      occurrence: wrapOcc,
      tag: wrapTag,
      closeTag: "{{/}}",
      mode: "wrap-row",
      kind: "list-table",
      label: name,
      ...(typeof wrapStart === "number" && wrapStart >= 0 ? { plainStart: wrapStart } : {}),
    });
    // Place cells left→right in the row span so "ปทุมธานี" doesn't nest in "เมืองปทุมธานี".
    const seqRematch = rematchCellsSequentiallyInSpan(
      taggerPendingSelection.rowCells,
      wrapPlain,
      wrapOcc,
      original,
    );
    const cellInputs = /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll(".tagger-cell-field")
    );
    const headers = taggerPendingSelection.rowHeaders || [];
    const usedAtConfirm = new Set(
      [...cellInputs]
        .map((el) => String(el.value || "").trim().replace(/^\+/, ""))
        .filter(Boolean),
    );
    for (const input of cellInputs) {
      const parsed = readTaggerCellFieldInput(input);
      if (!parsed) continue;
      let { fieldName, fieldKind, idx } = parsed;
      const cellPreview = taggerPendingSelection.rowCells[idx];
      const cellIsEmpty = !String(cellPreview?.text || "").trim();
      // Empty cells under a header were often left blank in the dialog → silently skipped.
      if (!fieldName && cellIsEmpty) {
        fieldName = suggestFieldNameFromHeader(headers[idx] || "", usedAtConfirm);
      }
      if (!fieldName) continue;
      usedAtConfirm.add(fieldName);
      if (!/^[\w\u0E00-\u0E7F.-]+$/u.test(fieldName)) {
        showTaggerDialogError(
          `ชื่อฟิลด์เซลล์ไม่ถูกต้อง: ${fieldName} — ใช้ตัวอักษร ตัวเลข _ . -`,
        );
        return;
      }
      const cell = taggerPendingSelection.rowCells[idx];
      if (!cell) continue;
      const isAutoField = fieldKind === "auto";
      const cellTag =
        fieldKind === "bool"
          ? buildTaggerTag("bool", fieldName, "√", "")
          : buildTaggerTag(fieldKind, fieldName, "", "");
      // DOM slot index ≠ Word <w:tc> when rowspan holes exist above this row.
      const wordCellIndex =
        typeof cell.tcIndex === "number" && cell.tcIndex >= 0 ? cell.tcIndex : idx;
      const cellEmpty = !String(cell.text || "").trim();
      // Empty cells, or cells whose plain text can't be matched (√ with
      // padding spaces, odd checkbox glyphs): set by cell index on the row.
      const fillMeta = {
        wrapTag,
        wrapOccurrence,
        domCellIndex: idx,
        ...(typeof wrapStart === "number" && wrapStart >= 0 ? { plainStart: wrapStart } : {}),
        ...(typeof taggerPendingSelection.tableIndex === "number"
          ? { tableIndex: taggerPendingSelection.tableIndex }
          : {}),
        ...(typeof taggerPendingSelection.rowIndexInTable === "number"
          ? { rowIndexInTable: taggerPendingSelection.rowIndexInTable }
          : {}),
      };
      if (cellEmpty || cell.occurrence < 0) {
        toAdd.push({
          id: `${idBase}_c${idx}`,
          plainText: wrapPlain,
          occurrence: wrapOcc,
          tag: cellTag,
          mode: "fill-empty-tc",
          cellIndex: wordCellIndex,
          kind: fieldKind,
          label: fieldName,
          ...fillMeta,
          ...(fieldKind === "bool" ? { trueText: "√", falseText: "" } : {}),
        });
        continue;
      }
      if (isTaggerCellAlreadyReplaced(cell)) {
        // Already tagged in a prior step — skip duplicate replace.
        continue;
      }
      const rematched =
        seqRematch[idx] || rematchPlainInsideSpan(cell.text, wrapPlain, wrapOcc, original);
      let cellPlain = rematched?.plainText || cell.text;
      let cellOcc = rematched?.occurrence ?? cell.occurrence;
      let cellStart =
        typeof rematched?.plainStart === "number"
          ? rematched.plainStart
          : typeof cell.plainStart === "number"
            ? cell.plainStart
            : undefined;
      if (isAutoField && rematched) {
        const narrowed = resolveAutoReplaceTarget(cellPlain, cellOcc);
        if (!narrowed) {
          showTaggerDialogError(
            `เซลล์ ${idx + 1}: หาเลขรันไม่เจอใน “${cell.text.slice(0, 32)}” — เลือกเฉพาะตัวเลข หรือใช้ประเภทข้อความ`,
          );
          return;
        }
        cellPlain = narrowed.plainText;
        cellOcc = narrowed.occurrence;
        cellStart = undefined;
      }
      // No safe plain match, or would collide with a longer already-tagged span
      // (e.g. "1" vs "1โฉนด…"): set by cell index on this wrapped row only.
      if (
        !rematched ||
        overlapsExistingTaggerPlain(cellPlain, cellOcc, toAdd)
      ) {
        toAdd.push({
          id: `${idBase}_c${idx}`,
          plainText: wrapPlain,
          occurrence: wrapOcc,
          tag: cellTag,
          mode: "fill-empty-tc",
          cellIndex: wordCellIndex,
          kind: fieldKind,
          label: fieldName,
          ...fillMeta,
          ...(fieldKind === "bool" ? { trueText: "√", falseText: "" } : {}),
        });
        continue;
      }
      toAdd.push({
        id: `${idBase}_c${idx}`,
        plainText: cellPlain,
        occurrence: cellOcc,
        tag: cellTag,
        mode: "replace",
        kind: fieldKind,
        label: fieldName,
        wrapTag,
        wrapOccurrence,
        ...(typeof cellStart === "number" && cellStart >= 0 ? { plainStart: cellStart } : {}),
        ...(fieldKind === "bool" ? { trueText: "√", falseText: "" } : {}),
      });
    }
  } else if (kind === "list") {
    if (
      taggerPendingSelection.inTableRow ||
      taggerPendingSelection.multiTableRow ||
      taggerPendingSelection.inTable
    ) {
      showTaggerDialogError(
        "ในตารางให้ใช้ชนิด «ตาราง/ลิสต์» และเลือกข้อความในแถวเดียว — ห้ามห่อย่อหน้าข้ามแถวตาราง",
      );
      return;
    }
    toAdd.push({
      id: idBase,
      plainText: taggerPendingSelection.plainText,
      occurrence: taggerPendingSelection.occurrence,
      tag: `{{#${name}}}`,
      closeTag: "{{/}}",
      mode: "wrap",
      kind: "list",
      label: name,
      ...(typeof taggerPendingSelection.plainStart === "number" &&
      taggerPendingSelection.plainStart >= 0
        ? { plainStart: taggerPendingSelection.plainStart }
        : {}),
    });
    const lineInputs = /** @type {NodeListOf<HTMLInputElement>} */ (
      document.querySelectorAll(".tagger-line-field")
    );
    for (const input of lineInputs) {
      const rawField = input.value.trim();
      if (!rawField) continue;
      const isAutoField = rawField.startsWith("+");
      const fieldName = isAutoField ? rawField.slice(1).trim() : rawField;
      if (!fieldName || !/^[\w\u0E00-\u0E7F.-]+$/u.test(fieldName)) {
        showTaggerDialogError(
          `ชื่อฟิลด์บรรทัดไม่ถูกต้อง: ${rawField} — ใช้ชื่อปกติ หรือ +ลำดับ สำหรับรันเลข`,
        );
        return;
      }
      const idx = Number(input.getAttribute("data-line-index"));
      const line = taggerPendingSelection.lines[idx];
      if (!line?.text || line.occurrence < 0) {
        showTaggerDialogError(`จับคู่ข้อความบรรทัด ${idx + 1} ไม่ได้`);
        return;
      }
      let linePlain = line.text;
      let lineOcc = line.occurrence;
      if (isAutoField) {
        const narrowed = resolveAutoReplaceTarget(line.text, line.occurrence);
        if (!narrowed) {
          showTaggerDialogError(
            `บรรทัด ${idx + 1}: หาเลขรันไม่เจอ — เลือกเฉพาะตัวเลข หรือใส่ชื่อฟิลด์ปกติ`,
          );
          return;
        }
        linePlain = narrowed.plainText;
        lineOcc = narrowed.occurrence;
      }
      toAdd.push({
        id: `${idBase}_l${idx}`,
        plainText: linePlain,
        occurrence: lineOcc,
        tag: isAutoField ? `{{+${fieldName}}}` : `{{${fieldName}}}`,
        mode: "replace",
        kind: isAutoField ? "auto" : "text",
        label: fieldName,
      });
    }
  } else {
    const tag = buildTaggerTag(kind, name, trueText, falseText);
    if (!/^\{\{[^{}]+\}\}$/.test(tag)) {
      showTaggerDialogError("แท็กไม่ถูกต้อง");
      return;
    }
    let plain = taggerPendingSelection.plainText;
    let occ = taggerPendingSelection.occurrence;
    if (kind === "auto") {
      const narrowed = resolveAutoReplaceTarget(plain, occ);
      if (narrowed) {
        plain = narrowed.plainText;
        occ = narrowed.occurrence;
      } else if (!/^\d+$/.test(plain.trim())) {
        showTaggerDialogError(
          "รันเลขต้องเลือกตัวเลข (เช่น 1) หรือข้อความที่มีเลขหลัง «ที่» เช่น จำเลยที่1",
        );
        return;
      }
    }
    toAdd.push({
      id: idBase,
      plainText: plain,
      occurrence: occ,
      tag,
      mode: "replace",
      kind: /** @type {'text'|'bool'|'auto'} */ (kind),
      label: name,
      trueText,
      falseText,
      ...(typeof taggerPendingSelection.plainStart === "number" &&
      taggerPendingSelection.plainStart >= 0 &&
      kind !== "auto"
        ? { plainStart: taggerPendingSelection.plainStart }
        : {}),
    });
  }

  for (const op of toAdd) ensureTaggerPlainStart(op);
  taggerPendingSelection = null;
  closeTaggerDialog();
  window.getSelection()?.removeAllRanges();
  await commitTaggerOps(toAdd);
}

/**
 * Field kinds that can be switched in the edit dialog (not list wraps / deletes).
 * @param {{ kind?: string, mode?: string }} r
 */
function taggerEditCanChangeKind(r) {
  if (!r || isTaggerDeleteOp(r)) return false;
  if (r.kind === "list" || r.kind === "list-table") return false;
  const mode = r.mode || "replace";
  return mode === "replace" || mode === "fill-empty-tc";
}

function syncTaggerEditKindFields() {
  const kind =
    /** @type {HTMLInputElement | null} */ (
      document.querySelector('#taggerEditFields input[name="taggerEditKind"]:checked')
    )?.value || "text";
  const boolBox = document.getElementById("taggerEditBoolFields");
  if (boolBox) boolBox.hidden = kind !== "bool";
  const nameLabel = document.getElementById("taggerEditNameLabel");
  if (nameLabel) {
    nameLabel.textContent = kind === "auto" ? "ชื่อรันเลข" : "ชื่อตัวแปร";
  }
  // Seed bool texts when switching to ติ๊ก for the first time.
  if (kind === "bool") {
    const trueInput = /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditTrue"));
    const falseInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("taggerEditFalse")
    );
    const saveBtn = document.getElementById("taggerEditSave");
    const id = saveBtn?.getAttribute("data-id");
    const r = id && taggerSession ? taggerSession.replacements.find((x) => x.id === id) : null;
    if (trueInput && !trueInput.value.trim()) {
      const sample = String(r?.plainText || "").trim();
      trueInput.value = /^[√✓✔☑]$/u.test(sample) ? sample : "√";
    }
    if (falseInput && falseInput.value === "" && r?.kind === "bool" && r.falseText != null) {
      falseInput.value = r.falseText;
    }
  }
}

function openTaggerEditDialog(id) {
  if (!taggerSession) return;
  const r = taggerSession.replacements.find((x) => x.id === id);
  if (!r) return;
  const dlg = document.getElementById("taggerEditDialog");
  const titleEl = document.getElementById("taggerEditTitle");
  const sample = document.getElementById("taggerEditSample");
  const tagEl = document.getElementById("taggerEditTag");
  const fieldsEl = document.getElementById("taggerEditFields");
  const errEl = document.getElementById("taggerEditError");
  const removeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("taggerEditRemove"));
  const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("taggerEditSave"));
  const isDelete = isTaggerDeleteOp(r);
  const isList = r.kind === "list" || r.kind === "list-table";
  const fromFile = r.source === "existing";
  const canChangeKind = taggerEditCanChangeKind(r);
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  if (titleEl) titleEl.textContent = isDelete ? "รายการลบแถว" : "แก้ตัวแปร";
  if (sample) {
    if (isDelete) sample.textContent = `จะลบ: “${r.plainText}”`;
    else if (fromFile) {
      sample.textContent =
        "แท็กที่มีอยู่ในไฟล์แล้ว — แก้ชื่อ/ประเภทได้ แต่ยกเลิกไม่ได้ เพราะไม่มีข้อความต้นฉบับเหลืออยู่";
    } else if (r.mode === "fill-empty-tc") {
      const col =
        typeof r.cellIndex === "number" ? `เซลล์ ${r.cellIndex + 1}` : "เซลล์ว่าง";
      sample.textContent = `${col} (ใส่แท็กในช่องว่าง)`;
    } else {
      sample.textContent = `ข้อความเดิม: “${r.plainText}”`;
    }
  }
  if (fieldsEl) {
    if (isDelete) {
      fieldsEl.hidden = true;
      fieldsEl.innerHTML = "";
    } else {
      fieldsEl.hidden = false;
      const kind = r.kind === "bool" || r.kind === "auto" ? r.kind : "text";
      const trueDefault =
        r.trueText ||
        (/^[√✓✔☑]$/u.test(String(r.plainText || "").trim())
          ? String(r.plainText).trim()
          : "√");
      const kindBlock = canChangeKind
        ? `
        <p class="field-label">ประเภท</p>
        <div class="tagger-kind tagger-edit-kind" role="radiogroup" aria-label="ประเภทตัวแปร">
          <label class="kind-text" data-kind="text"><input type="radio" name="taggerEditKind" value="text" ${kind === "text" ? "checked" : ""} /> ข้อความ <code>{{ชื่อ}}</code></label>
          <label class="kind-bool" data-kind="bool"><input type="radio" name="taggerEditKind" value="bool" ${kind === "bool" ? "checked" : ""} /> ติ๊ก <code>{{ชื่อ?จริง,เท็จ}}</code></label>
          <label class="kind-auto" data-kind="auto"><input type="radio" name="taggerEditKind" value="auto" ${kind === "auto" ? "checked" : ""} /> รันเลข <code>{{+ชื่อ}}</code></label>
        </div>`
        : isList
          ? `<p class="tagger-list-note">ชนิดลิสต์ — เปลี่ยนได้เฉพาะชื่อลูป</p>`
          : "";
      fieldsEl.innerHTML = `
        ${kindBlock}
        <label class="field-label" for="taggerEditName" id="taggerEditNameLabel">${kind === "auto" ? "ชื่อรันเลข" : isList ? "ชื่อลิสต์" : "ชื่อตัวแปร"}</label>
        <input type="text" id="taggerEditName" class="field-input" value="${escapeAttr(r.label || "")}" autocomplete="off" />
        <div id="taggerEditBoolFields" class="tagger-bool-fields" ${kind === "bool" ? "" : "hidden"}>
          <label class="field-label" for="taggerEditTrue">ข้อความเมื่อติ๊ก (จริง)</label>
          <input type="text" id="taggerEditTrue" class="field-input" value="${escapeAttr(r.kind === "bool" ? r.trueText || trueDefault : trueDefault)}" />
          <label class="field-label" for="taggerEditFalse">ข้อความเมื่อไม่ติ๊ก (เท็จ)</label>
          <input type="text" id="taggerEditFalse" class="field-input" value="${escapeAttr(r.falseText || "")}" placeholder="ว่างได้" />
        </div>
      `;
    }
  }
  if (tagEl) {
    tagEl.textContent = isDelete
      ? r.mode === "delete-tr" || r.kind === "delete-tr"
        ? "ลบแถวตาราง"
        : "ลบย่อหน้า"
      : isList
        ? `${r.tag} … ${r.closeTag || "{{/}}"}`
        : r.tag;
  }
  if (saveBtn) {
    saveBtn.hidden = isDelete;
    saveBtn.setAttribute("data-id", id);
  }
  if (removeBtn) {
    removeBtn.setAttribute("data-id", id);
    removeBtn.textContent = isDelete ? "ยกเลิกลบแถว" : "ยกเลิกแท็ก";
    // Existing file tags have no original prose to restore.
    removeBtn.hidden = fromFile;
    removeBtn.disabled = fromFile;
  }
  if (dlg) dlg.hidden = false;
  if (!isDelete) {
    syncTaggerEditKindFields();
    syncTaggerEditTagPreview();
  }
}

function syncTaggerEditTagPreview() {
  const saveBtn = document.getElementById("taggerEditSave");
  const id = saveBtn?.getAttribute("data-id");
  if (!id || !taggerSession) return;
  const r = taggerSession.replacements.find((x) => x.id === id);
  if (!r || isTaggerDeleteOp(r)) return;
  const name = /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditName"))
    ?.value;
  const editKind =
    /** @type {HTMLInputElement | null} */ (
      document.querySelector('#taggerEditFields input[name="taggerEditKind"]:checked')
    )?.value ||
    (taggerEditCanChangeKind(r) ? "text" : r.kind);
  const kind =
    r.kind === "list" || r.kind === "list-table"
      ? r.kind
      : editKind === "bool" || editKind === "auto" || editKind === "text"
        ? editKind
        : r.kind;
  const trueText =
    /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditTrue"))?.value ??
    r.trueText ??
    "";
  const falseText =
    /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditFalse"))?.value ??
    r.falseText ??
    "";
  const tagEl = document.getElementById("taggerEditTag");
  if (!tagEl) return;
  const n = String(name ?? r.label ?? "").trim();
  if (kind === "list" || kind === "list-table") {
    tagEl.textContent = n ? `{{#${n}}} … {{/}}` : r.tag;
  } else if (kind === "bool") {
    tagEl.textContent = n ? buildTaggerTag("bool", n, trueText, falseText) : r.tag;
  } else if (kind === "auto") {
    tagEl.textContent = n ? buildTaggerTag("auto", n, "", "") : r.tag;
  } else {
    tagEl.textContent = n ? buildTaggerTag("text", n, "", "") : r.tag;
  }
}

async function saveTaggerEdit() {
  if (!taggerSession) return;
  const saveBtn = document.getElementById("taggerEditSave");
  const id = saveBtn?.getAttribute("data-id");
  const errEl = document.getElementById("taggerEditError");
  const showErr = (msg) => {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = msg;
    }
    showBanner(msg);
  };
  if (!id) return;
  const r = taggerSession.replacements.find((x) => x.id === id);
  if (!r || isTaggerDeleteOp(r)) return;
  const name = String(
    /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditName"))?.value || "",
  ).trim();
  if (!name || !/^[\w\u0E00-\u0E7F.-]+$/u.test(name)) {
    showErr("ชื่อตัวแปรไม่ถูกต้อง — ใช้ตัวอักษร ตัวเลข ไทย . - _");
    return;
  }
  const editKindRaw =
    /** @type {HTMLInputElement | null} */ (
      document.querySelector('#taggerEditFields input[name="taggerEditKind"]:checked')
    )?.value;
  const nextKind =
    r.kind === "list" || r.kind === "list-table"
      ? r.kind
      : taggerEditCanChangeKind(r) &&
          (editKindRaw === "text" || editKindRaw === "bool" || editKindRaw === "auto")
        ? editKindRaw
        : r.kind === "bool" || r.kind === "auto"
          ? r.kind
          : "text";

  if (nextKind === "auto") {
    const sel = {
      plainText: r.plainText,
      occurrence: r.occurrence,
      inTableRow: true,
    };
    if (!isSelectionInsideListLoop(sel)) {
      showErr(
        "รันเลข ({{+ชื่อ}}) ใช้ได้เฉพาะภายในลูป {{#…}} — แท็กนี้อยู่นอกลูป หรือสร้างตาราง/ลิสต์ก่อน",
      );
      return;
    }
  }

  let nextTag = r.tag;
  let trueText = r.trueText;
  let falseText = r.falseText;
  if (nextKind === "list" || nextKind === "list-table") {
    nextTag = `{{#${name}}}`;
    r.closeTag = r.closeTag || "{{/}}";
  } else if (nextKind === "bool") {
    trueText =
      /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditTrue"))?.value ??
      "";
    falseText =
      /** @type {HTMLInputElement | null} */ (document.getElementById("taggerEditFalse"))?.value ??
      "";
    nextTag = buildTaggerTag("bool", name, trueText, falseText);
  } else if (nextKind === "auto") {
    nextTag = buildTaggerTag("auto", name, "", "");
    trueText = undefined;
    falseText = undefined;
  } else {
    nextTag = buildTaggerTag("text", name, "", "");
    trueText = undefined;
    falseText = undefined;
  }
  if (!/^\{\{[^{}]+\}\}$/.test(nextTag)) {
    showErr("แท็กไม่ถูกต้อง");
    return;
  }
  const prev = {
    tag: r.tag,
    label: r.label,
    kind: r.kind,
    trueText: r.trueText,
    falseText: r.falseText,
    closeTag: r.closeTag,
  };
  r.label = name;
  r.tag = nextTag;
  r.kind = /** @type {'text'|'bool'|'auto'|'list'|'list-table'} */ (nextKind);
  if (nextKind === "bool") {
    r.trueText = trueText;
    r.falseText = falseText;
  } else {
    delete r.trueText;
    delete r.falseText;
  }
  const dlg = document.getElementById("taggerEditDialog");
  if (dlg) dlg.hidden = true;
  const ok = await applyTaggerReplacements();
  if (!ok) {
    r.tag = prev.tag;
    r.label = prev.label;
    r.kind = prev.kind;
    r.trueText = prev.trueText;
    r.falseText = prev.falseText;
    r.closeTag = prev.closeTag;
    renderTaggerWorkspace();
    return;
  }
  showBanner(`อัปเดตแท็กเป็น ${nextTag} แล้ว`, "success");
  setTimeout(() => showBanner(""), 2400);
}

/**
 * Ids to drop when cancelling a tag — wraps also drop their child fields.
 * @param {{ id: string, tag?: string, plainText?: string, mode?: string, kind?: string }} r
 */
function collectTaggerRemovalIds(r) {
  const ids = new Set([r.id]);
  if (!taggerSession) return ids;
  const isWrap =
    r.mode === "wrap-row" ||
    r.mode === "wrap" ||
    r.kind === "list-table" ||
    r.kind === "list";
  if (!isWrap) return ids;

  const prefix = `${r.id}_`;
  const original = taggerSession.originalPlainText || "";
  const wStart = ensureTaggerPlainStart(r, original);
  const wEnd =
    typeof wStart === "number" && wStart >= 0
      ? wStart + String(r.plainText || "").length
      : -1;
  const sameTagWraps = taggerSession.replacements.filter(
    (x) =>
      (x.mode === "wrap-row" ||
        x.kind === "list-table" ||
        x.mode === "wrap" ||
        x.kind === "list") &&
      x.tag === r.tag,
  );
  const wrapOccIdx = sameTagWraps.findIndex((x) => x.id === r.id);

  for (const x of taggerSession.replacements) {
    if (x.id === r.id) continue;
    if (x.id.startsWith(prefix)) {
      ids.add(x.id);
      continue;
    }
    if (
      x.wrapTag &&
      x.wrapTag === r.tag &&
      (typeof x.wrapOccurrence !== "number" ||
        wrapOccIdx < 0 ||
        x.wrapOccurrence === wrapOccIdx)
    ) {
      ids.add(x.id);
      continue;
    }
    if (wEnd < 0) continue;
    if (
      x.mode === "wrap-row" ||
      x.mode === "wrap" ||
      x.kind === "list-table" ||
      x.kind === "list" ||
      isTaggerDeleteOp(x)
    ) {
      continue;
    }
    const fs = ensureTaggerPlainStart(x, original);
    if (typeof fs !== "number" || fs < 0) continue;
    const fe = fs + String(x.plainText || "").length;
    if (fs >= wStart && fe <= wEnd) ids.add(x.id);
  }
  return ids;
}

async function removeTaggerReplacement(id) {
  if (!taggerSession) return;
  const r = taggerSession.replacements.find((x) => x.id === id);
  if (r?.source === "existing") {
    showBanner("แท็กจากไฟล์เดิมยกเลิกไม่ได้ — ไม่มีข้อความต้นฉบับเหลืออยู่");
    return;
  }
  if (!r) return;
  const removeIds = collectTaggerRemovalIds(r);
  const droppedChildren = removeIds.size - 1;
  taggerSession.replacements = taggerSession.replacements.filter((x) => !removeIds.has(x.id));
  const dlg = document.getElementById("taggerEditDialog");
  if (dlg) dlg.hidden = true;
  // If only identity/existing ops remain, keep downloadable file.
  const ok = await applyTaggerReplacements();
  if (ok && !taggerSession.replacements.length) {
    taggerSession.taggedFile = taggerSession.originalFile;
  }
  if (ok && droppedChildren > 0) {
    showBanner(`ยกเลิกลิสต์แล้ว — ลบแท็กในลิสต์ ${droppedChildren} รายการด้วย`, "success");
    setTimeout(() => showBanner(""), 2800);
  }
}

function downloadTaggedTemplate() {
  if (!taggerSession?.taggedFile) {
    showBanner("ยังไม่มีเทมเพลตที่แท็กแล้ว");
    return;
  }
  const url = URL.createObjectURL(taggerSession.taggedFile);
  const a = document.createElement("a");
  a.href = url;
  a.download = taggerSession.taggedFile.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  showBanner("ดาวน์โหลดเทมเพลตแล้ว", "success");
  setTimeout(() => showBanner(""), 2400);
}

async function openTaggedInFillForm() {
  if (!taggerSession?.taggedFile) {
    showBanner("ยังไม่มีเทมเพลตที่แท็กแล้ว");
    return;
  }
  const file = taggerSession.taggedFile;
  taggerSession = null;
  taggerPendingSelection = null;
  removeTaggerDialogPortals();
  state.showFullContent = true;
  await parseFile(file, null);
}

/**
 * @param {File} file
 * @param {boolean} preferContent
 */
async function parseTemplatePayload(file, preferContent) {
  const fd = new FormData();
  fd.append("file", file);
  if (preferContent) fd.append("includeContent", "1");
  const res = await fetch("/api/parse", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `อ่านเทมเพลตไม่สำเร็จ: ${file.name}`);
  }
  /** @type {FormField[]} */
  const fields = data.fields || [];
  /** @type {Record<string, any>} */
  const values = {};
  /** @type {Record<string, File | null>} */
  const images = {};
  /** @type {Record<string, boolean>} */
  const skip = {};
  /** @type {Record<string, Record<string, boolean>[]>} */
  const rowSkip = {};
  for (const f of fields) {
    skip[f.name] = false;
    if (f.type === "text") values[f.name] = "";
    else if (f.type === "bool") values[f.name] = false;
    else if (f.type === "image") images[f.name] = null;
    else if (f.type === "list") {
      values[f.name] = [];
      rowSkip[f.name] = [];
    }
  }
  return {
    file,
    filename: data.filename || file.name,
    fields,
    values,
    images,
    skip,
    rowSkip,
    fileContent:
      preferContent && typeof data.content === "string" ? data.content : "",
    fileLayout:
      preferContent && Array.isArray(data.layout) ? data.layout : [],
  };
}

/** @type {WeakSet<File>} */
const contentHydrating = typeof WeakSet !== "undefined" ? new WeakSet() : null;
/** @type {Set<string>} */
const contentHydratedIds = new Set();

/**
 * Load preview layout in the background after fields are already on screen.
 * @param {typeof multiSlots[number] | null} slot
 * @param {{ silent?: boolean }} [opts]
 */
async function hydrateTemplateContent(slot, opts = {}) {
  if (!slot?.file || !state.showFullContent) return;
  if (slot.fileLayout?.length || slot.fileContent) {
    contentHydratedIds.add(slot.id);
    return;
  }
  if (contentHydratedIds.has(slot.id)) return;
  if (contentHydrating?.has(slot.file)) return;
  contentHydrating?.add(slot.file);
  try {
    if (!opts.silent) {
      showBanner(`กำลังโหลดตัวอย่างเนื้อหา — ${slot.filename}`, "progress");
    }
    const full = await parseTemplatePayload(slot.file, true);
    // Slot may have been removed / replaced.
    const live = multiSlots.find((s) => s.id === slot.id);
    if (!live || live.file !== slot.file) return;
    live.fileContent = full.fileContent;
    live.fileLayout = full.fileLayout;
    contentHydratedIds.add(slot.id);
    if (multiActiveId === slot.id) {
      state.fileContent = full.fileContent;
      state.fileLayout = full.fileLayout;
      renderForm();
    } else {
      persistActiveSlot();
    }
    if (!opts.silent) {
      showBanner("");
    }
  } catch (err) {
    console.warn("hydrateTemplateContent", err);
    if (!opts.silent) {
      showBanner(
        err instanceof Error
          ? `โหลดตัวอย่างเนื้อหาไม่สำเร็จ: ${err.message}`
          : "โหลดตัวอย่างเนื้อหาไม่สำเร็จ",
      );
    }
  } finally {
    contentHydrating?.delete(slot.file);
  }
}

/**
 * @param {File} file
 * @param {HTMLElement | null} errorEl
 */
async function parseFile(file, errorEl) {
  showBanner("");
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  const lower = file.name.toLowerCase();
  if (lower.endsWith(".doc") && !lower.endsWith(".docx")) {
    const msg = "รองรับเฉพาะ .docx — ให้ Save As เป็น .docx ใน Word ก่อน";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }
  if (!lower.endsWith(".docx")) {
    const msg = "ไฟล์ต้องเป็น .docx เท่านั้น";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }

  // Same as npm CLI UI: one /api/parse (fields + optional layout) — no double round-trip.
  app.setAttribute("aria-busy", "true");
  try {
    const preferContent = state.showFullContent;
    const parsed = await parseTemplatePayload(file, preferContent);
    resetFormState();
    state.showFullContent = preferContent;
    state.file = parsed.file;
    state.filename = parsed.filename;
    state.fields = parsed.fields;
    state.values = parsed.values;
    state.images = parsed.images;
    state.skip = parsed.skip;
    state.rowSkip = parsed.rowSkip;
    state.fileContent = parsed.fileContent;
    state.fileLayout = parsed.fileLayout;
    for (const f of state.fields) {
      if (f.type === "list") ensureListRows(f.name, f.itemFields);
    }
    const id = newSlotId();
    multiActiveId = id;
    multiSlots = [
      {
        id,
        file: state.file,
        filename: state.filename,
        fields: state.fields,
        values: structuredClone(state.values),
        images: { ...state.images },
        skip: structuredClone(state.skip),
        rowSkip: structuredClone(state.rowSkip),
        fileContent: state.fileContent,
        fileLayout: state.fileLayout,
      },
    ];
    contentHydratedIds.clear();
    if (preferContent && (parsed.fileLayout.length || parsed.fileContent)) {
      contentHydratedIds.add(id);
    }
    renderForm();
    scheduleSaveDraft();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
  } finally {
    app.removeAttribute("aria-busy");
  }
}

/**
 * Append more .docx templates without wiping the ones already open.
 * @param {File[]} files
 * @param {HTMLElement | null} [errorEl]
 */
async function appendTemplateFiles(files, errorEl = null) {
  showBanner("");
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  if (!state.file) {
    await parseMultipleTemplates(files, errorEl);
    return;
  }

  const docx = files.filter((f) => f.name.toLowerCase().endsWith(".docx"));
  if (!docx.length) {
    const msg = "เลือกไฟล์ .docx อย่างน้อย 1 ไฟล์";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }

  persistActiveSlot();
  if (!multiSlots.length && state.file) {
    const id = multiActiveId || newSlotId();
    multiActiveId = id;
    multiSlots = [
      {
        id,
        file: state.file,
        filename: state.filename,
        fields: state.fields,
        values: structuredClone(state.values),
        images: { ...state.images },
        skip: structuredClone(state.skip),
        rowSkip: structuredClone(state.rowSkip),
        fileContent: state.fileContent,
        fileLayout: state.fileLayout,
      },
    ];
  }

  const room = 12 - multiSlots.length;
  if (room <= 0) {
    showBanner("เลือกเทมเพลตได้ไม่เกิน 12 ไฟล์");
    return;
  }
  const toAdd = docx.slice(0, room);
  if (docx.length > room) {
    showBanner(`เพิ่มได้สูงสุด ${room} ไฟล์จากชุดนี้ (รวมแล้วไม่เกิน 12)`);
  }

  app.setAttribute("aria-busy", "true");
  try {
    const preferContent = state.showFullContent;
    const addedNames = [];
    /** @type {typeof multiSlots} */
    const addedSlots = [];
    for (const file of toAdd) {
      const parsed = await parseTemplatePayload(file, false);
      for (const f of parsed.fields) {
        if (f.type === "list" && !Array.isArray(parsed.values[f.name])) {
          parsed.values[f.name] = [];
        }
      }
      const id = newSlotId();
      const slot = {
        id,
        ...parsed,
        fileContent: "",
        fileLayout: [],
      };
      multiSlots.push(slot);
      addedSlots.push(slot);
      addedNames.push(parsed.filename);
    }
    persistActiveSlot();
    showBanner(
      addedNames.length === 1
        ? `เพิ่มเทมเพลต「${addedNames[0]}」แล้ว · รวม ${multiSlots.length} ไฟล์ — สลับแท็บด้านบนได้`
        : `เพิ่ม ${addedNames.length} เทมเพลตแล้ว · รวม ${multiSlots.length} ไฟล์ — สลับแท็บด้านบนได้`,
      "success",
    );
    renderForm();
    if (preferContent) {
      for (const slot of addedSlots) void hydrateTemplateContent(slot, { silent: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "เพิ่มเทมเพลตไม่สำเร็จ";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
  } finally {
    app.removeAttribute("aria-busy");
  }
}

/**
 * @param {File[]} files
 * @param {HTMLElement | null} errorEl
 */
async function parseMultipleTemplates(files, errorEl) {
  showBanner("");
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
  const docx = files.filter((f) => f.name.toLowerCase().endsWith(".docx"));
  if (!docx.length) {
    const msg = "เลือกไฟล์ .docx อย่างน้อย 1 ไฟล์";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }
  if (docx.length === 1) {
    await parseFile(docx[0], errorEl);
    return;
  }
  if (docx.length > 12) {
    const msg = "เลือกเทมเพลตได้ไม่เกิน 12 ไฟล์";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
    return;
  }

  app.setAttribute("aria-busy", "true");
  // Multi is new vs npm CLI (1 file). Parse fields in parallel first; layout only for active tab.
  showBanner(`กำลังอ่าน ${docx.length} เทมเพลต…`, "progress");
  try {
    const preferContent = state.showFullContent;
    const parsedList = await Promise.all(
      docx.map(async (file, index) => {
        const parsed = await parseTemplatePayload(file, false);
        for (const f of parsed.fields) {
          if (f.type === "list" && !Array.isArray(parsed.values[f.name])) {
            parsed.values[f.name] = [];
          }
        }
        return {
          id: newSlotId(),
          order: index,
          ...parsed,
          fileContent: "",
          fileLayout: [],
        };
      }),
    );
    parsedList.sort((a, b) => a.order - b.order);
    /** @type {typeof multiSlots} */
    const slots = parsedList.map(({ order: _order, ...slot }) => slot);
    resetFormState();
    state.showFullContent = preferContent;
    multiSlots = slots;
    contentHydratedIds.clear();
    applySlotToState(slots[0]);
    for (const f of state.fields) {
      if (f.type === "list") ensureListRows(f.name, f.itemFields);
    }
    persistActiveSlot();
    showBanner("");
    renderForm();
    app.removeAttribute("aria-busy");
    // Only the open tab — like npm CLI loading one preview, not N layouts at once.
    if (preferContent) void hydrateTemplateContent(slots[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "อ่านหลายเทมเพลตไม่สำเร็จ";
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = msg;
    } else showBanner(msg);
  } finally {
    app.removeAttribute("aria-busy");
  }
}

/**
 * AI maps source → docx-form-values JSON per template, then Import ลงหน้าจอ.
 * Does NOT create/fill .docx files.
 * @param {File[]} sourceFiles
 */
async function runBatchFromSource(sourceFiles) {
  if (!isMultiMode()) {
    await runSourceMap(sourceFiles);
    return;
  }
  if (!aiStatus.connected && !getClientAiKey()) {
    showBanner("ต้องใส่ Gemini API key ของคุณก่อน");
    await connectGoogleAi();
    if (!aiStatus.connected && !getClientAiKey()) return;
  }
  persistActiveSlot();
  const fd = new FormData();
  fd.append(
    "schemas",
    JSON.stringify(
      multiSlots.map((s) => ({
        id: s.id,
        filename: s.filename,
        fields: s.fields,
        // Build Export JSON only now (send-to-AI) — not at template load time.
        valuesJson: buildExportJsonNow(s, { blank: true }),
      })),
    ),
  );
  for (const f of sourceFiles) fd.append("files", f, f.name);
  const byokKey = getClientAiKey();
  const byokModel = getClientAiModel();
  if (byokKey) fd.append("geminiApiKey", byokKey);
  if (byokModel) fd.append("geminiModel", byokModel);

  const n = multiSlots.length;
  showBanner(
    `กำลังให้ AI สร้าง docx-form-values JSON สำหรับ ${n} เทมเพลต — จากนั้น Import ลงจอ`,
    "progress",
  );
  app.setAttribute("aria-busy", "true");
  const progressHints = [
    `กำลังดึงข้อความจากเอกสารต้นทาง…`,
    `กำลังให้ AI สร้าง JSON รูปแบบเดียวกับ Export…`,
    `กำลัง Import JSON ลงแต่ละเทมเพลตบนหน้าจอ…`,
  ];
  let hintIdx = 0;
  const hintTimer = setInterval(() => {
    hintIdx = (hintIdx + 1) % progressHints.length;
    showBanner(progressHints[hintIdx], "progress");
  }, 4200);
  try {
    const res = await fetch("/api/batch-from-source", {
      method: "POST",
      body: fd,
      headers: aiAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = data.error || "แมป JSON ไม่สำเร็จ";
      if (
        Array.isArray(data.results) &&
        data.results.some((r) => r && !r.ok) &&
        !String(msg).includes(": ")
      ) {
        const detail = data.results
          .filter((r) => r && !r.ok)
          .map((r) => `${r.filename || "?"}: ${r.error || "ไม่สำเร็จ"}`)
          .slice(0, 3)
          .join(" · ");
        if (detail) msg = `${msg} — ${detail}`;
      }
      showBanner(msg);
      return;
    }

    let applied = 0;
    const failNames = [];
    const resumeId = multiActiveId;
    for (const r of data.results || []) {
      if (!r || !r.ok) {
        if (r?.filename) failNames.push(r.filename);
        continue;
      }
      const slot =
        (r.id && multiSlots.find((s) => s.id === r.id)) ||
        multiSlots.find((s) => s.filename === r.filename);
      if (!slot) continue;
      const payload =
        r.valuesJson && typeof r.valuesJson === "object"
          ? r.valuesJson
          : buildValuesExportPayloadFrom(slot, {
              values: r.values,
              skip: r.skip,
              rowSkip: r.rowSkip,
              images: {},
            });
      try {
        applySlotToState(slot);
        importValuesPayload(payload);
        persistActiveSlot();
        applied += 1;
      } catch (err) {
        console.warn(err);
        failNames.push(slot.filename || r.filename || "?");
      }
    }

    const active =
      multiSlots.find((s) => s.id === resumeId) ||
      multiSlots.find((s) => s.id === multiActiveId) ||
      multiSlots[0];
    if (active) {
      applySlotToState(active);
      for (const f of state.fields) {
        if (f.type === "list") ensureListRows(f.name, f.itemFields);
      }
    }
    persistActiveSlot();
    scheduleSaveDraft();
    renderForm();

    const failMsg = failNames.length
      ? ` · ไม่สำเร็จ ${failNames.length}: ${failNames.slice(0, 3).join(", ")}`
      : "";
    showBanner(
      `Import JSON จาก AI ลงหน้าจอแล้ว ${applied}/${n} เทมเพลต — ตรวจทานแล้วค่อยกดสร้างเอกสาร${failMsg}`,
      "success",
    );
    setTimeout(() => showBanner(""), 4200);
  } catch {
    showBanner("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  } finally {
    clearInterval(hintTimer);
    app.removeAttribute("aria-busy");
  }
}

/** Fields covered by inline document preview (text + lists). Images stay in sidebar form. */
function fieldsOutsidePreview() {
  if (!state.showFullContent) return state.fields;
  if (!state.fileLayout.length && !state.fileContent) return state.fields;
  return state.fields.filter((f) => f.type === "image");
}

function renderForm() {
  removeTaggerDialogPortals();
  const useDocLayout =
    state.showFullContent && (state.fileLayout.length > 0 || !!state.fileContent);
  const fieldsHtml = fieldsOutsidePreview()
    .map((f) => renderField(f))
    .join("");
  const bodyHtml = state.fileLayout.length
    ? renderDocumentFromLayout(state.fileLayout)
    : renderDocumentLayout(state.fileContent);
  const contentPanel = useDocLayout
    ? `
    <div class="doc-sheet" id="docPreview">
      <div class="doc-sheet-label">ตัวอย่างเนื้อหาในไฟล์ (กรอกในช่องว่างได้)</div>
      <div class="doc-body">${bodyHtml}</div>
    </div>`
    : state.showFullContent
      ? `<p class="dropzone-hint">เลือกแสดงเนื้อหาแล้ว แต่ไม่พบข้อความในไฟล์</p>`
      : "";

  const extraFields =
    fieldsHtml &&
    `<div class="extra-fields">
      ${useDocLayout ? `<h2 class="extra-fields-title">ฟิลด์เพิ่มเติม (รูปภาพ)</h2>` : ""}
      ${fieldsHtml}
    </div>`;

  app.innerHTML = `
    ${renderMultiTabs()}
    <div class="file-chip">
      <span class="file-meta">${escapeHtml(summaryText(state.fields))}${isMultiMode() ? " · แนบต้นทาง → AI คืน JSON → ใส่ลงหน้าจอ" : ""}</span>
      <div class="file-chip-actions">
        <button type="button" class="btn-secondary btn-compact ${aiStatus.connected ? "is-ai-on" : ""}" id="googleAiBtn" title="${aiStatus.connected ? `คีย์ของคุณ · ${aiStatus.model || ""} — เปลี่ยนโมเดล / ลบคีย์` : "ใส่ Gemini API key ของคุณ (เก็บในเบราว์เซอร์ ไม่ใช่คีย์ของแอป)"}">
          ${aiStatus.connected ? `AI · ${escapeHtml(String(aiStatus.model || "Gemini").replace(/^gemini-/i, ""))}` : "ใส่ Gemini key"}
        </button>
        <button type="button" class="btn-secondary btn-compact" id="attachSource" ${aiStatus.connected ? "" : "disabled"} title="${aiStatus.connected ? (isMultiMode() ? "แนบต้นทาง ให้ AI แมปเป็น JSON ต่อเทมเพลต แล้วใส่ลงหน้าจอ (ยังไม่สร้าง Word)" : "แนบ PDF / Word / รูป แล้วแมปด้วย Gemini") : "ต้องใส่ Gemini key ของคุณก่อน"}">${isMultiMode() ? "ต้นทาง → แมป JSON" : "แนบเอกสารต้นทาง"}</button>
        <input class="sr-only" type="file" id="attachSourceInput" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" multiple />
        <button type="button" class="btn-secondary btn-compact" id="exportJson" title="ส่งออกค่าที่กรอกเป็น JSON">Export JSON</button>
        <button type="button" class="btn-secondary btn-compact" id="importJson" title="นำเข้าค่าจากไฟล์ JSON">Import JSON</button>
        <input class="sr-only" type="file" id="importJsonInput" accept="application/json,.json" />
        <input class="sr-only" type="file" id="addTemplateInput" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple />
        <button type="button" class="linkish" id="goHomeBtn" title="กลับไปหน้าอัปโหลดเทมเพลต">← หน้าหลัก</button>
      </div>
    </div>
    ${renderSourceMapPanel()}
    <form id="fillForm">
      ${contentPanel}
      ${useDocLayout ? extraFields || "" : fieldsHtml}
      <div class="sticky-bar">
        <button type="submit" class="btn-primary" id="submitBtn">${isMultiMode() ? "สร้างเอกสาร…" : "สร้างเอกสาร"}</button>
        <div class="sticky-bar-drafts">
          <button type="button" class="btn-secondary sticky-draft-btn" id="saveNamedDraftBtn">บันทึกดราฟ</button>
          <button type="button" class="btn-secondary sticky-draft-btn" id="loadNamedDraftBtn">โหลดดราฟ</button>
        </div>
        <p class="dropzone-hint" style="margin:0.5rem 0 0;text-align:center">
          จะดาวน์โหลดไฟล์ใหม่ โดยไม่แก้ไฟล์ต้นฉบับ · ช่องว่างต้องติ๊ก “ข้าม” · Export/Import JSON ได้ด้านบน · บันทึกดราฟเพื่อกลับมาทำต่อข้ามวัน${isMultiMode() ? " · หลายเทมเพลต: แนบต้นทางเพื่อแมป JSON ลงจอ แล้วกดสร้างเลือกไฟล์เดียวหรือทั้งหมด" : ""}
        </p>
      </div>
    </form>
  `;

  document.getElementById("saveNamedDraftBtn")?.addEventListener("click", () => {
    void promptSaveNamedDraft();
  });
  document.getElementById("loadNamedDraftBtn")?.addEventListener("click", () => {
    void openNamedDraftPicker();
  });

  document.getElementById("goHomeBtn")?.addEventListener("click", async () => {
    if (!(await askGoHome())) return;
    resetFormState();
    void draftClear();
    showBanner("");
    renderEmpty();
  });

  const addTemplateInput = /** @type {HTMLInputElement | null} */ (
    document.getElementById("addTemplateInput")
  );
  const openAddTemplates = () => {
    if (multiSlots.length >= 12) {
      showBanner("เลือกเทมเพลตได้ไม่เกิน 12 ไฟล์");
      return;
    }
    addTemplateInput?.click();
  };
  document.getElementById("addTemplateTabBtn")?.addEventListener("click", openAddTemplates);
  addTemplateInput?.addEventListener("change", () => {
    const list = addTemplateInput.files ? [...addTemplateInput.files] : [];
    addTemplateInput.value = "";
    if (list.length) void appendTemplateFiles(list);
  });

  document.getElementById("exportJson")?.addEventListener("click", () => {
    void exportValuesJson();
  });
  const importInput = /** @type {HTMLInputElement | null} */ (document.getElementById("importJsonInput"));
  document.getElementById("importJson")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (file) void importValuesJson(file);
  });

  document.getElementById("googleAiBtn")?.addEventListener("click", () => {
    void connectGoogleAi();
  });
  const attachInput = /** @type {HTMLInputElement | null} */ (document.getElementById("attachSourceInput"));
  document.getElementById("attachSource")?.addEventListener("click", () => {
    if (!aiStatus.connected && !getClientAiKey()) {
      showBanner("ต้องใส่ Gemini API key ของคุณก่อนถึงจะแนบเอกสารได้");
      void connectGoogleAi();
      return;
    }
    attachInput?.click();
  });
  attachInput?.addEventListener("change", () => {
    const list = attachInput.files ? [...attachInput.files] : [];
    attachInput.value = "";
    if (!list.length) return;
    if (isMultiMode()) void runBatchFromSource(list);
    else void runSourceMap(list);
  });
  wireSourceMapPanelEvents();

  document.querySelectorAll("[data-multi-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-multi-id");
      if (!id || id === multiActiveId) return;
      persistActiveSlot();
      const slot = multiSlots.find((s) => s.id === id);
      if (!slot) return;
      applySlotToState(slot);
      for (const f of state.fields) {
        if (f.type === "list") ensureListRows(f.name, f.itemFields);
      }
      renderForm();
      if (state.showFullContent) void hydrateTemplateContent(slot);
    });
  });

  document.querySelectorAll("[data-multi-close]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.getAttribute("data-multi-close");
      if (id) void removeMultiSlot(id);
    });
  });

  wireFieldEvents();
  wireDocumentPreviewEvents();
  document.getElementById("fillForm")?.addEventListener("submit", onSubmit);
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64) {
  const binary = atob(String(b64 || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function valuesJsonBasename() {
  const base = String(state.filename || "template").replace(/\.docx$/i, "");
  return `${base}-values.json`;
}

/**
 * Build docx-form-values envelope (same as Export JSON).
 * @param {{
 *   filename?: string,
 *   fields: any[],
 *   values?: Record<string, any>,
 *   skip?: Record<string, boolean>,
 *   rowSkip?: Record<string, Record<string, boolean>[]>,
 * }} snap
 * @param {{
 *   values?: Record<string, any>,
 *   skip?: Record<string, boolean>,
 *   rowSkip?: Record<string, Record<string, boolean>[]>,
 *   images?: Record<string, any>,
 * }} [overrides]
 */
function buildValuesExportPayloadFrom(snap, overrides = {}) {
  return {
    format: "docx-form-values",
    version: 1,
    exportedAt: new Date().toISOString(),
    template: snap.filename || "",
    fields: (snap.fields || []).map((f) => ({ name: f.name, type: f.type })),
    values: overrides.values != null ? overrides.values : snap.values || {},
    skip: overrides.skip != null ? overrides.skip : snap.skip || {},
    rowSkip: overrides.rowSkip != null ? overrides.rowSkip : snap.rowSkip || {},
    images: overrides.images != null ? overrides.images : {},
  };
}

/**
 * Build Export JSON only when needed (Export click / right before AI send).
 * Never call this while loading .docx templates.
 * @param {{
 *   filename?: string,
 *   fields: any[],
 *   values?: Record<string, any>,
 *   skip?: Record<string, boolean>,
 *   rowSkip?: Record<string, Record<string, boolean>[]>,
 *   images?: Record<string, File | null>,
 * }} snap
 * @param {{ blank?: boolean }} [opts] blank=true → empty skeleton for AI to fill
 */
function buildExportJsonNow(snap, opts = {}) {
  if (opts.blank) {
    /** @type {Record<string, any>} */
    const values = {};
    /** @type {Record<string, boolean>} */
    const skip = {};
    /** @type {Record<string, Record<string, boolean>[]>} */
    const rowSkip = {};
    for (const f of snap.fields || []) {
      if (f.type === "auto") continue;
      if (f.type === "image") {
        skip[f.name] = true;
        continue;
      }
      if (f.type === "bool") {
        values[f.name] = false;
        skip[f.name] = false;
        continue;
      }
      if (f.type === "list") {
        values[f.name] = [];
        skip[f.name] = true;
        rowSkip[f.name] = [];
        continue;
      }
      values[f.name] = "";
      skip[f.name] = true;
    }
    return buildValuesExportPayloadFrom(snap, {
      values,
      skip,
      rowSkip,
      images: {},
    });
  }
  return buildValuesExportPayloadFrom(snap, {
    values: snap.values || {},
    skip: snap.skip || {},
    rowSkip: snap.rowSkip || {},
    images: {},
  });
}

async function buildValuesExportPayload() {
  // Only called from Export JSON click — not on file load.
  /** @type {Record<string, any>} */
  const images = {};
  for (const [name, file] of Object.entries(state.images)) {
    if (!file) {
      images[name] = null;
      continue;
    }
    const buffer = await file.arrayBuffer();
    images[name] = {
      name: file.name,
      type: file.type || "application/octet-stream",
      base64: bufferToBase64(buffer),
    };
  }
  const base = buildExportJsonNow(state, { blank: false });
  return { ...base, images };
}

async function exportValuesJson() {
  if (!state.file) {
    showBanner("ยังไม่มีเทมเพลต — อัปโหลดไฟล์ก่อน");
    return;
  }
  try {
    const payload = await buildValuesExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = valuesJsonBasename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showBanner(`ส่งออก ${valuesJsonBasename()} แล้ว`, "success");
    setTimeout(() => showBanner(""), 2200);
  } catch (err) {
    console.warn(err);
    showBanner("ส่งออก JSON ไม่สำเร็จ");
  }
}

/**
 * Same apply path as Import JSON (expects docx-form-values).
 * @param {any} data
 * @param {{ treatMissingImagesAsSkip?: boolean }} [opts]
 */
function importValuesPayload(data, opts = {}) {
  if (!data || typeof data !== "object") {
    throw new Error("invalid values json");
  }
  if (data.format && data.format !== "docx-form-values") {
    throw new Error("not docx-form-values");
  }
  applyValuesWithEmptySkip(data, {
    treatMissingImagesAsSkip: opts.treatMissingImagesAsSkip !== false,
  });
}

/**
 * Apply values / skip / rowSkip / images into form state.
 * Missing keys or blank strings → force ข้าม (same rules as Import JSON).
 * @param {{
 *   values?: Record<string, any>,
 *   skip?: Record<string, boolean>,
 *   rowSkip?: Record<string, Record<string, boolean>[]>,
 *   images?: Record<string, any>,
 * }} data
 * @param {{ treatMissingImagesAsSkip?: boolean }} [opts]
 */
function applyValuesWithEmptySkip(data, opts = {}) {
  const treatMissingImagesAsSkip = opts.treatMissingImagesAsSkip !== false;
  const known = new Set(state.fields.map((f) => f.name));
  const importedValues =
    data.values && typeof data.values === "object" ? data.values : {};
  const importedImages =
    data.images && typeof data.images === "object" ? data.images : {};
  const importedSkip =
    data.skip && typeof data.skip === "object" ? data.skip : {};
  const importedRowSkip =
    data.rowSkip && typeof data.rowSkip === "object" ? data.rowSkip : {};

  for (const [name, val] of Object.entries(importedValues)) {
    if (!known.has(name)) continue;
    const field = state.fields.find((f) => f.name === name);
    if (field?.type === "bool") {
      state.values[name] = coerceBoolValue(val);
      continue;
    }
    if (field?.type === "list" && Array.isArray(val)) {
      state.values[name] = val.map((row) => {
        if (!row || typeof row !== "object") return row;
        const next = { ...row };
        for (const item of field.itemFields) {
          if (item.type === "bool" && Object.prototype.hasOwnProperty.call(next, item.name)) {
            next[item.name] = coerceBoolValue(next[item.name]);
          }
        }
        return next;
      });
      continue;
    }
    state.values[name] = val;
  }

  for (const [name, img] of Object.entries(importedImages)) {
    const field = state.fields.find((f) => f.name === name && f.type === "image");
    if (!field) continue;
    if (!img || !img.base64) {
      state.images[name] = null;
      continue;
    }
    const bytes = base64ToUint8Array(img.base64);
    state.images[name] = new File([bytes], img.name || `${name}.png`, {
      type: img.type || "application/octet-stream",
    });
  }

  for (const f of state.fields) {
    if (f.type === "list") ensureListRows(f.name, f.itemFields);
  }

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  /** Empty / missing fill → should tick ข้าม (bool false is a real value). */
  const isBlankFill = (val, type) => {
    if (type === "bool" || type === "auto") return false;
    if (val == null) return true;
    if (typeof val === "string" && !val.trim()) return true;
    return false;
  };

  for (const [name, val] of Object.entries(importedSkip)) {
    if (!known.has(name)) continue;
    state.skip[name] = !!val;
  }
  for (const [name, rows] of Object.entries(importedRowSkip)) {
    if (!known.has(name) || !Array.isArray(rows)) continue;
    const listField = state.fields.find((f) => f.type === "list" && f.name === name);
    ensureRowSkip(
      name,
      Math.max(rows.length, state.values[name]?.length || 0),
      listField?.itemFields || [],
    );
    rows.forEach((row, idx) => {
      if (!row || typeof row !== "object") return;
      if (!state.rowSkip[name][idx]) state.rowSkip[name][idx] = {};
      for (const [item, skipped] of Object.entries(row)) {
        state.rowSkip[name][idx][item] = !!skipped;
      }
    });
  }

  for (const f of state.fields) {
    if (f.type === "auto") continue;

    if (f.type === "image") {
      if (!treatMissingImagesAsSkip) continue;
      const provided = hasOwn(importedImages, f.name) && !!importedImages[f.name]?.base64;
      if (!provided) {
        state.skip[f.name] = true;
        state.images[f.name] = null;
      }
      continue;
    }

    if (f.type === "list") {
      const rows = hasOwn(importedValues, f.name) ? importedValues[f.name] : null;
      if (!Array.isArray(rows) || rows.length === 0) {
        state.skip[f.name] = true;
        continue;
      }
      ensureListRows(f.name, f.itemFields);
      // Grow list to imported row count
      while (state.values[f.name].length < rows.length) {
        state.values[f.name].push({});
      }
      ensureListRows(f.name, f.itemFields);
      ensureRowSkip(f.name, state.values[f.name].length, f.itemFields);
      state.values[f.name].forEach((row, idx) => {
        const srcRow =
          Array.isArray(rows) && rows[idx] && typeof rows[idx] === "object" ? rows[idx] : null;
        for (const item of f.itemFields) {
          if (item.type === "auto") continue;
          if (srcRow && hasOwn(srcRow, item.name)) {
            row[item.name] =
              item.type === "bool" ? coerceBoolValue(srcRow[item.name]) : srcRow[item.name];
          }
          if (item.type === "bool") {
            if (srcRow && hasOwn(srcRow, item.name)) {
              state.rowSkip[f.name][idx][item.name] = false;
            } else if (!hasOwn(state.rowSkip[f.name][idx], item.name)) {
              // Unmapped list bool stays editable
              state.rowSkip[f.name][idx][item.name] = false;
              row[item.name] = false;
            }
            continue;
          }
          const missing = !srcRow || !hasOwn(srcRow, item.name);
          const blank = !missing && isBlankFill(srcRow[item.name], item.type);
          if (missing || blank) {
            state.rowSkip[f.name][idx][item.name] = true;
            state.values[f.name][idx][item.name] = "";
          }
        }
      });
      continue;
    }

    if (f.type === "bool") {
      if (hasOwn(importedValues, f.name)) {
        state.values[f.name] = coerceBoolValue(importedValues[f.name]);
        state.skip[f.name] = !!importedSkip[f.name];
      } else if (hasOwn(importedSkip, f.name)) {
        state.skip[f.name] = !!importedSkip[f.name];
        if (state.skip[f.name]) state.values[f.name] = false;
      } else {
        // Unmapped bool stays editable at false (not grayed-out skip)
        state.skip[f.name] = false;
        if (typeof state.values[f.name] !== "boolean") state.values[f.name] = false;
      }
      continue;
    }

    const missing = !hasOwn(importedValues, f.name);
    const blank = !missing && isBlankFill(importedValues[f.name], f.type);
    if (missing || blank) {
      state.skip[f.name] = true;
      state.values[f.name] = "";
    } else {
      state.skip[f.name] = !!importedSkip[f.name];
    }
  }
}

/**
 * @param {File} file
 */
async function importValuesJson(file) {
  if (!state.file) {
    showBanner("อัปโหลดเทมเพลต .docx ก่อน แล้วค่อย Import JSON");
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("invalid");
    if (data.format && data.format !== "docx-form-values") {
      showBanner("ไฟล์ JSON นี้ไม่ใช่รูปแบบ docx-form-values");
      return;
    }

    if (data.template && state.filename && data.template !== state.filename) {
      const go = await askDialog({
        title: "เทมเพลตไม่ตรงกัน",
        body: `JSON จากไฟล์ «${data.template}» แต่ตอนนี้เปิด «${state.filename}» — นำเข้าเฉพาะฟิลด์ที่ชื่อตรงกันหรือไม่?`,
        actions: [
          { id: "abort", label: "ยกเลิก", kind: "ghost" },
          { id: "ok", label: "นำเข้า", kind: "primary" },
        ],
      });
      if (go !== "ok") return;
    }

    importValuesPayload(data);
    sourceMapSession = null;
    persistActiveSlot();
    renderForm();
    scheduleSaveDraft();
    showBanner(`นำเข้าจาก ${file.name} แล้ว`, "success");
    setTimeout(() => showBanner(""), 2400);
  } catch (err) {
    console.warn(err);
    showBanner("อ่าน JSON ไม่ได้ — ตรวจว่าเป็นไฟล์ที่ Export จาก docx-form");
  }
}

function formatCandidateValue(val) {
  if (typeof val === "boolean") return val ? "true" : "false";
  return String(val ?? "");
}

function rebuildSourceMapDraft() {
  if (!sourceMapSession) return;
  const proposals = sourceMapSession.proposals || [];
  const byPath = new Map(proposals.map((p) => [p.path, p]));
  const values = {};
  const skip = {};
  const rowSkip = {};

  const pick = (path) => {
    const p = byPath.get(path);
    if (!p || p.preferSkip || p.selectedIndex < 0 || !p.candidates?.length) return null;
    return p.candidates[p.selectedIndex] || null;
  };

  for (const f of state.fields) {
    if (f.type === "auto" || f.type === "image") {
      if (f.type === "image") skip[f.name] = true;
      continue;
    }
    if (f.type === "list") {
      const prefix = `${f.name}.`;
      const rowIdxs = new Set();
      for (const p of proposals) {
        if (!p.path.startsWith(prefix)) continue;
        const m = /^(\d+)\./.exec(p.path.slice(prefix.length));
        if (m) rowIdxs.add(Number(m[1]));
      }
      const maxRow = rowIdxs.size ? Math.max(...rowIdxs) + 1 : 0;
      if (maxRow === 0) {
        skip[f.name] = true;
        values[f.name] = [];
        continue;
      }
      skip[f.name] = false;
      const rows = [];
      const rsArr = [];
      for (let i = 0; i < maxRow; i += 1) {
        const row = {};
        const rs = {};
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
        rsArr.push(rs);
      }
      values[f.name] = rows;
      rowSkip[f.name] = rsArr;
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

  sourceMapSession.values = values;
  sourceMapSession.skip = skip;
  sourceMapSession.rowSkip = rowSkip;
}

function formatSourceMapLogTime(isoOrMs) {
  try {
    const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
    return d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function appendSourceMapLog(message) {
  if (!sourceMapSession) return;
  if (!Array.isArray(sourceMapSession.logs)) sourceMapSession.logs = [];
  sourceMapSession.logs.push({ t: new Date().toISOString(), message: String(message || "") });
  if (sourceMapSession.logs.length > 200) sourceMapSession.logs.splice(0, sourceMapSession.logs.length - 200);
  patchSourceMapLoadingUi();
}

function patchSourceMapLoadingUi() {
  if (!sourceMapSession || sourceMapSession.status !== "loading") return;
  const statusEl = document.getElementById("sourceMapStatusText");
  if (statusEl) statusEl.textContent = sourceMapSession.statusText || "";
  const labelEl = document.getElementById("sourceMapProgressLabel");
  const barEl = document.getElementById("sourceMapProgressBar");
  const prog = sourceMapSession.progress;
  if (labelEl && prog) labelEl.textContent = prog.label || "";
  if (barEl && prog && prog.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((prog.step / prog.total) * 100)));
    barEl.style.width = `${pct}%`;
    barEl.setAttribute("aria-valuenow", String(pct));
  }
  const logEl = document.getElementById("sourceMapLog");
  if (logEl && Array.isArray(sourceMapSession.logs)) {
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
    logEl.innerHTML = sourceMapSession.logs
      .map(
        (l) =>
          `<div class="source-map-log-line"><time>${escapeHtml(formatSourceMapLogTime(l.t))}</time><span>${escapeHtml(l.message)}</span></div>`,
      )
      .join("");
    if (nearBottom || sourceMapSession.showLogs) logEl.scrollTop = logEl.scrollHeight;
  }
  const toggle = document.getElementById("toggleSourceMapLog");
  if (toggle) {
    toggle.setAttribute("aria-expanded", sourceMapSession.showLogs ? "true" : "false");
    toggle.textContent = sourceMapSession.showLogs ? "ซ่อนล็อก" : "ดูล็อก / ความคืบหน้า";
  }
  const logWrap = document.getElementById("sourceMapLogWrap");
  if (logWrap) logWrap.hidden = !sourceMapSession.showLogs;
}

function renderSourceMapPanel() {
  if (!sourceMapSession) return "";
  if (sourceMapSession.status === "loading") {
    const prog = sourceMapSession.progress || { step: 0, total: 1, label: "" };
    const pct =
      prog.total > 0 ? Math.max(0, Math.min(100, Math.round((prog.step / prog.total) * 100))) : 0;
    const logs = Array.isArray(sourceMapSession.logs) ? sourceMapSession.logs : [];
    const logHtml = logs
      .map(
        (l) =>
          `<div class="source-map-log-line"><time>${escapeHtml(formatSourceMapLogTime(l.t))}</time><span>${escapeHtml(l.message)}</span></div>`,
      )
      .join("");
    return `<div class="source-map-panel is-loading" id="sourceMapPanel">
      <div class="source-map-head">
        <strong>กำลังอ่านเอกสารต้นทาง…</strong>
        <span class="source-map-status" id="sourceMapStatusText">${escapeHtml(sourceMapSession.statusText || "OCR / แมปค่า")}</span>
      </div>
      <div class="source-map-progress" aria-hidden="false">
        <div class="source-map-progress-track">
          <div class="source-map-progress-bar" id="sourceMapProgressBar" style="width:${pct}%" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"></div>
        </div>
        <p class="source-map-progress-label" id="sourceMapProgressLabel">${escapeHtml(prog.label || "")}</p>
      </div>
      <p class="dropzone-hint" style="margin:0">รันบนเครื่องนี้ · ข้อความต้นทางอยู่บนเครื่อง · ส่งเฉพาะข้อความที่ดึงได้ไป Gemini</p>
      <div class="source-map-log-actions">
        <button type="button" class="btn-secondary btn-compact" id="toggleSourceMapLog" aria-expanded="${sourceMapSession.showLogs ? "true" : "false"}">${sourceMapSession.showLogs ? "ซ่อนล็อก" : "ดูล็อก / ความคืบหน้า"}</button>
      </div>
      <div class="source-map-log-wrap" id="sourceMapLogWrap" ${sourceMapSession.showLogs ? "" : "hidden"}>
        <div class="source-map-log" id="sourceMapLog" role="log" aria-live="polite">${logHtml}</div>
      </div>
    </div>`;
  }

  const proposals = sourceMapSession.proposals || [];
  const single = [];
  const multi = [];
  const missed = [];
  for (const p of proposals) {
    if (!p.candidates?.length) continue;
    const onlyMiss =
      p.preferSkip &&
      p.candidates.every((c) => c.rule === "gemini-miss");
    if (onlyMiss) {
      missed.push(p);
      continue;
    }
    if (p.candidates.length > 1) multi.push(p);
    else single.push(p);
  }

  const mappedTop = new Set();
  for (const p of proposals) {
    const top = p.path.split(".")[0];
    mappedTop.add(top);
    mappedTop.add(p.path);
  }
  const unmatched = [];
  for (const f of state.fields) {
    if (f.type === "auto" || f.type === "image") continue;
    if (f.type === "list") {
      const hasAny = proposals.some((p) => p.path === f.name || p.path.startsWith(`${f.name}.`));
      if (!hasAny) unmatched.push(f.name);
      continue;
    }
    if (!mappedTop.has(f.name)) unmatched.push(f.name);
  }

  const extractedHtml = (sourceMapSession.extracted || [])
    .map((e) => {
      const warn = e.warning
        ? `<span class="source-map-warn">${escapeHtml(e.warning)}</span>`
        : "";
      return `<li><code>${escapeHtml(e.filename)}</code> · ${escapeHtml(e.kind)} · ${e.charCount} ตัวอักษร ${warn}</li>`;
    })
    .join("");

  const candBlock = (p, highlight) => {
    const skipped = !!p.preferSkip;
    const options = (p.candidates || [])
      .map((c, idx) => {
        const id = `sm-${cssId(p.path)}-${idx}`;
        const checked = !skipped && p.selectedIndex === idx ? "checked" : "";
        return `<label class="source-map-opt" for="${id}">
          <input type="radio" name="sm-${escapeAttr(p.path)}" id="${id}" data-sm-path="${escapeAttr(p.path)}" data-sm-idx="${idx}" ${checked} />
          <span class="source-map-val">${escapeHtml(formatCandidateValue(c.value))}</span>
          <span class="source-map-meta">${escapeHtml(c.sourceFile)} · ${Math.round((c.confidence || 0) * 100)}% · ${escapeHtml(c.rule)}</span>
        </label>`;
      })
      .join("");
    const skipId = `sm-skip-${cssId(p.path)}`;
    return `<div class="source-map-field ${highlight ? "is-multi" : ""} ${skipped ? "is-skipped" : ""}" data-sm-field="${escapeAttr(p.path)}">
      <div class="source-map-path"><code>${escapeHtml(p.path)}</code></div>
      <div class="source-map-options">
        ${options}
        <label class="source-map-opt source-map-skip" for="${skipId}">
          <input type="radio" name="sm-${escapeAttr(p.path)}" id="${skipId}" data-sm-path="${escapeAttr(p.path)}" data-sm-idx="-1" ${skipped ? "checked" : ""} />
          <span class="source-map-val">ข้าม</span>
        </label>
      </div>
    </div>`;
  };

  return `<div class="source-map-panel" id="sourceMapPanel">
    <div class="source-map-head">
      <strong>ผลแมปจากเอกสารต้นทาง</strong>
        <span class="source-map-status">${escapeHtml(sourceMapSession.aiLabel || "Google Gemini")}</span>
    </div>
    ${extractedHtml ? `<ul class="source-map-extracted">${extractedHtml}</ul>` : ""}
    ${
      multi.length
        ? `<section class="source-map-group">
      <h3 class="source-map-group-title">มีหลายค่า — เลือกก่อนใส่ฟอร์ม</h3>
      ${multi.map((p) => candBlock(p, true)).join("")}
    </section>`
        : ""
    }
    ${
      single.length
        ? `<section class="source-map-group">
      <h3 class="source-map-group-title">จับได้ค่าเดียว</h3>
      ${single.map((p) => candBlock(p, false)).join("")}
    </section>`
        : ""
    }
    ${
      missed.length
        ? `<section class="source-map-group source-map-unmatched">
      <h3 class="source-map-group-title">ยังไม่พบในเอกสาร — ข้ามไว้ (ครบทุกตัวแปร)</h3>
      ${missed.map((p) => candBlock(p, false)).join("")}
    </section>`
        : ""
    }
    ${
      unmatched.length
        ? `<section class="source-map-group source-map-unmatched">
      <h3 class="source-map-group-title">จับไม่ได้ — จะข้ามตอนใส่ฟอร์ม</h3>
      <p class="source-map-unmatched-list">${unmatched.map((n) => `<code>${escapeHtml(n)}</code>`).join(" ")}</p>
    </section>`
        : ""
    }
    <div class="source-map-actions">
      <button type="button" class="btn-primary btn-compact" id="applySourceMap">ใส่ลงฟอร์ม</button>
      <button type="button" class="btn-ghost btn-compact" id="dismissSourceMap">ปิดแผงนี้</button>
    </div>
  </div>`;
}

function wireSourceMapPanelEvents() {
  const panel = document.getElementById("sourceMapPanel");
  if (!panel || !sourceMapSession) return;

  document.getElementById("toggleSourceMapLog")?.addEventListener("click", () => {
    if (!sourceMapSession || sourceMapSession.status !== "loading") return;
    sourceMapSession.showLogs = !sourceMapSession.showLogs;
    patchSourceMapLoadingUi();
  });

  panel.querySelectorAll("input[data-sm-path]").forEach((el) => {
    el.addEventListener("change", () => {
      const path = el.getAttribute("data-sm-path");
      const idx = Number(el.getAttribute("data-sm-idx"));
      const prop = sourceMapSession?.proposals?.find((p) => p.path === path);
      if (!prop) return;
      if (idx < 0) {
        prop.preferSkip = true;
        prop.selectedIndex = -1;
      } else {
        prop.preferSkip = false;
        prop.selectedIndex = idx;
      }
      rebuildSourceMapDraft();
      // Refresh highlight classes without full form re-render of doc preview
      const fieldEl = panel.querySelector(`[data-sm-field="${cssAttrSelector(path)}"]`);
      if (fieldEl) fieldEl.classList.toggle("is-skipped", !!prop.preferSkip);
    });
  });

  document.getElementById("applySourceMap")?.addEventListener("click", () => {
    if (!sourceMapSession) return;
    rebuildSourceMapDraft();
    try {
      importValuesPayload(
        buildValuesExportPayloadFrom(state, {
          values: sourceMapSession.values,
          skip: sourceMapSession.skip,
          rowSkip: sourceMapSession.rowSkip,
          images: {},
        }),
      );
    } catch (err) {
      console.warn(err);
      showBanner("นำเข้า JSON จากผลแมปไม่สำเร็จ");
      return;
    }
    sourceMapSession = null;
    persistActiveSlot();
    renderForm();
    scheduleSaveDraft();
    showBanner("Import JSON จากเอกสารต้นทางลงฟอร์มแล้ว", "success");
    setTimeout(() => showBanner(""), 2400);
  });

  document.getElementById("dismissSourceMap")?.addEventListener("click", () => {
    sourceMapSession = null;
    renderForm();
  });
}

/**
 * @param {File[]} files
 */
async function runSourceMap(files) {
  if (!state.file || !state.fields.length) {
    showBanner("อัปโหลดเทมเพลต .docx ก่อน แล้วค่อยแนบเอกสารต้นทาง");
    return;
  }
  if (!aiStatus.connected && !getClientAiKey()) {
    showBanner("ต้องใส่ Gemini API key ของคุณก่อนถึงจะแนบเอกสารได้");
    await connectGoogleAi();
    if (!aiStatus.connected && !getClientAiKey()) return;
  }
  sourceMapSession = {
    proposals: [],
    extracted: [],
    values: {},
    skip: {},
    rowSkip: {},
    status: "loading",
    statusText: `กำลังอัปโหลด ${files.length} ไฟล์…`,
    logs: [],
    showLogs: false,
    progress: { step: 0, total: files.length + 2, label: "อัปโหลดไฟล์ต้นทาง" },
    startedAt: Date.now(),
  };
  appendSourceMapLog(`เลือก ${files.length} ไฟล์: ${files.map((f) => f.name).join(", ")}`);
  renderForm();
  showBanner("");

  try {
    const form = new FormData();
    form.append("fields", JSON.stringify(state.fields));
    form.append("templateName", state.filename || "");
    // Build Export JSON only at send-to-AI time (same builder as Export button).
    form.append(
      "valuesJson",
      JSON.stringify(buildExportJsonNow(state, { blank: true })),
    );
    for (const f of files) form.append("files", f, f.name);

    appendSourceMapLog("ส่งคำขอไปเซิร์ฟเวอร์ localhost…");
    const res = await fetch("/api/source-map?stream=1", {
      method: "POST",
      body: form,
      headers: aiAuthHeaders({ Accept: "application/x-ndjson" }),
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok && !contentType.includes("ndjson")) {
      const data = await res.json().catch(() => ({}));
      sourceMapSession = null;
      renderForm();
      showBanner(data.error || "แมปเอกสารต้นทางไม่สำเร็จ — ไม่ทราบสาเหตุ");
      return;
    }

    if (!res.body || !contentType.includes("ndjson")) {
      // Fallback: non-stream JSON
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        sourceMapSession = null;
        renderForm();
        showBanner(data.error || "แมปเอกสารต้นทางไม่สำเร็จ — ไม่ทราบสาเหตุ");
        return;
      }
      finishSourceMapResult(data);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    /** @type {null | Record<string, any>} */
    let finalResult = null;
    /** @type {string | null} */
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          appendSourceMapLog(`(อ่านบรรทัดล็อกไม่ได้) ${trimmed.slice(0, 120)}`);
          continue;
        }
        if (evt.type === "log" && evt.message) {
          appendSourceMapLog(evt.message);
          if (sourceMapSession) sourceMapSession.statusText = evt.message;
          patchSourceMapLoadingUi();
        } else if (evt.type === "progress") {
          if (sourceMapSession) {
            sourceMapSession.progress = {
              step: Number(evt.step) || 0,
              total: Number(evt.total) || 1,
              label: String(evt.label || ""),
            };
            if (evt.label) sourceMapSession.statusText = evt.label;
          }
          patchSourceMapLoadingUi();
        } else if (evt.type === "result") {
          finalResult = evt;
          appendSourceMapLog(evt.message || "แมปเสร็จ");
        } else if (evt.type === "error") {
          const reason = evt.error || evt.message || "ไม่ทราบสาเหตุ";
          streamError = String(reason).startsWith("แมปเอกสารต้นทางไม่สำเร็จ")
            ? String(reason)
            : `แมปเอกสารต้นทางไม่สำเร็จ — ${reason}`;
          appendSourceMapLog(`ข้อผิดพลาด: ${streamError}`);
        }
      }
    }

    if (streamError) {
      sourceMapSession = null;
      renderForm();
      showBanner(streamError);
      return;
    }
    if (!finalResult) {
      sourceMapSession = null;
      renderForm();
      showBanner("แมปเอกสารต้นทางไม่สำเร็จ — ไม่ได้รับผลลัพธ์จากเซิร์ฟเวอร์");
      return;
    }
    finishSourceMapResult(finalResult);
  } catch (err) {
    console.warn(err);
    sourceMapSession = null;
    renderForm();
    showBanner("แมปเอกสารต้นทางไม่สำเร็จ — เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  }
}

function finishSourceMapResult(data) {
  // Prefer AI-filled Export JSON → same Import path as the Import JSON button.
  const payload =
    data.valuesJson && typeof data.valuesJson === "object"
      ? data.valuesJson
      : buildValuesExportPayloadFrom(state, {
          values: data.values && typeof data.values === "object" ? data.values : {},
          skip: data.skip && typeof data.skip === "object" ? data.skip : {},
          rowSkip:
            data.rowSkip && typeof data.rowSkip === "object" ? data.rowSkip : {},
          images: {},
        });
  try {
    importValuesPayload(payload);
    sourceMapSession = null;
    persistActiveSlot();
    renderForm();
    scheduleSaveDraft();
    showBanner("Import JSON จาก AI ลงฟอร์มแล้ว — ตรวจทานแล้วค่อยสร้างเอกสาร", "success");
    setTimeout(() => showBanner(""), 3600);
  } catch (err) {
    console.warn(err);
    sourceMapSession = null;
    renderForm();
    showBanner("นำเข้า JSON จาก AI ไม่สำเร็จ");
  }
}

/** Render structured layout from Word (real tables + paragraph text). */
function renderDocumentFromLayout(blocks) {
  if (!blocks?.length) return `<p class="dropzone-hint">ไม่มีข้อความในไฟล์</p>`;
  return blocks
    .map((b) => {
      if (b.type === "text") return renderDocumentLayout(b.text || "");
      if (b.type === "table") return renderWordTableBlock(b);
      return "";
    })
    .join("");
}

function cellTextOf(cell) {
  return typeof cell === "string" ? cell : cell?.text || "";
}

function tableViewKey(block) {
  if (block.listName) return `list:${block.listName}`;
  const sig = (block.colWidths || []).join("x");
  if (sig) return `tbl:${sig}`;
  const n =
    block.templateCells?.length ||
    block.staticRows?.[0]?.length ||
    block.headerRows?.[0]?.reduce((s, c) => s + (c.colspan || 1), 0) ||
    0;
  return `tbl:cols${n}`;
}

function countTableDataCols(block) {
  if (block.colWidths?.length) return block.colWidths.length;
  if (block.templateCells?.length) return block.templateCells.length;
  if (block.staticRows?.[0]?.length) {
    return block.staticRows[0].reduce((s, c) => s + (typeof c === "object" && c.colspan ? c.colspan : 1), 0);
  }
  if (block.headerRows?.[0]?.length) {
    return block.headerRows[0].reduce((s, c) => s + (c.colspan || 1), 0);
  }
  return 0;
}

function layoutCellAttrs(cell, opts = {}) {
  if (typeof cell === "string") return { text: cell, attrs: "" };
  const parts = [];
  const classes = [];
  if (opts.extraClass) classes.push(opts.extraClass);
  if (cell.align) classes.push(`align-${cell.align}`);
  if (classes.length) parts.push(`class="${classes.join(" ")}"`);
  if (cell.colspan && cell.colspan > 1) parts.push(`colspan="${cell.colspan}"`);
  if (cell.rowspan && cell.rowspan > 1) parts.push(`rowspan="${cell.rowspan}"`);
  const styles = [];
  if (cell.widthDxa && cell.widthDxa > 0) {
    // dxa (twips) → px ≈ /15; allow grow past Word width for long input
    const px = Math.max(48, Math.round(cell.widthDxa / 15));
    styles.push(`min-width:${px}px`);
  }
  if (styles.length) parts.push(`style="${styles.join(";")}"`);
  return { text: cell.text || "", attrs: parts.length ? ` ${parts.join(" ")}` : "" };
}

function renderLayoutCellTag(tag, cell, extraClass) {
  // Word headers without explicit w:jc often read centered in narrow columns
  const normalized =
    tag === "th" && typeof cell === "object" && cell && !cell.align
      ? { ...cell, align: "center" }
      : cell;
  const { text, attrs } = layoutCellAttrs(normalized, { extraClass });
  return `<${tag}${attrs}>${formatPlainText(text)}</${tag}>`;
}

function renderColgroup(block, withRowNum) {
  const count = countTableDataCols(block);
  if (!count) return "";
  const key = tableViewKey(block);
  const saved = viewTableColWidths.get(key);
  const wordWidths = block.colWidths || [];
  const cols = [];
  if (withRowNum) {
    const w = saved?.[0];
    cols.push(
      w
        ? `<col class="doc-table-rownum-col" style="width:${w}px;min-width:${w}px" />`
        : `<col class="doc-table-rownum-col" />`,
    );
  }
  for (let i = 0; i < count; i++) {
    const savedIdx = withRowNum ? i + 1 : i;
    const savedW = saved?.[savedIdx];
    const fromWord = wordWidths[i] ? Math.max(48, Math.round(Number(wordWidths[i]) / 15)) : 96;
    const px = savedW || fromWord;
    cols.push(`<col style="width:${px}px;min-width:${px}px" />`);
  }
  return `<colgroup data-view-key="${escapeAttr(key)}">${cols.join("")}</colgroup>`;
}

function renderWordTableBlock(block) {
  if (block.staticRows?.length) {
    const rows = block.staticRows
      .map((r) => `<tr>${r.map((c) => renderLayoutCellTag("td", c)).join("")}</tr>`)
      .join("");
    return `<div class="doc-table-scroll doc-table-real"><table class="doc-table doc-table-stretch">${renderColgroup(block, false)}${rows}</table></div>`;
  }

  const listName = block.listName || "";
  const field = state.fields.find((f) => f.type === "list" && f.name === listName);
  const renderHeaderRows = (withRowNum) =>
    (block.headerRows || [])
      .map((r, ri) => {
        // Row number column only on first header row; rowspan covers the rest
        const headerRows = block.headerRows || [];
        let num = "";
        if (withRowNum && ri === 0) {
          const span = Math.max(headerRows.length, 1);
          num = `<th class="doc-table-rownum"${span > 1 ? ` rowspan="${span}"` : ""}>#</th>`;
        }
        return `<tr>${num}${r.map((c) => renderLayoutCellTag("th", c)).join("")}</tr>`;
      })
      .join("");

  if (!field || field.type !== "list") {
    const tmpl = (block.templateCells || [])
      .map((c) => {
        const { attrs } = layoutCellAttrs(typeof c === "string" ? { text: c } : c);
        return `<td${attrs}>${formatPlainText(cellTextOf(c))}</td>`;
      })
      .join("");
    return `<div class="doc-list doc-list-table" data-list-field="${escapeAttr(listName)}">
      <div class="doc-table-scroll doc-table-real">
        <table class="doc-table doc-table-stretch">
          ${renderColgroup(block, false)}
          <thead>${renderHeaderRows(false)}</thead>
          <tbody><tr>${tmpl}</tr></tbody>
        </table>
      </div>
    </div>`;
  }

  const skipped = !!state.skip[listName];
  ensureListRows(listName, field.itemFields);
  if (skipped) {
    return `<div class="doc-list is-skipped" data-list-field="${escapeAttr(listName)}">
      <div class="doc-list-toolbar">
        <span class="doc-list-name">${escapeHtml(listName)} <span class="badge">ตาราง</span></span>
        <label class="doc-skip">
          <input type="checkbox" data-skip-field="${escapeAttr(listName)}" checked />
          ข้าม
        </label>
      </div>
      <p class="row-empty">ไม่แสดงแถวในเอกสาร</p>
    </div>`;
  }

  const rows = /** @type {Record<string, any>[]} */ (state.values[listName] || []);
  const bodyRows = rows
    .map((row, idx) => {
      const cells = (block.templateCells || [])
        .map((cell) => {
          const cellObj = typeof cell === "string" ? { text: cell } : cell;
          const { attrs } = layoutCellAttrs(cellObj);
          return `<td${attrs}>${renderTableTemplateCell(listName, field, row, idx, cellTextOf(cellObj))}</td>`;
        })
        .join("");
      return `<tr>
        <td class="doc-table-rownum">
          <span>${idx + 1}</span>
          <button type="button" class="linkish danger remove-row" data-list="${escapeAttr(listName)}" data-row="${idx}" title="ลบแถว">ลบ</button>
        </td>
        ${cells}
      </tr>`;
    })
    .join("");

  const colCount = (block.templateCells || []).length + 1;
  return `<div class="doc-list doc-list-table" data-list-field="${escapeAttr(listName)}">
    <div class="doc-list-toolbar">
      <span class="doc-list-name">${escapeHtml(listName)} <span class="badge">ตารางจากไฟล์</span></span>
      <label class="doc-skip">
        <input type="checkbox" data-skip-field="${escapeAttr(listName)}" />
        ข้าม
      </label>
      <button type="button" class="btn-secondary add-row" data-list="${escapeAttr(listName)}">+ เพิ่มแถว</button>
    </div>
    <div class="doc-table-scroll doc-table-real">
      <table class="doc-table doc-table-stretch">
        ${renderColgroup(block, true)}
        <thead>
          ${renderHeaderRows(true) || `<tr><th class="doc-table-rownum">#</th>${(block.templateCells || []).map(() => "<th></th>").join("")}</tr>`}
        </thead>
        <tbody>
          ${bodyRows || `<tr><td colspan="${colCount}" class="row-empty">ยังไม่มีแถว</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderTableTemplateCell(listName, field, row, idx, cellText) {
  const tokens = tokenizeTemplate(cellText || "");
  if (!tokens.length) return "";
  return tokens
    .map((t) => {
      if (t.type === "text") {
        const v = String(t.value || "").trim();
        return v ? formatPlainText(v) : "";
      }
      if (t.type === "self") {
        const item = t.name || "";
        const itemField = field.itemFields.find((x) => x.name === item);
        return renderListCellControl(listName, row, idx, item, itemField);
      }
      return "";
    })
    .join("");
}

/**
 * Turn template text (with {{tags}}) into Word-like HTML:
 * plain text stays text; variables become blank inputs.
 */
function renderDocumentLayout(content) {
  const tokens = tokenizeTemplate(content);
  let html = "";
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "text") {
      html += formatPlainText(tok.value);
      i += 1;
      continue;
    }
    if (tok.type === "open") {
      const listName = tok.name;
      let depth = 1;
      let j = i + 1;
      const inner = [];
      while (j < tokens.length && depth > 0) {
        if (tokens[j].type === "open") depth += 1;
        else if (tokens[j].type === "close") depth -= 1;
        if (depth > 0) inner.push(tokens[j]);
        j += 1;
      }
      html += renderListBlock(listName, inner);
      i = j;
      continue;
    }
    if (tok.type === "close") {
      // stray close — skip
      i += 1;
      continue;
    }
    // self tag
    html += renderInlineBlank(tok.name);
    i += 1;
  }
  return html || `<p class="dropzone-hint">ไม่มีข้อความในไฟล์</p>`;
}

function tokenizeTemplate(content) {
  const re = /\{\{(\/?#?[^}]*)\}\}/g;
  /** @type {{ type: string, value?: string, name?: string }[]} */
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(content)) !== null) {
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
  if (last < content.length) {
    tokens.push({ type: "text", value: content.slice(last) });
  }
  return tokens;
}

function formatPlainText(text) {
  // Keep \\t as a real tab character so CSS tab-size matches Word <w:tab/> spacing
  // and selection plain still aligns with originalPlainText.
  return escapeHtml(text)
    .replace(/\n/g, "<br>")
    .replace(/ {2}/g, " &nbsp;");
}

/** Coerce imported / Gemini values into a real boolean. */
function coerceBoolValue(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  const s = String(val ?? "")
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (/^(false|0|no|off|ไม่|ไม่ใช่|ไม่มี|ไม่พบ|x|×)$/i.test(s)) return false;
  if (/^(true|1|yes|on|ใช่|มี|พบ|√|✓)$/i.test(s)) return true;
  // Non-empty unknown string — treat as checked (legacy imports)
  return true;
}

/** Compact bool control: pair √|x when both set; single chip when false side is empty. */
function renderDocBoolControl({
  checked,
  skipped,
  trueText,
  falseText,
  label,
  inputAttrs,
  skipAttrs,
}) {
  const tip = `${label || ""} — ติ๊ก → "${trueText}" · ไม่ติ๊ก → "${falseText || "(ว่าง)"}"`;
  const nameText = String(label || "").trim() || "ตัวเลือก";
  const t = String(trueText ?? "");
  const f = String(falseText ?? "");
  const showPair = t !== "" && f !== "";

  let chipsHtml;
  if (showPair) {
    chipsHtml = `<span class="bool-pair" aria-hidden="true" role="presentation">
        <span class="bool-chip bool-chip-true ${checked ? "is-active" : ""}">${escapeHtml(t)}</span>
        <span class="bool-chip bool-chip-false ${checked ? "" : "is-active"}">${escapeHtml(f)}</span>
      </span>`;
  } else {
    const only = t !== "" ? t : f !== "" ? f : "·";
    const active = t !== "" ? checked : !checked;
    chipsHtml = `<span class="bool-chip bool-chip-single ${active ? "is-active" : ""} ${only === "·" ? "is-empty" : ""}" aria-hidden="true">${escapeHtml(only)}</span>`;
  }

  const skipHtml = skipAttrs
    ? `<label class="doc-skip doc-skip-compact" title="ข้าม — ติ๊กออกเพื่อแก้ค่า">
        <input type="checkbox" ${skipAttrs} ${skipped ? "checked" : ""} />
        <span>ข้าม</span>
      </label>`
    : "";

  return `<span class="doc-blank-wrap doc-bool-wrap ${skipped ? "is-skipped" : ""} ${checked ? "is-on" : "is-off"}">
    <label class="bool-opt doc-bool-opt" title="${escapeAttr(tip)}">
      <input type="checkbox" ${inputAttrs}
        ${checked ? "checked" : ""} ${skipped ? "disabled" : ""}
        aria-label="${escapeAttr(tip)}" />
      <span class="bool-name">${escapeHtml(nameText)}</span>
      ${chipsHtml}
    </label>
    ${skipHtml}
  </span>`;
}

/** Switch text fields to textarea when value length exceeds this. */
const LONG_TEXT_TEXTAREA_CHARS = 50;

/** @param {unknown} val */
function shouldUseTextarea(val) {
  return String(val ?? "").length > LONG_TEXT_TEXTAREA_CHARS;
}

/**
 * Text control: single-line input, or textarea when value is long.
 * @param {{
 *   value: unknown,
 *   className?: string,
 *   attrs: string,
 *   placeholder?: string,
 *   disabled?: boolean,
 *   ariaLabel?: string,
 *   id?: string,
 * }} opts
 */
function renderTextValueControl(opts) {
  const value = String(opts.value ?? "");
  const disabled = opts.disabled ? "disabled" : "";
  const ph = opts.placeholder != null ? ` placeholder="${escapeAttr(opts.placeholder)}"` : "";
  const aria = opts.ariaLabel != null ? ` aria-label="${escapeAttr(opts.ariaLabel)}"` : "";
  const id = opts.id ? ` id="${escapeAttr(opts.id)}"` : "";
  const cls = opts.className || "";
  if (shouldUseTextarea(value)) {
    const rows = Math.min(8, Math.max(3, Math.ceil(value.length / 40)));
    return `<textarea${id} class="${cls} is-textarea" data-kind="text" rows="${rows}"${ph}${aria} ${disabled} ${opts.attrs}>${escapeHtml(value)}</textarea>`;
  }
  return `<input type="text"${id} class="${cls}" data-kind="text" value="${escapeAttr(value)}"${ph}${aria} ${disabled} ${opts.attrs} />`;
}

/**
 * Swap input ↔ textarea when length crosses the threshold without full re-render.
 * @param {HTMLInputElement | HTMLTextAreaElement} el
 */
function maybeMorphTextControl(el) {
  const long = shouldUseTextarea(el.value);
  const isArea = el.tagName === "TEXTAREA";
  if (long === isArea) return el;

  const next = document.createElement(long ? "textarea" : "input");
  if (!long) /** @type {HTMLInputElement} */ (next).type = "text";
  for (const attr of el.getAttributeNames()) {
    if (attr === "type" || attr === "value" || attr === "rows") continue;
    next.setAttribute(attr, el.getAttribute(attr) || "");
  }
  next.className = el.className;
  next.classList.toggle("is-textarea", long);
  next.removeAttribute("data-text-wired");
  if (long) {
    const rows = Math.min(8, Math.max(3, Math.ceil(el.value.length / 40)));
    /** @type {HTMLTextAreaElement} */ (next).rows = rows;
  }
  next.value = el.value;
  if ("disabled" in el) /** @type {HTMLInputElement} */ (next).disabled = el.disabled;
  const wrap = el.closest(".doc-blank-wrap");
  wrap?.classList.toggle("is-multiline", long);
  const selStart = el.selectionStart ?? el.value.length;
  const selEnd = el.selectionEnd ?? el.value.length;
  el.replaceWith(next);
  next.focus();
  try {
    next.setSelectionRange(selStart, selEnd);
  } catch {
    /* ignore */
  }
  wireOneTextValueControl(next);
  return next;
}

/** @param {HTMLInputElement | HTMLTextAreaElement} el */
function wireOneTextValueControl(el) {
  if (el.dataset.textWired === "1") return;
  el.dataset.textWired = "1";
  el.addEventListener("input", () => {
    const list = el.dataset.list;
    if (list != null) {
      const row = Number(el.dataset.row);
      const item = el.dataset.item;
      if (item == null || Number.isNaN(row)) return;
      if (!state.values[list]) state.values[list] = [];
      if (!state.values[list][row]) state.values[list][row] = {};
      state.values[list][row][item] = el.value;
      scheduleSaveDraft();
      maybeMorphTextControl(el);
      return;
    }
    const name = el.name || el.dataset.docField;
    if (!name) return;
    state.values[name] = el.value;
    scheduleSaveDraft();
    maybeMorphTextControl(el);
  });
}

function renderInlineBlank(name) {
  const field = state.fields.find((f) => f.name === name);
  const skipped = !!state.skip[name];

  if (field?.type === "image") {
    return `<span class="doc-blank doc-blank-image" title="${escapeAttr(name)}">[รูป: ${escapeHtml(name)}]</span>`;
  }

  if (field?.type === "bool") {
    const checked = coerceBoolValue(state.values[name]);
    return renderDocBoolControl({
      checked,
      skipped,
      trueText: field.trueText,
      falseText: field.falseText,
      label: field.label,
      inputAttrs: `data-kind="bool" data-bool-field="${escapeAttr(name)}"`,
      skipAttrs: `data-skip-field="${escapeAttr(name)}"`,
    });
  }

  if (field?.type === "auto") {
    return renderAutoRunDisplay(field.label, 0);
  }

  const val = state.values[name] ?? "";
  return `<span class="doc-blank-wrap ${skipped ? "is-skipped" : ""} ${shouldUseTextarea(val) ? "is-multiline" : ""}">
    ${renderTextValueControl({
      value: val,
      className: "doc-blank",
      attrs: `data-doc-field="${escapeAttr(name)}" name="${escapeAttr(name)}"`,
      placeholder: name,
      disabled: skipped,
      ariaLabel: name,
    })}
    <label class="doc-skip">
      <input type="checkbox" data-skip-field="${escapeAttr(name)}" ${skipped ? "checked" : ""} />
      ข้าม
    </label>
  </span>`;
}

/** Table-like loop: many adjacent {{tags}} with little prose between them. */
function isTabularList(innerTokens, itemFields) {
  if (!itemFields || itemFields.length < 2) return false;
  const selfCount = innerTokens.filter((t) => t.type === "self").length;
  if (selfCount < 2) return false;
  const prose = innerTokens
    .filter((t) => t.type === "text")
    .map((t) => String(t.value || "").replace(/\s+/g, ""))
    .join("");
  return prose.length <= Math.max(8, selfCount * 2);
}

function itemFieldLabel(itemField) {
  if (!itemField) return "";
  if (itemField.type === "bool" || itemField.type === "auto") {
    return itemField.label || itemField.name;
  }
  return itemField.name;
}

function renderAutoRunDisplay(label, rowIdx) {
  const n = rowIdx + 1;
  return `<span class="auto-run" title="${escapeAttr(`${label || "ลำดับ"} — รันอัตโนมัติ`)}">
    <span class="auto-run-num">${n}</span>
    <span class="badge">รันเอง</span>
  </span>`;
}

function renderListCellControl(listName, row, idx, item, itemField) {
  const itemSkipped = !!state.rowSkip[listName]?.[idx]?.[item];
  if (itemField?.type === "auto") {
    return renderAutoRunDisplay(itemField.label, idx);
  }
  if (itemField?.type === "bool") {
    const checked = coerceBoolValue(row[item]);
    return renderDocBoolControl({
      checked,
      skipped: itemSkipped,
      trueText: itemField.trueText,
      falseText: itemField.falseText,
      label: itemField.label,
      inputAttrs: `data-kind="bool" data-list="${escapeAttr(listName)}" data-row="${idx}" data-item="${escapeAttr(item)}"`,
      skipAttrs: `data-skip-list="${escapeAttr(listName)}" data-skip-row="${idx}" data-skip-item="${escapeAttr(item)}"`,
    });
  }
  const cellVal = row[item] ?? "";
  return `<span class="doc-blank-wrap doc-table-cell-wrap ${itemSkipped ? "is-skipped" : ""} ${shouldUseTextarea(cellVal) ? "is-multiline" : ""}">
    ${renderTextValueControl({
      value: cellVal,
      className: "doc-blank doc-table-input",
      attrs: `data-list="${escapeAttr(listName)}" data-row="${idx}" data-item="${escapeAttr(item)}"`,
      placeholder: item,
      disabled: itemSkipped,
      ariaLabel: item,
    })}
    <label class="doc-skip doc-skip-compact" title="ข้าม">
      <input type="checkbox" data-skip-list="${escapeAttr(listName)}" data-skip-row="${idx}" data-skip-item="${escapeAttr(item)}" ${itemSkipped ? "checked" : ""} />
      <span>ข้าม</span>
    </label>
  </span>`;
}

function renderListAsTable(listName, field, rows) {
  const head = field.itemFields
    .map((item) => `<th scope="col">${escapeHtml(itemFieldLabel(item))}</th>`)
    .join("");
  const body = rows
    .map((row, idx) => {
      const cells = field.itemFields
        .map((itemField) => {
          const item = itemField.name;
          return `<td>${renderListCellControl(listName, row, idx, item, itemField)}</td>`;
        })
        .join("");
      return `<tr>
        <th scope="row" class="doc-table-rownum">
          <span>${idx + 1}</span>
          <button type="button" class="linkish danger remove-row" data-list="${escapeAttr(listName)}" data-row="${idx}" title="ลบแถว">ลบ</button>
        </th>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<div class="doc-table-scroll">
    <table class="doc-table">
      <thead>
        <tr>
          <th scope="col" class="doc-table-rownum">#</th>
          ${head}
        </tr>
      </thead>
      <tbody>
        ${body || `<tr><td colspan="${field.itemFields.length + 1}" class="row-empty">ยังไม่มีแถว</td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function renderListAsCards(listName, field, innerTokens, rows) {
  return rows
    .map((row, idx) => {
      const line = innerTokens
        .map((t) => {
          if (t.type === "text") return formatPlainText(t.value || "");
          if (t.type === "self") {
            const item = t.name || "";
            const itemField = field.itemFields.find((x) => x.name === item);
            return renderListCellControl(listName, row, idx, item, itemField);
          }
          return "";
        })
        .join("");
      return `<div class="doc-list-row">
        <div class="doc-list-row-head">
          <span>แถว ${idx + 1}</span>
          <button type="button" class="linkish danger remove-row" data-list="${escapeAttr(listName)}" data-row="${idx}">ลบแถว</button>
        </div>
        <div class="doc-list-row-body">${line}</div>
      </div>`;
    })
    .join("");
}

function renderListBlock(listName, innerTokens) {
  const field = state.fields.find((f) => f.type === "list" && f.name === listName);
  const skipped = !!state.skip[listName];
  if (!field || field.type !== "list") {
    return innerTokens
      .map((t) => {
        if (t.type === "text") return formatPlainText(t.value || "");
        if (t.type === "self") return renderInlineBlank(t.name || "");
        return "";
      })
      .join("");
  }

  ensureListRows(listName, field.itemFields);
  if (skipped) {
    return `<div class="doc-list is-skipped">
      <div class="doc-list-toolbar">
        <span class="doc-list-name">${escapeHtml(listName)}</span>
        <label class="doc-skip">
          <input type="checkbox" data-skip-field="${escapeAttr(listName)}" checked />
          ข้าม
        </label>
      </div>
      <p class="row-empty">ไม่แสดงแถวในเอกสาร</p>
    </div>`;
  }

  const rows = /** @type {Record<string, string>[]} */ (state.values[listName] || []);
  const asTable = isTabularList(innerTokens, field.itemFields);
  const bodyHtml = asTable
    ? renderListAsTable(listName, field, rows)
    : renderListAsCards(listName, field, innerTokens, rows) ||
      `<p class="row-empty">ยังไม่มีแถว</p>`;

  return `<div class="doc-list ${asTable ? "doc-list-table" : ""}" data-list-field="${escapeAttr(listName)}">
    <div class="doc-list-toolbar">
      <span class="doc-list-name">${escapeHtml(listName)}${asTable ? ` <span class="badge">ตาราง</span>` : ""}</span>
      <label class="doc-skip">
        <input type="checkbox" data-skip-field="${escapeAttr(listName)}" />
        ข้าม
      </label>
      <button type="button" class="btn-secondary add-row" data-list="${escapeAttr(listName)}">+ เพิ่มแถว</button>
    </div>
    ${bodyHtml}
  </div>`;
}

function wireDocumentPreviewEvents() {
  const root = document.getElementById("docPreview");
  if (!root) return;
  // text / list / skip handlers already covered by wireFieldEvents via same data-* attrs
  root.querySelectorAll("table.doc-table-stretch").forEach((table) => wireTableColResize(table));
}

/**
 * Drag column edges to resize in the preview only (not saved to the document).
 * Uses an overlay so every grid line is hittable (cell-edge handles get covered by neighbors).
 * @param {HTMLTableElement} table
 */
function wireTableColResize(table) {
  if (table.dataset.colResizeWired === "1") return;
  const colgroup = table.querySelector(":scope > colgroup");
  const wrap = table.closest(".doc-table-scroll");
  if (!colgroup || !wrap) return;
  table.dataset.colResizeWired = "1";
  table.classList.add("doc-table-resizable");
  table.style.tableLayout = "fixed";
  wrap.classList.add("is-col-resizable");

  const cols = /** @type {HTMLTableColElement[]} */ ([...colgroup.querySelectorAll("col")]);
  if (cols.length < 1) return;
  const key = colgroup.dataset.viewKey || "";

  /** @param {number} [forceIndex] @param {number} [forcePx] */
  const syncTableWidth = (forceIndex, forcePx) => {
    let total = 0;
    cols.forEach((col, idx) => {
      const w =
        forceIndex === idx && forcePx != null
          ? forcePx
          : Math.round(parseFloat(col.style.width) || col.getBoundingClientRect().width || 80);
      total += w;
    });
    table.style.width = `${total}px`;
    table.style.minWidth = `${total}px`;
    table.style.maxWidth = "none";
  };

  /** @param {number} index @param {number} px */
  const applyColWidth = (index, px) => {
    const col = cols[index];
    const w = Math.max(48, Math.round(px));
    col.style.width = `${w}px`;
    col.style.minWidth = `${w}px`;
    col.style.maxWidth = `${w}px`;
    syncTableWidth(index, w);
    return w;
  };

  const lockWidths = () => {
    cols.forEach((col, idx) => {
      const measured = Math.round(col.getBoundingClientRect().width);
      const fallback = Math.round(parseFloat(col.style.width) || parseFloat(col.style.minWidth) || 80);
      applyColWidth(idx, measured > 0 ? measured : fallback);
    });
    syncTableWidth();
  };
  lockWidths();

  const persistViewWidths = () => {
    if (!key) return;
    viewTableColWidths.set(
      key,
      cols.map((col) => Math.round(parseFloat(col.style.width) || col.getBoundingClientRect().width || 80)),
    );
    scheduleSaveDraft();
  };

  /** Prefer a 1-cell-per-column row (body), else expand header leaf row. */
  const measureColRights = () => {
    const wrapRect = wrap.getBoundingClientRect();
    const bodyRow = table.tBodies[0]?.rows[0];
    /** @type {number[]} */
    const rights = [];
    if (bodyRow && bodyRow.cells.length === cols.length) {
      [...bodyRow.cells].forEach((cell) => {
        rights.push(cell.getBoundingClientRect().right - wrapRect.left + wrap.scrollLeft);
      });
      return rights;
    }
    const theadRows = [...(table.tHead?.rows || [])];
    const leafRow = theadRows[theadRows.length - 1] || table.rows[0];
    if (!leafRow) return rights;
    const hasRownum = cols[0]?.classList.contains("doc-table-rownum-col");
    if (hasRownum && theadRows[0]?.cells[0]?.classList.contains("doc-table-rownum")) {
      rights.push(theadRows[0].cells[0].getBoundingClientRect().right - wrapRect.left + wrap.scrollLeft);
    }
    [...leafRow.cells].forEach((cell) => {
      if (cell.classList.contains("doc-table-rownum")) return;
      const span = cell.colSpan || 1;
      const rect = cell.getBoundingClientRect();
      const left = rect.left - wrapRect.left + wrap.scrollLeft;
      const width = rect.width;
      for (let s = 0; s < span; s++) {
        // Approximate equal split when only a colspan cell is available
        rights.push(left + (width * (s + 1)) / span);
      }
    });
    return rights.slice(0, cols.length);
  };

  let overlay = wrap.querySelector(":scope > .col-resize-overlay");
  if (overlay && overlay.dataset.forTable !== key) {
    overlay.remove();
    overlay = null;
  }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "col-resize-overlay";
    overlay.dataset.forTable = key;
    overlay.setAttribute("aria-hidden", "true");
    wrap.appendChild(overlay);
  }

  const layoutHandles = () => {
    if (wrap.classList.contains("is-resizing-col")) return;
    const rights = measureColRights();
    if (rights.length !== cols.length) {
      // Fall back: cumulative col widths from table left
      const tableLeft =
        table.getBoundingClientRect().left - wrap.getBoundingClientRect().left + wrap.scrollLeft;
      let x = tableLeft;
      rights.length = 0;
      cols.forEach((col) => {
        x += parseFloat(col.style.width) || col.getBoundingClientRect().width || 80;
        rights.push(x);
      });
    }

    // Cover full table height so every vertical grid line is draggable
    overlay.style.height = `${Math.round(table.offsetHeight)}px`;
    overlay.innerHTML = "";

    rights.forEach((right, i) => {
      const handle = document.createElement("div");
      handle.className = "col-resizer";
      handle.dataset.colIndex = String(i);
      handle.title = "ลากปรับความกว้าง (เฉพาะหน้าจอ ไม่บันทึกลงไฟล์)";
      handle.style.left = `${Math.round(right)}px`;
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = parseFloat(cols[i].style.width) || cols[i].getBoundingClientRect().width;
        const startLeft = parseFloat(handle.style.left) || Math.round(right);
        handle.classList.add("is-active");
        table.classList.add("is-resizing-col");
        wrap.classList.add("is-resizing-col");
        handle.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          applyColWidth(i, startW + dx);
          // Handle tracks the pointer delta directly (not post-layout measure)
          handle.style.left = `${startLeft + dx}px`;
        };
        const onUp = (ev) => {
          const dx = ev.clientX - startX;
          applyColWidth(i, startW + dx);
          handle.classList.remove("is-active");
          table.classList.remove("is-resizing-col");
          wrap.classList.remove("is-resizing-col");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          persistViewWidths();
          layoutHandles();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      });
      overlay.appendChild(handle);
    });
  };

  requestAnimationFrame(() => {
    lockWidths();
    layoutHandles();
  });
  wrap.addEventListener(
    "scroll",
    () => {
      if (!wrap.classList.contains("is-resizing-col")) layoutHandles();
    },
    { passive: true },
  );
  window.addEventListener("resize", () => {
    if (!wrap.classList.contains("is-resizing-col")) layoutHandles();
  });
}

/** @param {FormField} field */
function renderField(field) {
  const skipped = !!state.skip[field.name];

  if (field.type === "text") {
    const val = state.values[field.name] ?? "";
    return `
      <div class="field ${skipped ? "is-skipped" : ""}">
        <div class="field-head">
          <label for="f-${cssId(field.name)}">${escapeHtml(field.name)}</label>
          ${skipCheckbox(field.name, skipped)}
        </div>
        ${renderTextValueControl({
          value: val,
          id: `f-${cssId(field.name)}`,
          className: "field-text-control",
          attrs: `name="${escapeAttr(field.name)}"`,
          placeholder: `กรอก ${field.name}`,
          disabled: skipped,
        })}
      </div>`;
  }

  if (field.type === "bool") {
    const checked = !!state.values[field.name];
    return `
      <div class="field ${skipped ? "is-skipped" : ""}">
        <div class="field-head">
          <div class="field-label">${escapeHtml(field.label)} <span class="badge">ติ๊ก</span></div>
          ${skipCheckbox(field.name, skipped)}
        </div>
        <label class="bool-opt bool-opt-block" for="f-${cssId(field.name)}">
          <input type="checkbox" id="f-${cssId(field.name)}" data-kind="bool" data-bool-field="${escapeAttr(field.name)}"
            ${checked ? "checked" : ""} ${skipped ? "disabled" : ""} />
          <span class="bool-chip">${escapeHtml(field.trueText || "·")}</span>
          <span class="bool-hint">ติ๊ก → <code>${escapeHtml(field.trueText || "(ว่าง)")}</code> · ไม่ติ๊ก → <code>${escapeHtml(field.falseText || "(ว่าง)")}</code></span>
        </label>
      </div>`;
  }

  if (field.type === "auto") {
    return `
      <div class="field">
        <div class="field-head">
          <div class="field-label">${escapeHtml(field.label)} <span class="badge">รันเอง</span></div>
        </div>
        <p class="dropzone-hint" style="margin:0">ใช้ในลูปตาราง/รายการ — จะใส่เลขแถวอัตโนมัติ</p>
        ${renderAutoRunDisplay(field.label, 0)}
      </div>`;
  }

  if (field.type === "image") {
    const file = state.images[field.name];
    let preview = "";
    if (file && !skipped) {
      const url = URL.createObjectURL(file);
      state.objectUrls.push(url);
      preview = `<img class="thumb" src="${url}" alt="พรีวิว ${escapeAttr(field.name)}" />`;
    } else {
      preview = `<div class="thumb" aria-hidden="true"></div>`;
    }
    return `
      <div class="field ${skipped ? "is-skipped" : ""}" data-image-field="${escapeAttr(field.name)}">
        <div class="field-head">
          <div class="field-label">${escapeHtml(field.name)} <span class="badge">รูปภาพ</span></div>
          ${skipCheckbox(field.name, skipped)}
        </div>
        <div class="image-box" tabindex="0" role="button" aria-label="อัปโหลดรูป ${escapeAttr(field.name)}" ${skipped ? 'aria-disabled="true"' : ""}>
          ${preview}
          <div class="image-actions">
            <button type="button" class="btn-secondary pick-image" ${skipped ? "disabled" : ""}>เลือกหรือลากรูป PNG/JPEG</button>
            ${file && !skipped ? `<button type="button" class="linkish danger clear-image">ลบรูป</button>` : ""}
          </div>
          <input class="sr-only image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp" ${skipped ? "disabled" : ""} />
        </div>
      </div>`;
  }

  // list
  ensureListRows(field.name, field.itemFields);
  const rows = /** @type {Record<string, string>[]} */ (state.values[field.name]);
  const rowsHtml = skipped
    ? `<p class="row-empty">ข้ามรายการนี้ — จะไม่แสดงแถวในเอกสาร</p>`
    : rows.length === 0
      ? `<p class="row-empty">ยังไม่มีแถว — กดเพิ่มแถว หรือติ๊กข้าม</p>`
      : rows
          .map((row, idx) => {
            const inputs = field.itemFields
              .map((item) => {
                const itemSkipped = !!state.rowSkip[field.name]?.[idx]?.[item.name];
                if (item.type === "auto") {
                  return `
              <div class="field" style="margin:0">
                <div class="field-head">
                  <label>${escapeHtml(item.label)} <span class="badge">รันเอง</span></label>
                </div>
                ${renderAutoRunDisplay(item.label, idx)}
              </div>`;
                }
                if (item.type === "bool") {
                  const checked = !!row[item.name];
                  return `
              <div class="field ${itemSkipped ? "is-skipped" : ""}" style="margin:0">
                <div class="field-head">
                  <label for="l-${cssId(field.name)}-${idx}-${cssId(item.name)}">${escapeHtml(item.label)} <span class="badge">ติ๊ก</span></label>
                  ${rowSkipCheckbox(field.name, idx, item.name, itemSkipped)}
                </div>
                <label class="bool-opt" for="l-${cssId(field.name)}-${idx}-${cssId(item.name)}">
                  <input type="checkbox" id="l-${cssId(field.name)}-${idx}-${cssId(item.name)}"
                    data-kind="bool" data-list="${escapeAttr(field.name)}" data-row="${idx}" data-item="${escapeAttr(item.name)}"
                    ${checked ? "checked" : ""} ${itemSkipped ? "disabled" : ""} />
                  <span>จริง → <code>${escapeHtml(item.trueText || "(ว่าง)")}</code> · ไม่จริง → <code>${escapeHtml(item.falseText || "(ว่าง)")}</code></span>
                </label>
              </div>`;
                }
                return `
              <div class="field ${itemSkipped ? "is-skipped" : ""}" style="margin:0">
                <div class="field-head">
                  <label for="l-${cssId(field.name)}-${idx}-${cssId(item.name)}">${escapeHtml(item.name)}</label>
                  ${rowSkipCheckbox(field.name, idx, item.name, itemSkipped)}
                </div>
                ${renderTextValueControl({
                  value: row[item.name] ?? "",
                  id: `l-${cssId(field.name)}-${idx}-${cssId(item.name)}`,
                  className: "field-text-control",
                  attrs: `data-list="${escapeAttr(field.name)}" data-row="${idx}" data-item="${escapeAttr(item.name)}"`,
                  disabled: itemSkipped,
                })}
              </div>`;
              })
              .join("");
            return `
              <div class="row-card" aria-label="แถว ${idx + 1} ของ ${escapeAttr(field.name)}">
                <div class="row-card-head">
                  <span>แถว ${idx + 1}</span>
                  <button type="button" class="linkish danger remove-row" data-list="${escapeAttr(field.name)}" data-row="${idx}">ลบแถว</button>
                </div>
                <div class="row-grid">${inputs}</div>
              </div>`;
          })
          .join("");

  return `
    <div class="repeater ${skipped ? "is-skipped" : ""}" data-list-field="${escapeAttr(field.name)}">
      <div class="repeater-head">
        <h3>${escapeHtml(field.name)} <span class="badge">รายการ</span></h3>
        <div class="repeater-actions">
          ${skipCheckbox(field.name, skipped)}
          <button type="button" class="btn-secondary add-row" data-list="${escapeAttr(field.name)}" ${skipped ? "disabled" : ""}>+ เพิ่มแถว</button>
        </div>
      </div>
      ${rowsHtml}
    </div>`;
}

function wireFieldEvents() {
  app.querySelectorAll("input[data-skip-field]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const name = t.dataset.skipField;
      if (!name) return;
      state.skip[name] = t.checked;
      if (t.checked) {
        const field = state.fields.find((f) => f.name === name);
        if (field?.type === "text") state.values[name] = "";
        if (field?.type === "bool") state.values[name] = false;
        if (field?.type === "image") state.images[name] = null;
      }
      // Unchecking ข้าม re-enables the bool/text control via re-render
      renderForm();
      scheduleSaveDraft();
    });
  });

  app.querySelectorAll("input[data-skip-list]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      const list = t.dataset.skipList;
      const row = Number(t.dataset.skipRow);
      const item = t.dataset.skipItem;
      if (!list || item == null || Number.isNaN(row)) return;
      if (!state.rowSkip[list]) state.rowSkip[list] = [];
      if (!state.rowSkip[list][row]) state.rowSkip[list][row] = {};
      state.rowSkip[list][row][item] = t.checked;
      if (t.checked && state.values[list]?.[row]) {
        const listField = state.fields.find((f) => f.type === "list" && f.name === list);
        const itemField = listField?.type === "list"
          ? listField.itemFields.find((x) => x.name === item)
          : null;
        state.values[list][row][item] = itemField?.type === "bool" ? false : "";
      }
      renderForm();
      scheduleSaveDraft();
    });
  });

  app.querySelectorAll('input[data-kind="bool"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.disabled) return;
      const wrap = t.closest(".doc-bool-wrap");
      if (wrap) {
        wrap.classList.toggle("is-on", t.checked);
        wrap.classList.toggle("is-off", !t.checked);
        wrap.classList.remove("is-skipped");
        const trueChip = wrap.querySelector(".bool-chip-true");
        const falseChip = wrap.querySelector(".bool-chip-false");
        const singleChip = wrap.querySelector(".bool-chip-single");
        trueChip?.classList.toggle("is-active", t.checked);
        falseChip?.classList.toggle("is-active", !t.checked);
        // single-chip mode (e.g. {{พบ?√,}}) — highlight only when checked
        singleChip?.classList.toggle("is-active", t.checked);
      }
      const list = t.dataset.list;
      if (list != null) {
        const row = Number(t.dataset.row);
        const item = t.dataset.item;
        if (item == null || Number.isNaN(row)) return;
        if (!state.values[list]) state.values[list] = [];
        if (!state.values[list][row]) state.values[list][row] = {};
        state.values[list][row][item] = t.checked;
        if (state.rowSkip[list]?.[row]) state.rowSkip[list][row][item] = false;
        scheduleSaveDraft();
        return;
      }
      const name = t.dataset.boolField;
      if (!name) return;
      state.values[name] = t.checked;
      state.skip[name] = false;
      scheduleSaveDraft();
    });
  });

  app.querySelectorAll('input[data-kind="text"], textarea[data-kind="text"]').forEach((el) => {
    wireOneTextValueControl(/** @type {HTMLInputElement | HTMLTextAreaElement} */ (el));
  });

  app.querySelectorAll(".add-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = /** @type {HTMLElement} */ (btn).dataset.list;
      const field = state.fields.find((f) => f.type === "list" && f.name === list);
      if (!field || field.type !== "list" || state.skip[list]) return;
      const blank = {};
      for (const item of field.itemFields) {
        if (item.type === "bool") blank[item.name] = false;
        else blank[item.name] = "";
      }
      state.values[list].push(blank);
      ensureRowSkip(list, state.values[list].length, field.itemFields);
      renderForm();
      scheduleSaveDraft();
    });
  });

  app.querySelectorAll(".remove-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = /** @type {HTMLElement} */ (btn);
      const list = el.dataset.list;
      const row = Number(el.dataset.row);
      if (!list || Number.isNaN(row)) return;
      state.values[list].splice(row, 1);
      state.rowSkip[list]?.splice(row, 1);
      renderForm();
      scheduleSaveDraft();
    });
  });

  app.querySelectorAll("[data-image-field]").forEach((wrap) => {
    const name = /** @type {HTMLElement} */ (wrap).dataset.imageField;
    const box = wrap.querySelector(".image-box");
    const input = /** @type {HTMLInputElement | null} */ (wrap.querySelector(".image-input"));
    const pick = wrap.querySelector(".pick-image");
    const clear = wrap.querySelector(".clear-image");
    if (!name || !box || !input || state.skip[name]) return;

    const assign = (file) => {
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        showBanner(`รูป ${name} ใหญ่เกิน 8 MB`);
        return;
      }
      state.images[name] = file;
      showBanner("");
      renderForm();
      scheduleSaveDraft();
    };

    pick?.addEventListener("click", (e) => {
      e.stopPropagation();
      input.click();
    });
    box.addEventListener("click", (e) => {
      if (e.target === clear) return;
      input.click();
    });
    input.addEventListener("change", () => assign(input.files?.[0] || null));
    clear?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.images[name] = null;
      renderForm();
      scheduleSaveDraft();
    });

    ["dragenter", "dragover"].forEach((ev) => {
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      box.addEventListener(ev, (e) => {
        e.preventDefault();
        box.classList.remove("dragover");
      });
    });
    box.addEventListener("drop", (e) => {
      assign(e.dataTransfer?.files?.[0] || null);
    });
  });
}

/**
 * Build fill values from an arbitrary slot/state snapshot.
 * @param {{
 *   fields: typeof state.fields,
 *   values: Record<string, any>,
 *   images: Record<string, File | null>,
 *   skip: Record<string, boolean>,
 *   rowSkip: Record<string, Record<string, boolean>[]>,
 * }} snap
 */
function buildValuesPayloadFrom(snap) {
  /** @type {Record<string, unknown>} */
  const values = {};

  for (const f of snap.fields) {
    if (f.type === "text") {
      values[f.name] = snap.skip[f.name]
        ? ""
        : String(snap.values[f.name] ?? "");
    } else if (f.type === "bool") {
      const on = !snap.skip[f.name] && !!snap.values[f.name];
      values[f.name] = on ? f.trueText : f.falseText;
    } else if (f.type === "auto") {
      values[f.name] = "1";
    } else if (f.type === "image") {
      if (snap.skip[f.name] || !snap.images[f.name]) {
        values[f.name] = "";
      }
    } else if (f.type === "list") {
      if (snap.skip[f.name]) {
        values[f.name] = [];
      } else {
        const rows = (snap.values[f.name] || []).map((row, idx) => {
          /** @type {Record<string, string>} */
          const out = {};
          for (const item of f.itemFields) {
            if (item.type === "auto") {
              out[item.name] = String(idx + 1);
            } else if (item.type === "bool") {
              const on =
                !snap.rowSkip[f.name]?.[idx]?.[item.name] && !!row[item.name];
              out[item.name] = on ? item.trueText : item.falseText;
            } else {
              out[item.name] = snap.rowSkip[f.name]?.[idx]?.[item.name]
                ? ""
                : String(row[item.name] ?? "");
            }
          }
          return out;
        });
        values[f.name] = rows;
      }
    }
  }

  return values;
}

/** Build values object for the API (skipped fields become empty / []). */
function buildValuesPayload() {
  return buildValuesPayloadFrom(state);
}

/**
 * Validate a slot without touching the DOM. Returns missing field labels.
 * @param {typeof multiSlots[number]} slot
 */
function missingFieldsForSlot(slot) {
  /** @type {string[]} */
  const missing = [];
  for (const f of slot.fields) {
    if (slot.skip[f.name]) continue;
    if (f.type === "text") {
      if (!String(slot.values[f.name] ?? "").trim()) missing.push(`${slot.filename}: ${f.name}`);
    } else if (f.type === "image") {
      if (!slot.images[f.name]) missing.push(`${slot.filename}: ${f.name}`);
    } else if (f.type === "list") {
      const rows = slot.values[f.name] || [];
      if (rows.length === 0) {
        missing.push(`${slot.filename}: ${f.name} (ต้องมีอย่างน้อย 1 แถว)`);
        continue;
      }
      rows.forEach((row, idx) => {
        for (const item of f.itemFields) {
          if (item.type === "bool" || item.type === "auto") continue;
          if (slot.rowSkip[f.name]?.[idx]?.[item.name]) continue;
          if (!String(row[item.name] ?? "").trim()) {
            missing.push(`${slot.filename}: ${f.name} แถว ${idx + 1}.${item.name}`);
          }
        }
      });
    }
  }
  return missing;
}

async function createAllTemplatesZip() {
  persistActiveSlot();
  /** @type {string[]} */
  const missing = [];
  for (const slot of multiSlots) missing.push(...missingFieldsForSlot(slot));
  if (missing.length) {
    const listed =
      missing.length <= 8
        ? missing.join(", ")
        : `${missing.slice(0, 8).join(", ")} และอีก ${missing.length - 8} ช่อง`;
    showBanner(
      `ยังมีช่องว่างในบางเทมเพลต (${missing.length}): ${listed} — กรอก/ข้ามให้ครบก่อนสร้างทั้งหมด`,
    );
    return;
  }

  const choice = await askClearAfterCreate();
  if (choice === "abort") return;

  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("submitBtn"));
  if (btn) {
    btn.disabled = true;
    btn.textContent = "กำลังสร้างทั้งหมด…";
  }
  showBanner(`กำลังสร้าง ${multiSlots.length} เอกสารจากค่าบนหน้าจอ…`, "progress");
  app.setAttribute("aria-busy", "true");

  const fd = new FormData();
  const items = [];
  for (const slot of multiSlots) {
    if (!slot.file || !(slot.file instanceof File) || slot.file.size <= 0) {
      showBanner(`เทมเพลต「${slot.filename}」ไม่มีไฟล์ — ลองอัปโหลดใหม่`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "สร้างเอกสาร…";
      }
      app.removeAttribute("aria-busy");
      return;
    }
    fd.append("templates", slot.file, slot.filename);
    items.push({
      filename: slot.filename,
      values: buildValuesPayloadFrom(slot),
    });
  }
  fd.append("items", JSON.stringify(items));

  try {
    const res = await fetch("/api/batch-fill", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showBanner(data.error || "สร้างเอกสารทั้งหมดไม่สำเร็จ");
      return;
    }
    if (data.zipBase64) {
      const bin = atob(data.zipBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.zipName || "docx-form-batch.zip";
      a.click();
      URL.revokeObjectURL(url);
    }
    const okN = (data.results || []).filter((r) => r.ok).length;
    if (choice === "clear") {
      for (const slot of multiSlots) {
        applySlotToState(slot);
        clearFilledFields();
        persistActiveSlot();
      }
      const active = multiSlots.find((s) => s.id === multiActiveId) || multiSlots[0];
      if (active) applySlotToState(active);
      renderForm();
      showBanner(`ดาวน์โหลด ZIP แล้ว · สำเร็จ ${okN}/${multiSlots.length} และล้างช่องแล้ว`, "success");
    } else {
      scheduleSaveDraft();
      showBanner(`ดาวน์โหลด ZIP แล้ว · สำเร็จ ${okN}/${multiSlots.length}`, "success");
    }
    setTimeout(() => showBanner(""), 3200);
  } catch {
    showBanner("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  } finally {
    app.removeAttribute("aria-busy");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "สร้างเอกสาร…";
    }
  }
}

async function onSubmit(e) {
  e.preventDefault();
  if (!state.file) return;

  const scope = await askCreateScope();
  if (scope === "abort") return;
  if (scope === "all") {
    await createAllTemplatesZip();
    return;
  }

  const missing = validateBeforeSubmit();
  if (missing.length) {
    const listed =
      missing.length <= 10
        ? missing.join(", ")
        : `${missing.slice(0, 10).join(", ")} และอีก ${missing.length - 10} ช่อง`;
    showBanner(
      `ยังมีช่องที่ไม่ได้กรอก (${missing.length}): ${listed} — กรอกให้ครบ หรือติ๊ก “ข้าม” ก่อนสร้างเอกสาร`,
    );
    return;
  }

  const choice = await askClearAfterCreate();
  if (choice === "abort") return;

  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("submitBtn"));
  if (btn) {
    btn.disabled = true;
    btn.textContent = "กำลังสร้าง…";
  }
  showBanner("");

  const values = buildValuesPayload();
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("values", JSON.stringify(values));
  for (const [name, file] of Object.entries(state.images)) {
    if (file && !state.skip[name]) {
      fd.append(`image:${name}`, file, file.name);
    }
  }

  try {
    const res = await fetch("/api/fill", { method: "POST", body: fd });
    if (!res.ok) {
      let msg = "สร้างเอกสารไม่สำเร็จ";
      try {
        const data = await res.json();
        if (data.error) msg = data.error;
      } catch {
        /* ignore */
      }
      showBanner(msg);
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/.exec(cd);
    const filename = star
      ? decodeURIComponent(star[1].trim())
      : plain?.[1] || "filled.docx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (choice === "clear") {
      clearFilledFields();
      persistActiveSlot();
      renderForm();
      showBanner("ดาวน์โหลดแล้ว และล้างช่องเรียบร้อย", "success");
    } else {
      persistActiveSlot();
      scheduleSaveDraft();
      showBanner("ดาวน์โหลดเอกสารแล้ว — เก็บค่าที่กรอกไว้", "success");
    }
    setTimeout(() => showBanner(""), 2800);
  } catch {
    showBanner("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = isMultiMode() ? "สร้างเอกสาร…" : "สร้างเอกสาร";
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function cssId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function boot() {
  // Paint the empty home UI immediately so Safari never sits on a blank sheet
  // while IndexedDB restore hangs.
  try {
    renderEmpty();
  } catch (err) {
    console.warn("initial renderEmpty failed", err);
  }
  try {
    await checkHealth();
  } catch (err) {
    console.warn("health check failed during boot", err);
  }
  try {
    const restored = await restoreDraft();
    if (restored) {
      try {
        renderForm();
        showBanner("กู้คืนข้อมูลหลังรีเฟรชแล้ว", "success");
        setTimeout(() => showBanner(""), 2800);
        return;
      } catch (err) {
        console.warn("restore render failed — falling back to empty", err);
        try {
          await draftClear();
        } catch {
          /* ignore */
        }
        renderEmpty();
      }
    }
  } catch (err) {
    console.error("boot failed", err);
    try {
      renderEmpty();
    } catch (err2) {
      console.error("renderEmpty failed", err2);
      const appEl = document.getElementById("app");
      if (appEl) {
        appEl.innerHTML =
          `<p class="subhead">โหลดหน้าไม่สำเร็จ — รีเฟรชแรง หรือเปิด Console ดู error</p>` +
          `<pre class="hint-error">${escapeHtml(String(err?.message || err))}</pre>`;
      }
      showBanner("โหลดหน้าไม่สำเร็จ — ลองรีเฟรชใหม่");
    }
  }
}

window.addEventListener("pagehide", () => {
  window.clearTimeout(draftSaveTimer);
  void saveDraftNow();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    window.clearTimeout(draftSaveTimer);
    void saveDraftNow();
  }
});

void boot().catch((err) => {
  console.error("boot rejected", err);
  showBanner("โหลดหน้าไม่สำเร็จ — รีเฟรชแล้วลองใหม่");
});
setInterval(checkHealth, 30000);
