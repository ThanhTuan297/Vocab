if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// Cấu hình thông số tối ưu
const CHUNK_BATCH_SIZE = 15; // Gom 15 đoạn mỗi lần gọi API
const API_DELAY_MS = 4000;   // Nghỉ 4 giây giữa các lần gọi (An toàn tuyệt đối cho gói Free 15 RPM)
const STORAGE_KEY = 'BILINGUAL_PRO_CACHE_V1';

let parsedChunks = [];
let currentFileName = "";
let isTranslating = false;
let isPaused = false;

// DOM Elements
const fileUpload = document.getElementById('fileUpload');
const fileNameDisplay = document.getElementById('fileNameDisplay');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');
const exportWordBtn = document.getElementById('exportWordBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const modelSelect = document.getElementById('modelSelect');
const readerContainer = document.getElementById('readerContainer');
const progressSection = document.getElementById('progressSection');
const progressBarFill = document.getElementById('progressBarFill');
const statusLabel = document.getElementById('statusLabel');
const percentLabel = document.getElementById('percentLabel');
const sideBySideBtn = document.getElementById('sideBySideBtn');
const interlinearBtn = document.getElementById('interlinearBtn');

// 1. KHÔI PHỤC DỮ LIỆU TỰ ĐỘNG KHI MỞ WEB / F5
window.addEventListener('DOMContentLoaded', () => {
  const savedKey = localStorage.getItem('BILINGUAL_API_KEY');
  if (savedKey) apiKeyInput.value = savedKey;

  const savedSession = localStorage.getItem(STORAGE_KEY);
  if (savedSession) {
    try {
      const data = JSON.parse(savedSession);
      if (data.chunks && data.chunks.length > 0) {
        parsedChunks = data.chunks;
        currentFileName = data.fileName || "Tai_lieu_da_luu";
        fileNameDisplay.textContent = currentFileName;
        progressSection.style.display = "block";
        renderAllRows(parsedChunks);
        updateProgressUI();
        startBtn.disabled = false;
        exportWordBtn.disabled = false;

        const doneCount = parsedChunks.filter(c => c.translated).length;
        if (doneCount > 0 && doneCount < parsedChunks.length) {
          startBtn.textContent = `▶ Dịch tiếp (từ đoạn ${doneCount + 1})`;
          statusLabel.textContent = `Đã khôi phục phiên làm việc trước (${doneCount}/${parsedChunks.length} đoạn).`;
        } else if (doneCount === parsedChunks.length) {
          statusLabel.textContent = "Tài liệu đã được dịch hoàn tất 100%!";
        }
      }
    } catch (e) {
      console.error("Không thể đọc cache:", e);
    }
  }
});

// Lưu API Key khi người dùng nhập
apiKeyInput.addEventListener('input', () => {
  localStorage.setItem('BILINGUAL_API_KEY', apiKeyInput.value.trim());
});

// 2. XỬ LÝ TẢI FILE LÊN
fileUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

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

    saveToCache();
    renderAllRows(parsedChunks);
    updateProgressUI();

    statusLabel.textContent = `Đã tách thành công ${parsedChunks.length} đoạn văn chuẩn. Sẵn sàng dịch!`;
    startBtn.textContent = "▶ Bắt đầu dịch";
    startBtn.disabled = false;
    exportWordBtn.disabled = false;
  } catch (err) {
    alert("Lỗi khi đọc file: " + err.message);
    statusLabel.textContent = "Lỗi đọc file.";
  }
});

// 3. ĐỌC FILE ĐA ĐỊNH DẠNG (CẢI TIẾN ĐỌC PDF)
async function extractTextFromFile(file) {
  if (file.name.endsWith('.txt')) {
    return await file.text();
  }
  if (file.name.endsWith('.docx')) {
    const buffer = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer: buffer });
    return res.value;
  }
  if (file.name.endsWith('.pdf')) {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      statusLabel.textContent = `Đang quét trang PDF ${i}/${pdf.numPages}...`;
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      
      let lastY = null;
      let pageLines = [];
      let currentLine = "";

      for (const item of content.items) {
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
          pageLines.push(currentLine.trim());
          currentLine = item.str;
        } else {
          currentLine += (currentLine ? " " : "") + item.str;
        }
        lastY = item.transform[5];
      }
      if (currentLine.trim()) pageLines.push(currentLine.trim());
      fullText += pageLines.join("\n") + "\n\n";
    }
    return fullText;
  }
  throw new Error("Định dạng không hỗ trợ!");
}

// 4. THUẬT TOÁN GOM ĐOẠN THÔNG MINH (CHỐNG ĐỨT CÂU PDF)
function smartChunkText(rawText) {
  const lines = rawText.split(/\r?\n/);
  const paragraphs = [];
  let buffer = "";

  for (let line of lines) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) {
      if (buffer) {
        paragraphs.push(buffer);
        buffer = "";
      }
      continue;
    }
    // Bỏ qua số trang đơn lẻ
    if (/^\d+$/.test(line)) continue;

    if (!buffer) {
      buffer = line;
    } else {
      // Nếu dòng trước chưa kết thúc câu và dòng sau không viết hoa đầu câu -> nối liền
      const endsWithPunctuation = /[.!?:;"”']$/.test(buffer);
      if (!endsWithPunctuation || buffer.length < 60) {
        buffer += " " + line;
      } else {
        paragraphs.push(buffer);
        buffer = line;
      }
    }
  }
  if (buffer) paragraphs.push(buffer);

  return paragraphs
    .filter(p => p.length > 3)
    .map((p, idx) => ({
      id: idx + 1,
      original: p,
      translated: ""
    }));
}

// 5. HIỂN THỊ GIAO DIỆN
function renderAllRows(chunks) {
  readerContainer.innerHTML = "";
  const fragment = document.createDocumentFragment();

  chunks.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bilingual-row';
    row.id = `row-${item.id}`;
    const hasTrans = Boolean(item.translated);

    row.innerHTML = `
      <div class="col-original">
        <span class="row-num">#${item.id}</span>
        <div>${escapeHtml(item.original)}</div>
      </div>
      <div class="col-translated ${hasTrans ? 'done-text' : 'loading-text'}" id="trans-${item.id}">
        ${hasTrans ? escapeHtml(item.translated) : 'Chờ dịch...'}
      </div>
    `;
    fragment.appendChild(row);
  });

  readerContainer.appendChild(fragment);
}

// 6. ĐIỀU KHIỂN DỊCH / TẠM DỪNG / TIẾP TỤC
startBtn.addEventListener('click', async () => {
  if (isTranslating) return;
  isTranslating = true;
  isPaused = false;
  startBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";

  const apiKey = apiKeyInput.value.trim();
  const modelName = modelSelect.value;

  // Lọc ra các đoạn CHƯA DỊCH để dịch tiếp
  const pendingChunks = parsedChunks.filter(c => !c.translated);

  for (let i = 0; i < pendingChunks.length; i += CHUNK_BATCH_SIZE) {
    if (isPaused) break;

    const batch = pendingChunks.slice(i, i + CHUNK_BATCH_SIZE);
    const firstId = batch[0].id;
    const lastId = batch[batch.length - 1].id;

    // Lấy 2 đoạn phía trước làm ngữ cảnh (Sliding Context)
    const prevContext = parsedChunks
      .filter(c => c.id >= firstId - 2 && c.id < firstId && c.translated)
      .map(c => `${c.original} -> ${c.translated}`)
      .join("\n");

    statusLabel.textContent = `Đang dịch đoạn #${firstId} đến #${lastId}...`;

    try {
      const results = await translateWithRetry(batch, prevContext, apiKey, modelName);

      // Cập nhật dữ liệu và giao diện
      results.forEach(res => {
        const target = parsedChunks.find(c => c.id === res.id);
        if (target) {
          target.translated = res.translated;
          const el = document.getElementById(`trans-${res.id}`);
          if (el) {
            el.className = 'col-translated done-text';
            el.textContent = res.translated;
          }
        }
      });

      saveToCache();
      updateProgressUI();

      // Nghỉ giữa các đợt gọi nếu còn đoạn tiếp theo
      if (i + CHUNK_BATCH_SIZE < pendingChunks.length && !isPaused) {
        const delay = apiKey ? API_DELAY_MS : 250;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      statusLabel.textContent = `Tạm dừng do lỗi: ${err.message}. Bấm 'Dịch tiếp' để thử lại.`;
      isPaused = true;
      break;
    }
  }

  isTranslating = false;
  pauseBtn.style.display = "none";
  startBtn.style.display = "inline-block";

  const remaining = parsedChunks.filter(c => !c.translated).length;
  if (remaining === 0) {
    statusLabel.textContent = "🎉 Đã dịch hoàn tất toàn bộ tài liệu!";
    startBtn.textContent = "Đã hoàn tất";
    startBtn.disabled = true;
  } else {
    const nextId = parsedChunks.find(c => !c.translated).id;
    startBtn.textContent = `▶ Dịch tiếp (từ đoạn #${nextId})`;
    if (isPaused) statusLabel.textContent = `Đã tạm dừng tại đoạn #${nextId}. Đã lưu bộ nhớ tạm!`;
  }
});

pauseBtn.addEventListener('click', () => {
  isPaused = true;
  statusLabel.textContent = "Đang chờ hoàn tất cụm hiện tại để tạm dừng...";
});

clearCacheBtn.addEventListener('click', () => {
  if (!confirm("Bạn có chắc muốn xóa tiến độ đã lưu để làm mới hoàn toàn?")) return;
  localStorage.removeItem(STORAGE_KEY);
  parsedChunks = [];
  readerContainer.innerHTML = `<div class="empty-state"><h3>Đã xóa bộ nhớ tạm</h3><p>Hãy chọn lại file mới để bắt đầu.</p></div>`;
  progressSection.style.display = "none";
  fileNameDisplay.textContent = "Chưa chọn file";
  startBtn.disabled = true;
  exportWordBtn.disabled = true;
});

// 7. GỌI API KÈM CƠ CHẾ TỰ ĐỘNG THỬ LẠI (AUTO-RETRY CHỐNG LỖI 429)
async function translateWithRetry(batch, prevContext, apiKey, modelName, maxRetries = 4) {
  if (!apiKey) {
    await new Promise(r => setTimeout(r, 300));
    return batch.map(item => ({
      id: item.id,
      translated: `[Bản dịch Demo #${item.id}] ${item.original}`
    }));
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const contextInstruction = prevContext
        ? `Ngữ cảnh đoạn trước đó (chỉ tham khảo để thống nhất xưng hô, KHÔNG dịch lại):\n${prevContext}\n\n`
        : "";

      const prompt = `${contextInstruction}Hãy dịch danh sách các đoạn văn sau sang tiếng Việt một cách tự nhiên, mạch lạc, giữ đúng văn phong sách/tài liệu.
BẮT BUỘC trả về đúng định dạng JSON Array gồm các object có cấu trúc: [{"id": number, "translated": "bản dịch tiếng Việt"}]. Giữ nguyên tuyệt đối số lượng phần tử và mã id:\n${JSON.stringify(batch.map(b => ({ id: b.id, text: b.original })))}`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3
          }
        })
      });

      if (res.status === 429) {
        const waitSec = attempt * 10;
        for (let s = waitSec; s > 0; s--) {
          statusLabel.textContent = `⏳ Chạm giới hạn tốc độ API Free. Tự động chờ ${s} giây rồi dịch tiếp (Lần thử ${attempt}/${maxRetries})...`;
          await new Promise(r => setTimeout(r, 1000));
        }
        continue;
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const rawText = data.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
      return JSON.parse(rawText);

    } catch (err) {
      if (attempt === maxRetries) throw err;
      statusLabel.textContent = `⚠️ Mạng chập chờn, đang thử lại lần ${attempt}/${maxRetries}...`;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// 8. XUẤT FILE WORD (.DOC) BẢNG 2 CỘT ĐỐI CHIẾU
exportWordBtn.addEventListener('click', () => {
  if (!parsedChunks.length) return;

  const isSideBySide = readerContainer.classList.contains('mode-grid');
  let tableRows = "";

  if (isSideBySide) {
    tableRows = parsedChunks.map(c => `
      <tr>
        <td style="width:50%; padding:8pt; border:1pt solid #cbd5e1; vertical-align:top;">${escapeHtml(c.original)}</td>
        <td style="width:50%; padding:8pt; border:1pt solid #cbd5e1; vertical-align:top;">${escapeHtml(c.translated || "")}</td>
      </tr>
    `).join("");
  } else {
    tableRows = parsedChunks.map(c => `
      <tr>
        <td style="padding:8pt; border:1pt solid #cbd5e1;">
          <p style="margin:0 0 6pt 0; font-weight:bold;">${escapeHtml(c.original)}</p>
          <p style="margin:0; color:#0f766e;">${escapeHtml(c.translated || "")}</p>
        </td>
      </tr>
    `).join("");
  }

  const wordHtml = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset="utf-8"><title>${currentFileName}</title></head>
    <body style="font-family:'Times New Roman', serif; font-size:12pt;">
      <h2 style="text-align:center;">TÀI LIỆU SONG NGỮ: ${escapeHtml(currentFileName)}</h2>
      <table style="width:100%; border-collapse:collapse; margin-top:12pt;">
        ${tableRows}
      </table>
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', wordHtml], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Song_Ngu_${currentFileName.replace(/\.[^/.]+$/, "")}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// TIỆN ÍCH PHỤ TRỢ
function updateProgressUI() {
  const total = parsedChunks.length;
  const done = parsedChunks.filter(c => c.translated).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressBarFill.style.width = `${percent}%`;
  percentLabel.textContent = `${percent}% (${done}/${total} đoạn)`;
}

function saveToCache() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fileName: currentFileName,
      chunks: parsedChunks
    }));
  } catch (e) {
    console.warn("Bộ nhớ trình duyệt đã đầy, không thể lưu thêm vào cache.");
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

sideBySideBtn.addEventListener('click', () => {
  sideBySideBtn.classList.add('active');
  interlinearBtn.classList.remove('active');
  readerContainer.className = 'reader-container mode-grid';
});

interlinearBtn.addEventListener('click', () => {
  interlinearBtn.classList.add('active');
  sideBySideBtn.classList.remove('active');
  readerContainer.className = 'reader-container mode-interlinear';
});
