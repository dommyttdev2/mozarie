const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], selectedIds: new Set(), currentId: null, currentImage: null,
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", spacePressed: false, panning: false, drawing: false,
  pointer: null, hover: null, history: [], historyIndex: -1,
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, translations: {},
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const exclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const layerCtx = layerCanvas.getContext("2d");
let renderedWidth = 0;
let renderedHeight = 0;

function t(key, params = {}) {
  let value = state.translations[key] || key;
  for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, replacement);
  return value;
}

async function loadTranslations() {
  try {
    state.translations = await fetch("/i18n/ja.json").then((response) => response.ok ? response.json() : {});
  } catch {
    state.translations = {};
  }
  document.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => { element.title = t(element.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel)); });
}

function api(path, options = {}) {
  return fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t("error.requestFailed"));
      return data;
    });
}

function setStatus(message, kind = "") {
  const element = $("#status");
  element.textContent = message;
  element.className = `status ${kind}`;
}

function currentRecord() { return state.images.find((image) => image.id === state.currentId) || null; }
function detectionConfidence() { return Number($("#confidence").value); }

function updateActionButtons() {
  const running = state.job?.state === "running" || state.saving;
  const hasImage = Boolean(state.currentId && state.currentImage);
  $("#detectAllButton").disabled = running || state.images.length === 0;
  $("#detectCurrentButton").disabled = running || !hasImage;
  $("#applyButton").disabled = running || state.selectedIds.size === 0;
  $("#saveButton").disabled = running || !hasImage;
}

function updateProgress(job) {
  const progress = $("#jobProgress");
  const running = job?.state === "running";
  progress.hidden = !running;
  if (running) {
    progress.max = Math.max(1, Number(job.total) || 1);
    progress.value = Math.min(progress.max, Number(job.completed) || 0);
  }
  updateActionButtons();
}

async function loadFolder() {
  const path = $("#folderPath").value.trim();
  if (!path) return setStatus(t("status.enterFolder"), "error");
  setStatus(t("status.loadingImages"), "running");
  try {
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    state.images = data.images;
    state.selectedIds.clear(); state.currentId = null; state.currentImage = null;
    state.candidates = []; state.candidateImages.clear(); state.drafts.clear();
    renderGallery(); clearEditor();
    setStatus(t("status.imagesLoaded", { count: state.images.length }));
  } catch (error) { setStatus(error.message, "error"); }
}

async function pickFolder() {
  const button = $("#pickFolder");
  button.disabled = true;
  setStatus(t("status.openingFolder"), "running");
  try {
    const data = await api("/api/pick-folder", { method: "POST", body: JSON.stringify({ path: $("#folderPath").value.trim() }) });
    if (data.cancelled) return setStatus(t("status.folderCancelled"));
    $("#folderPath").value = data.path;
    await loadFolder();
  } catch (error) { setStatus(error.message, "error"); }
  finally { button.disabled = false; }
}

function renderGallery() {
  const gallery = $("#gallery");
  gallery.textContent = "";
  $("#imageCount").textContent = t("gallery.count", { count: state.images.length });
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
      updateSelectionUi();
    });
    const preview = item.querySelector("img");
    preview.src = `/api/thumbnail/${encodeURIComponent(image.id)}`;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    item.addEventListener("click", () => selectImage(image.id));
    gallery.append(item);
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  const allSelected = state.images.length > 0 && state.selectedIds.size === state.images.length;
  $("#selectAllButton").textContent = t(allSelected ? "gallery.clearAll" : "gallery.selectAll");
  $("#selectedCount").textContent = t("gallery.selected", { count: state.selectedIds.size });
  updateActionButtons();
}

function canvasSizeForImage(image) {
  for (const target of [addCanvas, exclusionCanvas, combinedCanvas]) { target.width = image.width; target.height = image.height; }
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
}

function clearEditor() {
  state.history = []; state.historyIndex = -1; state.hover = null;
  addCanvas.width = exclusionCanvas.width = combinedCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = combinedCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#imageInfo").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateActionButtons(); render();
}

async function selectImage(imageId, force = false) {
  if (state.currentId === imageId && !force) return;
  saveDraft(); state.currentId = imageId;
  const record = currentRecord(); renderGallery();
  setStatus(t("status.loadingImages"), "running");
  try {
    const [image, candidateData] = await Promise.all([
      loadImage(`/api/image/${encodeURIComponent(imageId)}?t=${Date.now()}`),
      api(`/api/candidates/${encodeURIComponent(imageId)}`),
    ]);
    state.currentImage = image;
    state.candidates = candidateData.candidates;
    state.candidateImages.clear();
    await Promise.all(state.candidates.map(async (candidate) => {
      state.candidateImages.set(candidate.id, await loadImage(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?t=${Date.now()}`));
    }));
    canvasSizeForImage(record); restoreDraft(imageId); fitImage();
    $("#blockSize").value = Math.max(4, Math.ceil(Math.max(record.width, record.height) / 100));
    $("#emptyState").hidden = true;
    $("#imageInfo").textContent = `${record.relativePath} / ${record.width} x ${record.height}`;
    $("#candidateStatus").textContent = state.candidates.length ? t("candidates.count", { count: state.candidates.length }) : t("candidates.none");
    renderCandidates(); updateActionButtons(); setStatus(t("status.editReady"));
  } catch (error) { setStatus(error.message, "error"); }
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("error.imageLoad")));
    image.src = source;
  });
}

function saveDraft() {
  if (!state.currentId || !state.currentImage) return;
  state.drafts.set(state.currentId, { add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png") });
}

function restoreDraft(imageId) {
  const draft = state.drafts.get(imageId);
  state.history = []; state.historyIndex = -1;
  if (!draft) return pushHistory();
  Promise.all([loadImage(draft.add), loadImage(draft.exclusion)]).then(([addImage, exclusionImage]) => {
    addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0); pushHistory(); render();
  });
}

function fitImage() {
  if (!state.currentImage) return;
  const padding = 28;
  state.view.scale = Math.min(Math.max(1, stage.clientWidth - padding * 2) / state.currentImage.width, Math.max(1, stage.clientHeight - padding * 2) / state.currentImage.height);
  state.view.x = (stage.clientWidth - state.currentImage.width * state.view.scale) / 2;
  state.view.y = (stage.clientHeight - state.currentImage.height * state.view.scale) / 2;
  render();
}

function resizeRenderCanvas() {
  const width = stage.clientWidth; const height = stage.clientHeight; const dpr = window.devicePixelRatio || 1;
  if (renderedWidth === width && renderedHeight === height && canvas.width === Math.round(width * dpr)) return;
  renderedWidth = width; renderedHeight = height;
  canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
  layerCanvas.width = canvas.width; layerCanvas.height = canvas.height; render();
}

function setCssTransform(context) { const dpr = window.devicePixelRatio || 1; context.setTransform(dpr, 0, 0, dpr, 0, 0); }

function paintMask(maskImage, color, alpha, subtractImage = null) {
  if (!maskImage || !state.currentImage) return;
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(layerCtx); layerCtx.clearRect(0, 0, width, height);
  layerCtx.save(); layerCtx.translate(state.view.x, state.view.y); layerCtx.scale(state.view.scale, state.view.scale);
  layerCtx.drawImage(maskImage, 0, 0, state.currentImage.width, state.currentImage.height);
  if (subtractImage) { layerCtx.globalCompositeOperation = "destination-out"; layerCtx.drawImage(subtractImage, 0, 0, state.currentImage.width, state.currentImage.height); }
  layerCtx.globalCompositeOperation = "source-in"; layerCtx.fillStyle = color; layerCtx.fillRect(0, 0, state.currentImage.width, state.currentImage.height);
  layerCtx.restore(); setCssTransform(ctx); ctx.globalAlpha = alpha; ctx.drawImage(layerCanvas, 0, 0, width, height); ctx.globalAlpha = 1;
}

function drawBrushCursor() {
  if (!state.hover || !state.currentImage) return;
  const radius = Math.max(1, Number($("#brushSize").value) * state.view.scale / 2);
  const x = state.view.x + state.hover.x * state.view.scale;
  const y = state.view.y + state.hover.y * state.view.scale;
  ctx.save();
  if (state.tool === "eraser") ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3; ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#111316"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function render() {
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(ctx); ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) return;
  ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale); ctx.drawImage(state.currentImage, 0, 0); ctx.restore();
  const pulse = 0.40 + Math.sin(Date.now() / 127) * 0.15;
  for (const candidate of state.candidates) if (candidate.enabled) paintMask(state.candidateImages.get(candidate.id), candidate.color, pulse, exclusionCanvas);
  paintMask(addCanvas, "#58d7be", 0.40, exclusionCanvas);
  drawBrushCursor();
}

function renderCandidates() {
  const list = $("#candidateList"); list.textContent = "";
  if (!state.currentId) return;
  if (!state.candidates.length) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.noAuto"); list.append(empty); return;
  }
  for (const candidate of state.candidates) {
    const row = document.createElement("label"); row.className = "candidate-row";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = candidate.enabled;
    enabled.addEventListener("change", async () => { candidate.enabled = enabled.checked; render(); await updateCandidate(candidate); });
    const color = document.createElement("input"); color.type = "color"; color.value = candidate.color; color.title = t("candidates.color");
    color.addEventListener("input", () => { candidate.color = color.value; render(); }); color.addEventListener("change", () => updateCandidate(candidate));
    const label = document.createElement("span"); label.className = "candidate-label";
    label.innerHTML = `<span class="candidate-class">${escapeHtml(candidate.className)}</span><span class="candidate-conf">${Math.round(candidate.confidence * 100)}%</span>`;
    row.append(enabled, color, label); list.append(row);
  }
}

async function updateCandidate(candidate) {
  try { await api(`/api/candidate/${encodeURIComponent(state.currentId)}/${encodeURIComponent(candidate.id)}`, { method: "POST", body: JSON.stringify({ enabled: candidate.enabled, color: candidate.color }) }); }
  catch (error) { setStatus(error.message, "error"); }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left - state.view.x) / state.view.scale, y: (event.clientY - rect.top - state.view.y) / state.view.scale }; }
function snapshot() { return { add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png") }; }

function pushHistory() {
  if (!state.currentImage) return;
  state.history.splice(state.historyIndex + 1); state.history.push(snapshot());
  if (state.history.length > 20) state.history.shift();
  state.historyIndex = state.history.length - 1; updateHistoryButtons();
}
function updateHistoryButtons() { $("#undoButton").disabled = state.historyIndex <= 0; $("#redoButton").disabled = state.historyIndex >= state.history.length - 1; }
async function restoreSnapshot(index) {
  const entry = state.history[index]; if (!entry) return;
  const [addImage, exclusionImage] = await Promise.all([loadImage(entry.add), loadImage(entry.exclusion)]);
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0); state.historyIndex = index; updateHistoryButtons(); render();
}

function drawStroke(from, to, erase) {
  const target = erase ? exclusionCtx : addCtx; const opposite = erase ? addCtx : exclusionCtx; const size = Number($("#brushSize").value);
  opposite.save(); opposite.globalCompositeOperation = "destination-out"; opposite.lineWidth = size; opposite.lineCap = "round"; opposite.beginPath(); opposite.moveTo(from.x, from.y); opposite.lineTo(to.x, to.y); opposite.stroke(); opposite.restore();
  target.save(); target.globalCompositeOperation = "source-over"; target.strokeStyle = "#ffffff"; target.lineWidth = size; target.lineCap = "round"; target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke(); target.restore(); render();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  combinedCanvas.width = state.currentImage.width; combinedCanvas.height = state.currentImage.height;
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) if (candidate.enabled) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  combinedCtx.drawImage(addCanvas, 0, 0); combinedCtx.globalCompositeOperation = "destination-out"; combinedCtx.drawImage(exclusionCanvas, 0, 0); combinedCtx.globalCompositeOperation = "source-over";
  return combinedCanvas.toDataURL("image/png");
}

async function saveCurrent() {
  if (!state.currentId || !state.currentImage) return;
  state.saving = true;
  updateActionButtons(); setStatus(t("status.saving"), "running");
  try {
    await api(`/api/images/${encodeURIComponent(state.currentId)}/save`, { method: "POST", body: JSON.stringify({ mask: buildCombinedMask(), blockSize: Number($("#blockSize").value) }) });
    state.drafts.delete(state.currentId); addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
    state.history = []; state.historyIndex = -1; state.currentImage = await loadImage(`/api/image/${encodeURIComponent(state.currentId)}?t=${Date.now()}`); render();
    setStatus(t("status.saved"));
  } catch (error) { setStatus(error.message, "error"); }
  finally { state.saving = false; updateHistoryButtons(); updateActionButtons(); }
}

async function runDetection(imageIds) {
  if (!imageIds.length) return;
  try {
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence: detectionConfidence() }) });
    updateProgress({ state: "running", total: imageIds.length, completed: 0 }); setStatus(t("status.detectStarted"), "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
}

async function applyDetection() {
  if (!state.selectedIds.size) return setStatus(t("status.chooseApplyImages"), "error");
  try {
    await api("/api/apply", { method: "POST", body: JSON.stringify({ imageIds: [...state.selectedIds], blockSize: Number($("#blockSize").value) }) });
    updateProgress({ state: "running", total: state.selectedIds.size, completed: 0 }); setStatus(t("status.applyStarted"), "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
}

async function pollJob() {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; updateProgress(job);
    if (job.state === "running") setStatus(t(job.kind === "detect" ? "status.detectProgress" : "status.applyProgress", { completed: job.completed, total: job.total, current: job.current }), "running");
    else if (job.state === "complete" && previous?.state === "running") {
      setStatus(t(job.kind === "detect" ? "status.detectDone" : "status.applyDone"));
      const keepCurrent = state.currentId; const data = await api("/api/images"); state.images = data.images; renderGallery(); if (keepCurrent) await selectImage(keepCurrent, true);
    } else if (job.state === "error" && previous?.state === "running") setStatus(job.error || t("error.background"), "error");
  } catch { /* Keep the current useful message if the local server is unavailable. */ }
}

function setTool(tool) {
  state.tool = tool; $("#brushTool").classList.toggle("active", tool === "brush"); $("#eraserTool").classList.toggle("active", tool === "eraser");
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair"; render();
}
function updateBrushSize(value) {
  const input = $("#brushSize"); input.value = Math.min(500, Math.max(2, Math.round(value)));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render();
}

function bindEvents() {
  $("#loadFolder").addEventListener("click", loadFolder); $("#pickFolder").addEventListener("click", pickFolder);
  $("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
  $("#detectAllButton").addEventListener("click", () => runDetection(state.images.map((image) => image.id)));
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId]));
  $("#applyButton").addEventListener("click", applyDetection); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", fitImage);
  $("#selectAllButton").addEventListener("click", () => { if (state.selectedIds.size === state.images.length) state.selectedIds.clear(); else state.images.forEach((image) => state.selectedIds.add(image.id)); renderGallery(); });
  $("#brushTool").addEventListener("click", () => setTool("brush")); $("#eraserTool").addEventListener("click", () => setTool("eraser"));
  $("#brushSize").addEventListener("input", () => updateBrushSize($("#brushSize").value));
  $("#confidence").addEventListener("input", () => { $("#confidenceValue").textContent = Number($("#confidence").value).toFixed(2); });
  $("#undoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex - 1)); $("#redoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex + 1));

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.currentImage) return;
    if (event.button === 1 || (state.spacePressed && event.button === 0)) {
      canvas.setPointerCapture(event.pointerId); state.panning = true; state.pointer = { x: event.clientX, y: event.clientY }; canvas.style.cursor = "grabbing"; return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId); state.drawing = true; state.pointer = pointFromEvent(event); state.hover = state.pointer; drawStroke(state.pointer, state.pointer, state.tool === "eraser");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.panning) {
      state.view.x += event.clientX - state.pointer.x; state.view.y += event.clientY - state.pointer.y; state.pointer = { x: event.clientX, y: event.clientY }; render(); return;
    }
    state.hover = pointFromEvent(event);
    if (state.drawing && (event.buttons & 1)) { const point = state.hover; drawStroke(state.pointer, point, state.tool === "eraser"); state.pointer = point; }
    render();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (state.drawing && event.button === 0) pushHistory();
    state.drawing = false; state.panning = false; if (!state.spacePressed) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair"; render();
  });
  canvas.addEventListener("pointercancel", () => { state.drawing = false; state.panning = false; render(); });
  canvas.addEventListener("pointerleave", () => { state.hover = null; render(); });
  canvas.addEventListener("wheel", (event) => {
    if (!state.currentImage) return;
    event.preventDefault();
    if (event.shiftKey) return updateBrushSize(Number($("#brushSize").value) * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    const rect = canvas.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
    const sourceX = (mouseX - state.view.x) / state.view.scale; const sourceY = (mouseY - state.view.y) / state.view.scale;
    state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    state.view.x = mouseX - sourceX * state.view.scale; state.view.y = mouseY - sourceY * state.view.scale; render();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); state.spacePressed = true; canvas.style.cursor = "grab"; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); restoreSnapshot(event.shiftKey ? state.historyIndex + 1 : state.historyIndex - 1); }
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space") { state.spacePressed = false; if (!state.panning) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair"; } });
}

async function initialise() {
  await loadTranslations(); bindEvents();
  new ResizeObserver(resizeRenderCanvas).observe(stage); setInterval(render, 80); setInterval(pollJob, 700);
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateActionButtons();
}

initialise();
