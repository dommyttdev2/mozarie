const $ = (selector) => document.querySelector(selector);

const state = {
  images: [],
  selectedIds: new Set(),
  currentId: null,
  currentImage: null,
  candidates: [],
  candidateImages: new Map(),
  drafts: new Map(),
  tool: "brush",
  spacePressed: false,
  panning: false,
  drawing: false,
  pointer: null,
  history: [],
  historyIndex: -1,
  view: { scale: 1, x: 0, y: 0 },
  job: null,
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const eraseCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const eraseCtx = eraseCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const layerCtx = layerCanvas.getContext("2d");
let renderedWidth = 0;
let renderedHeight = 0;

function api(path, options = {}) {
  return fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "処理に失敗しました。");
    return data;
  });
}

function setStatus(message, kind = "") {
  const element = $("#status");
  element.textContent = message;
  element.className = `status ${kind}`;
}

function currentRecord() {
  return state.images.find((image) => image.id === state.currentId) || null;
}

function selectedOrAll() {
  return state.selectedIds.size ? [...state.selectedIds] : state.images.map((image) => image.id);
}

async function loadFolder() {
  const path = $("#folderPath").value.trim();
  if (!path) return setStatus("Windowsフォルダを入力してください。", "error");
  setStatus("画像を読み込んでいます...", "running");
  try {
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    state.images = data.images;
    state.selectedIds.clear();
    state.currentId = null;
    state.currentImage = null;
    state.candidates = [];
    state.candidateImages.clear();
    state.drafts.clear();
    renderGallery();
    clearEditor();
    setStatus(`${state.images.length}件を読み込みました`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderGallery() {
  const gallery = $("#gallery");
  gallery.textContent = "";
  $("#imageCount").textContent = `${state.images.length}件`;
  const template = $("#galleryItemTemplate");
  for (const image of state.images) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    const checkbox = item.querySelector("input");
    checkbox.checked = state.selectedIds.has(image.id);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      checkbox.checked ? state.selectedIds.add(image.id) : state.selectedIds.delete(image.id);
      updateSelectAllButton();
    });
    const preview = item.querySelector("img");
    preview.src = `/api/thumbnail/${encodeURIComponent(image.id)}`;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / 候補 ${image.candidateCount}` : ""}`;
    item.addEventListener("click", () => selectImage(image.id));
    gallery.append(item);
  }
  updateSelectAllButton();
}

function updateSelectAllButton() {
  const allSelected = state.images.length > 0 && state.selectedIds.size === state.images.length;
  $("#selectAllButton").textContent = allSelected ? "全解除" : "全選択";
}

function canvasSizeForImage(image) {
  for (const target of [addCanvas, eraseCanvas, combinedCanvas]) {
    target.width = image.width;
    target.height = image.height;
  }
  addCtx.clearRect(0, 0, image.width, image.height);
  eraseCtx.clearRect(0, 0, image.width, image.height);
}

function clearEditor() {
  state.history = [];
  state.historyIndex = -1;
  addCanvas.width = eraseCanvas.width = combinedCanvas.width = 1;
  addCanvas.height = eraseCanvas.height = combinedCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#saveButton").disabled = true;
  $("#imageInfo").textContent = "画像未選択";
  $("#candidateStatus").textContent = "画像を選択してください";
  renderCandidates();
  render();
}

async function selectImage(imageId, force = false) {
  if (state.currentId === imageId && !force) return;
  saveDraft();
  state.currentId = imageId;
  const record = currentRecord();
  renderGallery();
  setStatus("画像を読み込んでいます...", "running");
  try {
    const [image, candidateData] = await Promise.all([
      loadImage(`/api/image/${encodeURIComponent(imageId)}?t=${Date.now()}`),
      api(`/api/candidates/${encodeURIComponent(imageId)}`),
    ]);
    state.currentImage = image;
    state.candidates = candidateData.candidates;
    state.candidateImages.clear();
    await Promise.all(state.candidates.map(async (candidate) => {
      const mask = await loadImage(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?t=${Date.now()}`);
      state.candidateImages.set(candidate.id, mask);
    }));
    canvasSizeForImage(record);
    restoreDraft(imageId);
    fitImage();
    $("#blockSize").value = Math.max(4, Math.ceil(Math.max(record.width, record.height) / 100));
    $("#emptyState").hidden = true;
    $("#saveButton").disabled = false;
    $("#imageInfo").textContent = `${record.relativePath} / ${record.width} x ${record.height}`;
    $("#candidateStatus").textContent = state.candidates.length ? `${state.candidates.length}件の候補` : "候補はありません";
    renderCandidates();
    setStatus("編集できます");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めません。"));
    image.src = source;
  });
}

function saveDraft() {
  if (!state.currentId || !state.currentImage) return;
  state.drafts.set(state.currentId, {
    add: addCanvas.toDataURL("image/png"),
    erase: eraseCanvas.toDataURL("image/png"),
  });
}

function restoreDraft(imageId) {
  const draft = state.drafts.get(imageId);
  state.history = [];
  state.historyIndex = -1;
  if (!draft) {
    pushHistory();
    return;
  }
  Promise.all([loadImage(draft.add), loadImage(draft.erase)]).then(([addImage, eraseImage]) => {
    addCtx.drawImage(addImage, 0, 0);
    eraseCtx.drawImage(eraseImage, 0, 0);
    pushHistory();
    render();
  });
}

function fitImage() {
  if (!state.currentImage) return;
  const padding = 28;
  const width = Math.max(1, stage.clientWidth - padding * 2);
  const height = Math.max(1, stage.clientHeight - padding * 2);
  state.view.scale = Math.min(width / state.currentImage.width, height / state.currentImage.height);
  state.view.x = (stage.clientWidth - state.currentImage.width * state.view.scale) / 2;
  state.view.y = (stage.clientHeight - state.currentImage.height * state.view.scale) / 2;
  render();
}

function resizeRenderCanvas() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (renderedWidth === width && renderedHeight === height && canvas.width === Math.round(width * dpr)) return;
  renderedWidth = width;
  renderedHeight = height;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  layerCanvas.width = canvas.width;
  layerCanvas.height = canvas.height;
  render();
}

function setCssTransform(context) {
  const dpr = window.devicePixelRatio || 1;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function paintMask(maskImage, color, alpha) {
  if (!maskImage || !state.currentImage) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  setCssTransform(layerCtx);
  layerCtx.clearRect(0, 0, width, height);
  layerCtx.save();
  layerCtx.translate(state.view.x, state.view.y);
  layerCtx.scale(state.view.scale, state.view.scale);
  layerCtx.drawImage(maskImage, 0, 0, state.currentImage.width, state.currentImage.height);
  layerCtx.globalCompositeOperation = "source-in";
  layerCtx.fillStyle = color;
  layerCtx.fillRect(0, 0, state.currentImage.width, state.currentImage.height);
  layerCtx.restore();
  setCssTransform(ctx);
  ctx.globalAlpha = alpha;
  ctx.drawImage(layerCanvas, 0, 0, width, height);
  ctx.globalAlpha = 1;
}

function render() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  setCssTransform(ctx);
  ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) return;
  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.scale, state.view.scale);
  ctx.drawImage(state.currentImage, 0, 0);
  ctx.restore();

  const pulse = 0.36 + (Math.sin(Date.now() / 440) + 1) * 0.12;
  for (const candidate of state.candidates) {
    if (candidate.enabled) paintMask(state.candidateImages.get(candidate.id), candidate.color, pulse);
  }
  paintMask(addCanvas, "#58d7be", 0.40);
  paintMask(eraseCanvas, "#f17373", 0.27);
}

function renderCandidates() {
  const list = $("#candidateList");
  list.textContent = "";
  if (!state.currentId) return;
  if (!state.candidates.length) {
    const empty = document.createElement("p");
    empty.className = "candidate-empty";
    empty.textContent = "自動検出の候補はまだありません。";
    list.append(empty);
    return;
  }
  for (const candidate of state.candidates) {
    const row = document.createElement("label");
    row.className = "candidate-row";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = candidate.enabled;
    enabled.addEventListener("change", async () => {
      candidate.enabled = enabled.checked;
      render();
      await updateCandidate(candidate);
    });
    const color = document.createElement("input");
    color.type = "color";
    color.value = candidate.color;
    color.title = "候補表示色";
    color.addEventListener("input", () => { candidate.color = color.value; render(); });
    color.addEventListener("change", () => updateCandidate(candidate));
    const label = document.createElement("span");
    label.className = "candidate-label";
    label.innerHTML = `<span class="candidate-class">${escapeHtml(candidate.className)}</span><span class="candidate-conf">${Math.round(candidate.confidence * 100)}%</span>`;
    row.append(enabled, color, label);
    list.append(row);
  }
}

async function updateCandidate(candidate) {
  try {
    await api(`/api/candidate/${encodeURIComponent(state.currentId)}/${encodeURIComponent(candidate.id)}`, {
      method: "POST",
      body: JSON.stringify({ enabled: candidate.enabled, color: candidate.color }),
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function pointFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.x) / state.view.scale,
    y: (event.clientY - rect.top - state.view.y) / state.view.scale,
  };
}

function snapshot() {
  return { add: addCanvas.toDataURL("image/png"), erase: eraseCanvas.toDataURL("image/png") };
}

function pushHistory() {
  if (!state.currentImage) return;
  state.history.splice(state.historyIndex + 1);
  state.history.push(snapshot());
  if (state.history.length > 20) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("#undoButton").disabled = state.historyIndex <= 0;
  $("#redoButton").disabled = state.historyIndex >= state.history.length - 1;
}

async function restoreSnapshot(index) {
  const entry = state.history[index];
  if (!entry) return;
  const [addImage, eraseImage] = await Promise.all([loadImage(entry.add), loadImage(entry.erase)]);
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  eraseCtx.clearRect(0, 0, eraseCanvas.width, eraseCanvas.height);
  addCtx.drawImage(addImage, 0, 0);
  eraseCtx.drawImage(eraseImage, 0, 0);
  state.historyIndex = index;
  updateHistoryButtons();
  render();
}

function drawStroke(from, to, erase) {
  const target = erase ? eraseCtx : addCtx;
  const opposite = erase ? addCtx : eraseCtx;
  const size = Number($("#brushSize").value);
  opposite.save();
  opposite.globalCompositeOperation = "destination-out";
  opposite.lineWidth = size;
  opposite.lineCap = "round";
  opposite.beginPath();
  opposite.moveTo(from.x, from.y);
  opposite.lineTo(to.x, to.y);
  opposite.stroke();
  opposite.restore();
  target.save();
  target.globalCompositeOperation = "source-over";
  target.strokeStyle = "#ffffff";
  target.lineWidth = size;
  target.lineCap = "round";
  target.beginPath();
  target.moveTo(from.x, from.y);
  target.lineTo(to.x, to.y);
  target.stroke();
  target.restore();
  render();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  combinedCanvas.width = state.currentImage.width;
  combinedCanvas.height = state.currentImage.height;
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  combinedCtx.globalCompositeOperation = "source-over";
  for (const candidate of state.candidates) {
    if (candidate.enabled) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  combinedCtx.drawImage(eraseCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  return combinedCanvas.toDataURL("image/png");
}

async function saveCurrent() {
  if (!state.currentId || !state.currentImage) return;
  const button = $("#saveButton");
  button.disabled = true;
  setStatus("保存しています...", "running");
  try {
    await api(`/api/images/${encodeURIComponent(state.currentId)}/save`, {
      method: "POST",
      body: JSON.stringify({ mask: buildCombinedMask(), blockSize: Number($("#blockSize").value) }),
    });
    state.drafts.delete(state.currentId);
    addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
    eraseCtx.clearRect(0, 0, eraseCanvas.width, eraseCanvas.height);
    state.history = [];
    state.historyIndex = -1;
    state.currentImage = await loadImage(`/api/image/${encodeURIComponent(state.currentId)}?t=${Date.now()}`);
    render();
    setStatus("保存しました。PNGメタデータも検証済みです。");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
    updateHistoryButtons();
  }
}

async function runDetection() {
  if (!state.images.length) return;
  try {
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds: selectedOrAll() }) });
    setStatus("自動検出を開始しました", "running");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function applyDetection() {
  if (!state.images.length) return;
  try {
    await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({ imageIds: selectedOrAll(), blockSize: Number($("#blockSize").value) }),
    });
    setStatus("検出候補を一括適用しています", "running");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function pollJob() {
  try {
    const job = await api("/api/job");
    const previous = state.job;
    state.job = job;
    if (job.state === "running") {
      setStatus(`${job.kind === "detect" ? "自動検出" : "一括適用"} ${job.completed} / ${job.total} ${job.current}`, "running");
    } else if (job.state === "complete" && previous?.state === "running") {
      setStatus(job.kind === "detect" ? "自動検出が完了しました" : "一括適用が完了しました");
      const keepCurrent = state.currentId;
      const data = await api("/api/images");
      state.images = data.images;
      renderGallery();
      if (keepCurrent) await selectImage(keepCurrent, true);
    } else if (job.state === "error" && previous?.state === "running") {
      setStatus(job.error || "バックグラウンド処理に失敗しました。", "error");
    }
  } catch {
    // The server may be shutting down. Avoid replacing a useful UI message.
  }
}

$("#loadFolder").addEventListener("click", loadFolder);
$("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
$("#detectButton").addEventListener("click", runDetection);
$("#applyButton").addEventListener("click", applyDetection);
$("#saveButton").addEventListener("click", saveCurrent);
$("#fitButton").addEventListener("click", fitImage);
$("#selectAllButton").addEventListener("click", () => {
  if (state.selectedIds.size === state.images.length) state.selectedIds.clear();
  else state.images.forEach((image) => state.selectedIds.add(image.id));
  renderGallery();
});
$("#brushTool").addEventListener("click", () => setTool("brush"));
$("#eraserTool").addEventListener("click", () => setTool("eraser"));
$("#brushSize").addEventListener("input", () => { $("#brushSizeValue").textContent = $("#brushSize").value; });
$("#undoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex - 1));
$("#redoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex + 1));

function setTool(tool) {
  state.tool = tool;
  $("#brushTool").classList.toggle("active", tool === "brush");
  $("#eraserTool").classList.toggle("active", tool === "eraser");
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
}

canvas.addEventListener("pointerdown", (event) => {
  if (!state.currentImage) return;
  canvas.setPointerCapture(event.pointerId);
  if (state.spacePressed || event.button === 1) {
    state.panning = true;
    state.pointer = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = "grabbing";
    return;
  }
  state.drawing = true;
  state.pointer = pointFromEvent(event);
  drawStroke(state.pointer, state.pointer, state.tool === "eraser");
});
canvas.addEventListener("pointermove", (event) => {
  if (state.panning) {
    state.view.x += event.clientX - state.pointer.x;
    state.view.y += event.clientY - state.pointer.y;
    state.pointer = { x: event.clientX, y: event.clientY };
    render();
  }
  if (state.drawing) {
    const point = pointFromEvent(event);
    drawStroke(state.pointer, point, state.tool === "eraser");
    state.pointer = point;
  }
});
canvas.addEventListener("pointerup", () => {
  if (state.drawing) pushHistory();
  state.drawing = false;
  state.panning = false;
  if (!state.spacePressed) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair";
});
canvas.addEventListener("wheel", (event) => {
  if (!state.currentImage) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;
  const sourceX = (mouseX - state.view.x) / state.view.scale;
  const sourceY = (mouseY - state.view.y) / state.view.scale;
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * factor));
  state.view.x = mouseX - sourceX * state.view.scale;
  state.view.y = mouseY - sourceY * state.view.scale;
  render();
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    state.spacePressed = true;
    canvas.style.cursor = "grab";
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    restoreSnapshot(event.shiftKey ? state.historyIndex + 1 : state.historyIndex - 1);
  }
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    state.spacePressed = false;
    if (!state.panning) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair";
  }
});

new ResizeObserver(resizeRenderCanvas).observe(stage);
setInterval(render, 100);
setInterval(pollJob, 700);
resizeRenderCanvas();
updateHistoryButtons();
