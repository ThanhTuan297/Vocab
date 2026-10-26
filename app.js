if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ===== Cấu hình =====
const MAX_BATCH_CHARS = 7000;  // Ngân sách ký tự mỗi request (thay cho "15 đoạn")
const MAX_BATCH_ITEMS = 80;    // Trần số đoạn mỗi request
const MAX_CHUNK_CHARS = 1500;  // Đoạn dài hơn mức này sẽ được cắt ở chỗ hết câu
const API_DELAY_MS = 4000;
const MAX_RETRIES = 4;
const MAX_TRIES_PER_CHUNK = 3;
const DB_KEY = 'session';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

let parsedChunks = [];
let currentFileName = "";
let isTranslating = false;
let abortCtl = null;

const $ = id => document.getElementById(id);
const fileUpload = $('fileUpload'), fileNameDisplay = $('fileNameDisplay'), startBtn = $('startBtn'),
  pauseBtn = $('pauseBtn'), clearCacheBtn = $('clearCacheBtn'), exportWordBtn = $('exportWordBtn'),
  apiKeyInput = $('apiKeyInput'), modelSelect = $('modelSelect'), glossaryInput = $('glossaryInput'),
  readerContainer = $('readerContainer'), progressSection = $('progressSection'),
  progressBarFill = $('progressBarFill'), statusLabel = $('statusLabel'), percentLabel = $('percentLabel'),
  sideBySideBtn = $('sideBySideBtn'), interlinearBtn = $('interlinearBtn');

// ===== Lưu trữ: IndexedDB (không giới hạn 5MB như localStorage) =====
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      const r = indexedDB.open('BilingualStudio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async del(k) {
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
};

async function saveToCache() {
  try {
    await idb.set(DB_KEY, {
      fileName: currentFileName,
      glossary: glossaryInput.value,
      // Bản dịch Demo không bao giờ được lưu như bản dịch thật
      chunks: parsedChunks.map(c => c.demo ? { ...c, translated: "", demo: false } : c)
    });
  } catch (e) {
    statusLabel.textContent = "⚠️ Không thể lưu tiến độ vào bộ nhớ trình duyệt (đầy hoặc bị chặn). Hãy xuất file Word sớm!";
  }
}

// ===== Khởi động =====
window.addEventListener('DOMContentLoaded', async () => {
  apiKeyInput.value = localStorage.getItem('BILINGUAL_API_KEY') || "";
  const savedModel = localStorage.getItem('BILINGUAL_MODEL');
  if (apiKeyInput.value) loadModels(savedModel);
  else if (savedModel) modelSelect.value = savedModel;

  try {
    const data = await idb.get(DB_KEY);
    if (data && data.chunks && data.chunks.length) {
      parsedChunks = data.chunks;
      currentFileName = data.fileName || "Tai_lieu_da_luu";
      glossaryInput.value = data.glossary || "";
      fileNameDisplay.textContent = currentFileName;
      progressSection.style.display = "block";
      renderAllRows(parsedChunks);
      updateProgressUI();
      refreshStartBtn();
      const done = parsedChunks.filter(c => c.translated).length;
      statusLabel.textContent = done === parsedChunks.length
        ? "Tài liệu đã được dịch hoàn tất 100%!"
        : `Đã khôi phục phiên trước (${done}/${parsedChunks.length} đoạn). ${estimateText()}`;
    }
  } catch (e) { console.error("Không thể đọc cache:", e); }
});

apiKeyInput.addEventListener('input', () => localStorage.setItem('BILINGUAL_API_KEY', apiKeyInput.value.trim()));
apiKeyInput.addEventListener('change', () => loadModels(modelSelect.value));
modelSelect.addEventListener('change', () => localStorage.setItem('BILINGUAL_MODEL', modelSelect.value));
glossaryInput.addEventListener('change', () => { if (parsedChunks.length) saveToCache(); });

// Tự động lấy danh sách model hợp lệ theo API key
async function loadModels(preferred) {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  try {
    const res = await fetch(`${API_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) return;
    const data = await res.json();
    const names = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(n => /^gemini/.test(n) && !/embedding|tts|image|live|vision|audio|robotics|computer/i.test(n))
      .sort().reverse();
    if (!names.length) return;
    modelSelect.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("");
    const pick = names.includes(preferred) ? preferred : (names.find(n => /flash/.test(n) && !/lite/.test(n)) || names[0]);
    modelSelect.value = pick;
    localStorage.setItem('BILINGUAL_MODEL', pick);
  } catch (e) { /* giữ danh sách mặc định */ }
}

// ===== Tải file =====
fileUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || isTranslating) return;

  currentFileName = file.name;
  fileNameDisplay.textContent = currentFileName;
  startBtn.disabled = true;
  exportWordBtn.disabled = true;
  progressSection.style.display = "block";
  statusLabel.textContent = "Đang đọc và gom đoạn thông minh...";
  progressBarFill.style.width = "15%";

  try {
    const rawText = await extractTextFromFile(file);
    parsedChunks = smartChunkText(rawText);
    if (!parsedChunks.length) throw new Error("Không tìm thấy văn bản (PDF scan ảnh cần OCR trước).");
    await saveToCache();
    renderAllRows(parsedChunks);
    updateProgressUI();
    const skipped = parsedChunks.filter(c => c.skip).length;
    statusLabel.textContent = `Tách được ${parsedChunks.length} đoạn (${skipped} đoạn không cần dịch). ${estimateText()}`;
    refreshStartBtn();
  } catch (err) {
    alert("Lỗi khi đọc file: " + err.message);
    statusLabel.textContent = "Lỗi đọc file.";
  }
  fileUpload.value = "";
});

async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt')) return await file.text();
  if (name.endsWith('.docx')) {
    const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return res.value;
  }
  if (name.endsWith('.pdf')) return await extractPdf(file);
  throw new Error("Định dạng không hỗ trợ!");
}

// PDF: dựa vào khoảng cách dọc để tách đoạn, lọc header/footer lặp lại
async function extractPdf(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  const freq = new Map();
  const norm = s => s.replace(/\d+/g, '#').toLowerCase();

  for (let i = 1; i <= pdf.numPages; i++) {
    statusLabel.textContent = `Đang quét trang PDF ${i}/${pdf.numPages}...`;
    const content = await (await pdf.getPage(i)).getTextContent();
    const lines = [];
    let cur = "", lastY = null, curY = null;
    for (const it of content.items) {
      if (!it.str) continue;
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (cur.trim()) lines.push({ t: cur.trim(), y: curY });
        cur = it.str; curY = y;
      } else {
        if (cur === "") curY = y;
        cur += (cur && !cur.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
      }
      lastY = y;
    }
    if (cur.trim()) lines.push({ t: cur.trim(), y: curY });
    pages.push(lines);
    new Set(lines.map(l => norm(l.t))).forEach(k => freq.set(k, (freq.get(k) || 0) + 1));
  }

  const threshold = Math.max(3, Math.ceil(pdf.numPages * 0.4));
  const isRepeated = t => t.length < 90 && freq.get(norm(t)) >= threshold;

  let out = [];
  for (const lines of pages) {
    const kept = lines.filter(l => !isRepeated(l.t));
    const gaps = [];
    for (let k = 1; k < kept.length; k++) { const g = Math.abs(kept[k - 1].y - kept[k].y); if (g > 0) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    kept.forEach((l, k) => {
      if (k > 0 && median && Math.abs(kept[k - 1].y - l.y) > median * 1.5) out.push("");
      out.push(l.t);
    });
  }
  return out.join("\n");
}

// ===== Gom đoạn =====
function needsTranslation(text) {
  if (!/\p{L}/u.test(text)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const viet = (text.match(/[ăâđêôơưĂÂĐÊÔƠƯ\u1EA0-\u1EF9]/g) || []).length;
  return !(letters > 20 && viet / letters > 0.08); // đã là tiếng Việt
}

function smartChunkText(rawText) {
  const lines = rawText.split(/\r?\n/);
  const paraMode = /\n\s*\n/.test(rawText); // có dòng trống -> dòng trống là ranh giới đoạn cứng
  const paragraphs = [];
  let buffer = "";
  const flush = () => { if (buffer) paragraphs.push(buffer); buffer = ""; };

  for (let line of lines) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) { if (paraMode) flush(); continue; }
    if (/^\d+$/.test(line)) continue;
    if (!buffer) { buffer = line; continue; }

    if (/\p{L}-$/u.test(buffer) && /^\p{Ll}/u.test(line)) { // nối từ bị ngắt bằng gạch nối
      buffer = buffer.slice(0, -1) + line;
      continue;
    }
    const endsP = /[.!?:;"”'’…)]$/.test(buffer);
    const startsLower = /^\p{Ll}/u.test(line);
    const shouldBreak = paraMode
      ? (buffer.length > MAX_CHUNK_CHARS && endsP)
      : (endsP && !startsLower && buffer.length >= 60) || (buffer.length > MAX_CHUNK_CHARS && endsP);
    if (shouldBreak) { flush(); buffer = line; } else buffer += " " + line;
  }
  flush();

  return paragraphs.filter(p => p.length > 3).map((p, idx) => {
    const need = needsTranslation(p);
    return { id: idx + 1, original: p, translated: need ? "" : p, skip: !need, tries: 0 };
  });
}

// ===== Đóng gói batch theo ký tự =====
function takeBatch(pending) {
  const batch = [], seen = new Set();
  let chars = 0;
  for (const c of pending) {
    if (seen.has(c.original)) continue; // đoạn trùng chỉ gửi một lần
    if (batch.length && (chars + c.original.length > MAX_BATCH_CHARS || batch.length >= MAX_BATCH_ITEMS)) break;
    seen.add(c.original);
    batch.push(c);
    chars += c.original.length;
  }
  return batch;
}

function isPending(c) {
  const hasKey = apiKeyInput.value.trim() !== "";
  return !c.translated || (c.demo && hasKey);
}

function estimateText() {
  const pending = parsedChunks.filter(isPending);
  if (!pending.length) return "";
  const seen = new Set();
  let reqs = 0, chars = 0, items = 0;
  for (const c of pending) {
    if (seen.has(c.original)) continue;
    seen.add(c.original);
    if (items && (chars + c.original.length > MAX_BATCH_CHARS || items >= MAX_BATCH_ITEMS)) { reqs++; chars = 0; items = 0; }
    chars += c.original.length; items++;
  }
  if (items) reqs++;
  const mins = Math.max(1, Math.round(reqs * (API_DELAY_MS / 1000 + 8) / 60));
  return `Ước tính ~${reqs} request, khoảng ${mins} phút.`;
}

// ===== Hiển thị =====
function renderAllRows(chunks) {
  readerContainer.innerHTML = "";
  const fragment = document.createDocumentFragment();
  chunks.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bilingual-row';
    row.id = `row-${item.id}`;
    const has = Boolean(item.translated);
    row.innerHTML = `
      <div class="col-original">
        <span class="row-num">#${item.id}</span>
        <div>${escapeHtml(item.original)}</div>
      </div>
      <div class="col-translated ${has ? 'done-text' : 'loading-text'}" id="trans-${item.id}" ${has ? 'contenteditable="true"' : ''} title="${has ? 'Bấm để sửa tay' : ''}">${has ? escapeHtml(item.translated) : 'Chờ dịch...'}</div>
      <button class="retry-btn" data-id="${item.id}" title="Dịch lại đoạn này">↻</button>`;
    fragment.appendChild(row);
  });
  readerContainer.appendChild(fragment);
}

// Sửa tay (blur) và dịch lại 1 đoạn
readerContainer.addEventListener('focusout', (e) => {
  const el = e.target.closest('.col-translated[contenteditable]');
  if (!el) return;
  const c = parsedChunks.find(x => x.id === Number(el.id.replace('trans-', '')));
  const txt = el.textContent.trim();
  if (c && txt && txt !== c.translated) { c.translated = txt; c.demo = false; saveToCache(); }
});
readerContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.retry-btn');
  if (!btn || isTranslating) return;
  const c = parsedChunks.find(x => x.id === Number(btn.dataset.id));
  if (!c) return;
  c.translated = ""; c.tries = 0; c.skip = false; c.demo = false;
  const el = $(`trans-${c.id}`);
  el.className = 'col-translated loading-text';
  el.removeAttribute('contenteditable');
  el.textContent = 'Chờ dịch...';
  updateProgressUI(); refreshStartBtn(); saveToCache();
  statusLabel.textContent = `Đã đánh dấu đoạn #${c.id} để dịch lại. Bấm "Dịch tiếp".`;
});

function applyResult(id, translated, extra = {}) {
  const target = parsedChunks.find(c => c.id === id);
  if (!target) return;
  const targets = [target, ...parsedChunks.filter(c => c !== target && c.original === target.original && isPending(c))];
  for (const c of targets) {
    c.translated = translated;
    Object.assign(c, extra);
    const el = $(`trans-${c.id}`);
    if (el) {
      el.className = 'col-translated done-text';
      el.setAttribute('contenteditable', 'true');
      el.textContent = translated;
    }
  }
}

function refreshStartBtn() {
  const remaining = parsedChunks.filter(isPending);
  exportWordBtn.disabled = !parsedChunks.some(c => c.translated && !c.demo && !c.skip && c.translated !== c.original) && !parsedChunks.some(c => c.demo);
  if (!remaining.length) { startBtn.textContent = "Đã hoàn tất"; startBtn.disabled = true; return; }
  const done = parsedChunks.length - remaining.length;
  startBtn.disabled = false;
  startBtn.textContent = done > parsedChunks.filter(c => c.skip).length
    ? `▶ Dịch tiếp (từ đoạn #${remaining[0].id})` : "▶ Bắt đầu dịch";
}

// ===== Điều khiển dịch =====
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

startBtn.addEventListener('click', async () => {
  if (isTranslating) return;
  isTranslating = true;
  abortCtl = new AbortController();
  fileUpload.disabled = true;
  clearCacheBtn.disabled = true;
  startBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";

  const apiKey = apiKeyInput.value.trim();
  const modelName = modelSelect.value;
  let errorMsg = null;

  try {
    while (!abortCtl.signal.aborted) {
      // Đoạn đã thử quá nhiều lần mà model vẫn bỏ sót -> giữ nguyên bản gốc
      parsedChunks.filter(c => isPending(c) && c.tries >= MAX_TRIES_PER_CHUNK)
        .forEach(c => applyResult(c.id, c.original, { failed: true }));

      const pending = parsedChunks.filter(isPending);
      if (!pending.length) break;

      const batch = takeBatch(pending);
      batch.forEach(c => c.tries = (c.tries || 0) + 1);
      const first = batch[0].id, last = batch[batch.length - 1].id;
      const ctxIds = parsedChunks.filter(c => c.id >= first - 2 && c.id < first && c.translated && !c.demo && !c.skip);
      const prevContext = ctxIds.map(c => `${c.original} -> ${c.translated}`).join("\n");

      statusLabel.textContent = `Đang dịch đoạn #${first}–#${last} (${batch.length} đoạn, ${batch.reduce((s, c) => s + c.original.length, 0)} ký tự)...`;
      const results = await translateBatch(batch, prevContext, apiKey, modelName, abortCtl.signal);
      results.forEach(r => applyResult(r.id, r.translated, { demo: !!r.demo, failed: !!r.failed }));

      await saveToCache();
      updateProgressUI();
      if (parsedChunks.some(isPending) && apiKey) await sleep(API_DELAY_MS, abortCtl.signal);
    }
  } catch (err) {
    if (err.name !== 'AbortError') errorMsg = err.message;
  }

  const wasAborted = abortCtl.signal.aborted;
  isTranslating = false;
  fileUpload.disabled = false;
  clearCacheBtn.disabled = false;
  pauseBtn.style.display = "none";
  startBtn.style.display = "inline-block";
  updateProgressUI();
  refreshStartBtn();
  await saveToCache();

  const failed = parsedChunks.filter(c => c.failed).length;
  if (errorMsg) statusLabel.textContent = `Tạm dừng do lỗi: ${errorMsg}. Tiến độ đã lưu, bấm "Dịch tiếp" để thử lại.`;
  else if (wasAborted) statusLabel.textContent = `Đã tạm dừng. Đã lưu bộ nhớ tạm! ${estimateText()}`;
  else if (!parsedChunks.some(isPending)) {
    statusLabel.textContent = parsedChunks.some(c => c.demo)
      ? "Đã chạy xong bản Demo (chưa dịch thật). Nhập API Key rồi bấm dịch để dịch thật."
      : `🎉 Đã dịch xong toàn bộ tài liệu!${failed ? ` (${failed} đoạn không dịch được, giữ nguyên bản gốc — bấm ↻ để thử lại)` : ""}`;
  }
});

pauseBtn.addEventListener('click', () => {
  abortCtl?.abort(); // dừng ngay cả khi đang chờ request
  statusLabel.textContent = "Đang tạm dừng...";
});

clearCacheBtn.addEventListener('click', async () => {
  if (!confirm("Bạn có chắc muốn xóa tiến độ đã lưu để làm mới hoàn toàn?")) return;
  await idb.del(DB_KEY).catch(() => {});
  parsedChunks = [];
  readerContainer.innerHTML = `<div class="empty-state"><h3>Đã xóa bộ nhớ tạm</h3><p>Hãy chọn lại file mới để bắt đầu.</p></div>`;
  progressSection.style.display = "none";
  fileNameDisplay.textContent = "Chưa chọn file";
  startBtn.disabled = true;
  exportWordBtn.disabled = true;
});

// ===== Gọi API =====
function parseGlossary() {
  return glossaryInput.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join("\n");
}

async function translateBatch(batch, prevContext, apiKey, modelName, signal) {
  if (!apiKey) { // Demo: đánh dấu demo, không bao giờ lưu như bản dịch thật
    await sleep(150, signal);
    return batch.map(c => ({ id: c.id, translated: `[Demo #${c.id}] ${c.original}`, demo: true }));
  }
  const r = await callGemini(batch, prevContext, apiKey, modelName, signal);

  if (r.items) {
    const ids = new Set(batch.map(c => c.id));
    const valid = r.items.filter(x => ids.has(Number(x.id)) && typeof x.translated === 'string' && x.translated.trim())
      .map(x => ({ id: Number(x.id), translated: x.translated.trim() }));
    if (valid.length) return valid; // đoạn bị sót sẽ được dịch lại ở vòng sau
  }
  // Bị chặn / bị cắt (MAX_TOKENS) / JSON hỏng / rỗng -> chia đôi batch rồi thử lại
  if (batch.length > 1) {
    const mid = Math.ceil(batch.length / 2);
    const a = await translateBatch(batch.slice(0, mid), prevContext, apiKey, modelName, signal);
    await sleep(API_DELAY_MS, signal);
    const b = await translateBatch(batch.slice(mid), prevContext, apiKey, modelName, signal);
    return a.concat(b);
  }
  if (r.blocked) return [{ id: batch[0].id, translated: batch[0].original, failed: true }];
  throw new Error(`Đoạn #${batch[0].id} quá dài hoặc phản hồi không hợp lệ.`);
}

async function callGemini(batch, prevContext, apiKey, modelName, signal) {
  const glossary = parseGlossary();
  const system = `Bạn là dịch giả chuyên nghiệp. Dịch các đoạn văn sang tiếng Việt tự nhiên, mạch lạc, giữ đúng văn phong sách/tài liệu. Giữ nguyên số phần tử và mã id, mỗi đoạn dịch riêng, không gộp, không bỏ sót.` +
    (glossary ? `\nBẢNG THUẬT NGỮ (bắt buộc dùng thống nhất, dạng "gốc = dịch"):\n${glossary}` : "");
  const userText = (prevContext ? `Ngữ cảnh đoạn trước (chỉ tham khảo để thống nhất xưng hô và tên riêng, KHÔNG dịch lại):\n${prevContext}\n\n` : "") +
    `Dịch các đoạn sau:\n${JSON.stringify(batch.map(b => ({ id: b.id, text: b.original })))}`;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: { type: "OBJECT", properties: { id: { type: "INTEGER" }, translated: { type: "STRING" } }, required: ["id", "translated"] }
      },
      temperature: 0.3,
      maxOutputTokens: 16384
    }
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}/models/${modelName}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body
      });
    } catch (e) { // lỗi mạng
      if (e.name === 'AbortError') throw e;
      if (attempt === MAX_RETRIES) throw new Error("Lỗi mạng: " + e.message);
      statusLabel.textContent = `⚠️ Mạng chập chờn, đang thử lại lần ${attempt}/${MAX_RETRIES}...`;
      await sleep(3000, signal);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const errData = await res.json().catch(() => ({}));
      const raw = JSON.stringify(errData);
      if (/per ?day|PerDay/i.test(raw)) throw new Error("Đã hết quota theo NGÀY của API Free. Hãy đợi sang ngày mới hoặc đổi model/key.");
      if (attempt === MAX_RETRIES) throw new Error(errData.error?.message || `HTTP ${res.status}`);
      const m = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      const waitSec = Math.min(90, m ? Math.ceil(Number(m[1])) + 1 : attempt * 10);
      for (let s = waitSec; s > 0; s--) {
        statusLabel.textContent = `⏳ ${res.status === 429 ? 'Chạm giới hạn tốc độ' : 'Server bận'}. Tự động chờ ${s} giây (lần thử ${attempt}/${MAX_RETRIES})...`;
        await sleep(1000, signal);
      }
      continue;
    }

    if (!res.ok) { // 400/403/404...: sai key/model, thử lại cũng vô ích
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const cand = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || !cand?.content?.parts?.length) return { blocked: true };
    if (cand.finishReason === 'MAX_TOKENS') return { truncated: true };
    try {
      const text = cand.content.parts.map(p => p.text || "").join("").replace(/```json|```/g, '').trim();
      const items = JSON.parse(text);
      return Array.isArray(items) ? { items } : { truncated: true };
    } catch (e) { return { truncated: true }; }
  }
}

// ===== Xuất file kiểu sách (Word .doc) =====
const exportMode = $('exportMode');

exportWordBtn.addEventListener('click', () => {
  if (!parsedChunks.length) return;
  if (parsedChunks.some(c => c.demo) && !confirm("Có đoạn mới chỉ là bản Demo (chưa dịch thật). Vẫn xuất?")) return;
  const mode = exportMode.value;
  const title = escapeHtml(currentFileName.replace(/\.[^/.]+$/, ""));
  let body = "";

  if (mode === 'columns') {
    body = `<table style="width:100%; border-collapse:collapse;">` + parsedChunks.map(c => `<tr>
      <td style="width:50%; padding:6pt; border:0.5pt solid #999; vertical-align:top;">${escapeHtml(c.original)}</td>
      <td style="width:50%; padding:6pt; border:0.5pt solid #999; vertical-align:top;">${escapeHtml(c.translated || "")}</td></tr>`).join("") + `</table>`;
  } else if (mode === 'translation') {
    body = parsedChunks.map(c => `<p class="tran">${escapeHtml(c.translated || c.original)}</p>`).join("\n");
  } else {
    body = parsedChunks.map(c => c.skip || c.translated === c.original
      ? `<p class="tran">${escapeHtml(c.original)}</p>`
      : `<p class="orig">${escapeHtml(c.original)}</p><p class="tran">${escapeHtml(c.translated || "")}</p>`).join("\n");
  }

  const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset="utf-8"><title>${title}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page Section1 { size: 21cm 29.7cm; margin: 2.5cm 2.2cm 2.5cm 2.2cm; }
  div.Section1 { page: Section1; }
  body { font-family: 'Times New Roman', serif; font-size: 13pt; }
  p { margin: 0 0 8pt 0; line-height: 150%; text-align: justify; }
  p.tran { text-indent: 1cm; }
  p.orig { font-size: 10.5pt; font-style: italic; color: #666666; text-indent: 1cm; margin-bottom: 3pt; line-height: 130%; }
  h1.book { font-size: 28pt; text-align: center; margin-top: 8cm; }
  p.sub { text-align: center; color: #666666; font-size: 12pt; text-indent: 0; }
</style></head>
<body><div class="Section1">
  <div style="page-break-after:always;">
    <h1 class="book">${title}</h1>
    <p class="sub">${mode === 'translation' ? 'Bản dịch tiếng Việt' : mode === 'columns' ? 'Bản đối chiếu song ngữ' : 'Bản song ngữ'}</p>
  </div>
  ${body}
</div></body></html>`;

  const url = URL.createObjectURL(new Blob(['\ufeff', wordHtml], { type: 'application/msword' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${mode === 'translation' ? 'Ban_Dich' : 'Song_Ngu'}_${currentFileName.replace(/\.[^/.]+$/, "")}.doc`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ===== Tiện ích =====
function updateProgressUI() {
  const total = parsedChunks.length;
  const done = parsedChunks.filter(c => c.translated && !c.demo).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBarFill.style.width = `${percent}%`;
  percentLabel.textContent = `${percent}% (${done}/${total} đoạn)`;
  exportWordBtn.disabled = !parsedChunks.some(c => c.translated);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

sideBySideBtn.addEventListener('click', () => {
  sideBySideBtn.classList.add('active'); interlinearBtn.classList.remove('active');
  readerContainer.className = 'reader-container mode-grid';
});
interlinearBtn.addEventListener('click', () => {
  interlinearBtn.classList.add('active'); sideBySideBtn.classList.remove('active');
  readerContainer.className = 'reader-container mode-interlinear';
});
