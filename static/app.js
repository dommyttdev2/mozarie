const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], currentId: null, currentImage: null, pendingImageId: null, galleryFilter: "all", maskStatus: new Map(),
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", spacePressed: false, panning: false, drawing: false, boundaryPending: false,
  boundaryRoi: null, boundaryStart: null, boundaryStartClient: null, boundaryPoint: null, boundaryDragging: false,
  pointer: null, hover: null, history: [], historyIndex: -1,
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, imageGeneration: 0, catalogGeneration: 0, translations: {},
  applyTargetIds: [], applyRunning: false, applyFinishing: false, handledApplyStartedAt: null, importing: false, mosaicPreviewEnabled: true,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(),
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const exclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const mosaicCanvas = document.createElement("canvas");
const mosaicSourceCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const mosaicCtx = mosaicCanvas.getContext("2d");
const mosaicSourceCtx = mosaicSourceCanvas.getContext("2d");
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
      if (!response.ok) {
        const error = new Error(data.error || t("error.requestFailed"));
        error.status = response.status;
        throw error;
      }
      return data;
    });
}

function setStatus(message, kind = "") {
  const element = $("#status");
  element.textContent = message;
  element.className = `status ${kind}`;
}

function currentRecord() { return state.images.find((image) => image.id === state.currentId) || null; }
function isCurrentGeneration(generation) { return state.imageGeneration === generation; }
function detectionConfidence() { return Number($("#confidence").value); }
function normaliseDivisor(value) { return Math.max(1, Math.min(10000, Math.round(Number(value) || 100))); }
function mosaicDivisor() { return normaliseDivisor($("#divisor").value); }
function calculatedBlockSize(image = currentRecord(), divisor = mosaicDivisor()) {
  return image ? Math.max(4, Math.ceil(Math.max(image.width, image.height) / divisor)) : 0;
}
function isBusy() { return ["running", "paused"].includes(state.job?.state) || state.saving || state.boundaryPending; }
function imageHasMask(image) { return state.maskStatus.get(image.id) ?? Number(image.enabledCandidateCount || 0) > 0; }
function saveTargets() { return state.images.filter(imageHasMask).map((image) => image.id); }

function updateActionButtons() {
  const running = isBusy();
  const locked = running || state.importing;
  const hasImage = Boolean(state.currentId && state.currentImage);
  const controls = [...document.querySelectorAll("button, input, select, textarea")];
  if (!locked) {
    for (const control of controls) {
      if (control.dataset.disabledByLock === "true") {
        control.disabled = false;
        delete control.dataset.disabledByLock;
      }
    }
  }
  $("#pickFolder").disabled = running || state.importing;
  $("#browseFolderOption").disabled = running || state.importing;
  $("#browseImagesOption").disabled = running || state.importing;
  $("#importFilesInput").disabled = running || state.importing;
  $("#detectAllButton").disabled = running || state.images.length === 0;
  $("#detectCurrentButton").disabled = running || !hasImage;
  $("#clearCurrentMasksButton").disabled = running || !hasImage;
  $("#clearAllMasksButton").disabled = running || state.images.length === 0;
  $("#clearCatalogButton").disabled = running || state.images.length === 0;
  $("#galleryAllTab").disabled = running;
  $("#galleryMaskedTab").disabled = running;
  $("#saveAllButton").disabled = running || saveTargets().length === 0;
  $("#saveButton").disabled = running || !hasImage || !imageHasMask(currentRecord());
  updateHistoryButtons();
  if (locked) for (const control of controls) {
    if (["applyPauseButton", "applyCancelButton"].includes(control.id) && state.applyRunning) continue;
    if (!control.disabled) control.dataset.disabledByLock = "true";
    control.disabled = true;
  }
  $("#gallery").classList.toggle("locked", locked);
  canvas.style.pointerEvents = locked ? "none" : "";
  canvas.setAttribute("aria-disabled", String(locked));
}

function clearBoundaryInteraction() {
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryStartClient = null;
  state.boundaryPoint = null;
  state.boundaryDragging = false;
}

function setMosaicPreviewEnabled(enabled) {
  if (isBusy() || state.importing) return;
  state.mosaicPreviewEnabled = enabled;
  const button = $("#mosaicPreviewButton");
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", String(enabled));
  render();
}

function openBrowseDialog() {
  if (isBusy() || state.importing) return;
  const dialog = $("#browseDialog");
  dialog.showModal();
  $("#browseFolderOption").focus();
}

function updateProgress(job) {
  const progress = $("#jobProgress");
  const progressText = $("#jobProgressText");
  const running = ["running", "paused"].includes(job?.state);
  const completedDetection = job?.kind === "detect" && job?.state === "complete";
  const visible = running || completedDetection;
  progress.hidden = !visible;
  progressText.hidden = !visible;
  if (visible) {
    progress.max = Math.max(1, Number(job.total) || 1);
    progress.value = completedDetection ? progress.max : Math.min(progress.max, Number(job.completed) || 0);
    progressText.textContent = t("status.progressCount", { completed: progress.value, total: progress.max });
  }
  updateActionButtons();
}

async function loadFolder() {
  if (isBusy() || state.importing) return;
  const path = $("#folderPath").value.trim();
  if (!path) return setStatus(t("status.enterFolder"), "error");
  const catalogGeneration = ++state.catalogGeneration;
  ++state.imageGeneration;
  setStatus(t("status.loadingImages"), "running");
  try {
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    if (state.catalogGeneration !== catalogGeneration) return;
    state.images = data.images;
    state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
    state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); state.boundaryRoi = null;
    renderGallery(); clearEditor();
    setStatus(t("status.imagesLoaded", { count: state.images.length }));
  } catch (error) { setStatus(error.message, "error"); }
}

async function pickFolder() {
  if (isBusy() || state.importing) return;
  const button = $("#pickFolder");
  button.disabled = true;
  setStatus(t("status.openingFolder"), "running");
  try {
    const data = await api("/api/pick-folder", { method: "POST", body: JSON.stringify({ path: $("#folderPath").value.trim() }) });
    if (data.cancelled) return setStatus(t("status.folderCancelled"));
    $("#folderPath").value = data.path;
    await loadFolder();
  } catch (error) { setStatus(error.message, "error"); }
  finally { button.disabled = false; updateActionButtons(); }
}

function renderGallery() {
  const gallery = $("#gallery");
  const scrollTop = gallery.scrollTop;
  gallery.textContent = "";
  const visibleImages = state.galleryFilter === "masked" ? state.images.filter(imageHasMask) : state.images;
  $("#imageCount").textContent = t("gallery.count", { count: visibleImages.length });
  $("#galleryAllTab").classList.toggle("active", state.galleryFilter === "all");
  $("#galleryAllTab").setAttribute("aria-selected", String(state.galleryFilter === "all"));
  $("#galleryMaskedTab").classList.toggle("active", state.galleryFilter === "masked");
  $("#galleryMaskedTab").setAttribute("aria-selected", String(state.galleryFilter === "masked"));
  const template = $("#galleryItemTemplate");
  for (const image of visibleImages) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    const preview = item.querySelector("img");
    preview.src = `/api/thumbnail/${encodeURIComponent(image.id)}`;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    item.addEventListener("click", () => selectImage(image.id));
    gallery.append(item);
  }
  gallery.scrollTop = scrollTop;
  updateActionButtons();
}

function canvasSizeForImage(image) {
  for (const target of [addCanvas, exclusionCanvas, combinedCanvas, mosaicCanvas]) { target.width = image.width; target.height = image.height; }
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
}

function clearEditor() {
  state.history = []; state.historyIndex = -1; state.hover = null; clearBoundaryInteraction();
  addCanvas.width = exclusionCanvas.width = combinedCanvas.width = mosaicCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = combinedCanvas.height = mosaicCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#imageInfo").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateActionButtons(); render();
}

async function selectImage(imageId, force = false, { saveCurrentDraft = true } = {}) {
  if ((isBusy() || state.importing) && !force) return;
  if (state.currentId === imageId && !force && state.pendingImageId !== imageId) return;
  if (saveCurrentDraft) saveDraft();
  const generation = ++state.imageGeneration;
  state.pendingImageId = imageId;
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  setStatus(t("status.loadingImages"), "running");
  try {
    const [image, candidateBundle] = await Promise.all([
      loadImage(`/api/image/${encodeURIComponent(imageId)}?t=${Date.now()}`),
      loadCandidateBundle(imageId, generation),
    ]);
    if (!isCurrentGeneration(generation)) return;
    state.currentId = imageId;
    state.pendingImageId = null;
    state.currentImage = image;
    state.candidates = candidateBundle.candidates;
    state.candidateImages = candidateBundle.candidateImages;
    clearBoundaryInteraction();
    canvasSizeForImage(record); restoreDraft(imageId, generation); rebuildMosaicPreview(); fitImage();
    updateBlockSizeDisplay(); refreshMaskStatus();
    $("#emptyState").hidden = true;
    $("#imageInfo").textContent = `${record.relativePath} / ${record.width} x ${record.height}`;
    $("#candidateStatus").textContent = state.candidates.length ? t("candidates.count", { count: state.candidates.length }) : t("candidates.none");
    renderCandidates(); updateActionButtons(); render(); setStatus(t("status.editReady"));
  } catch (error) {
    if (isCurrentGeneration(generation)) {
      state.pendingImageId = null;
      setStatus(error.message, "error");
    }
  }
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("error.imageLoad")));
    image.src = source;
  });
}

async function loadCandidateMask(source) {
  const response = await fetch(source);
  if (!response.ok) {
    const error = new Error(t("error.imageLoad"));
    error.status = response.status;
    throw error;
  }
  const objectUrl = URL.createObjectURL(await response.blob());
  try { return await loadImage(objectUrl); }
  finally { URL.revokeObjectURL(objectUrl); }
}

async function loadCandidateBundle(imageId, generation, reconciled = false) {
  const candidateData = await api(`/api/candidates/${encodeURIComponent(imageId)}`);
  try {
    const candidateImages = new Map();
    await Promise.all(candidateData.candidates.map(async (candidate) => {
      candidateImages.set(candidate.id, await loadCandidateMask(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?t=${Date.now()}`));
    }));
    return { candidates: candidateData.candidates, candidateImages };
  } catch (error) {
    if (error.status === 404 && !reconciled && isCurrentGeneration(generation)) {
      return loadCandidateBundle(imageId, generation, true);
    }
    throw error;
  }
}

async function reconcileCurrentCandidates(imageId, generation) {
  const bundle = await loadCandidateBundle(imageId, generation);
  if (state.currentId !== imageId || !isCurrentGeneration(generation)) return false;
  state.candidates = bundle.candidates;
  state.candidateImages = bundle.candidateImages;
  const record = state.images.find((image) => image.id === imageId);
  if (record) {
    record.candidateCount = bundle.candidates.length;
    record.enabledCandidateCount = bundle.candidates.filter((candidate) => candidate.enabled).length;
  }
  refreshMaskStatus(true); renderCandidates(); render();
  return true;
}

function saveDraft() {
  if (!state.currentId || !state.currentImage) return;
  state.drafts.set(state.currentId, { add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png") });
}

function restoreDraft(imageId, generation) {
  const draft = state.drafts.get(imageId);
  state.history = []; state.historyIndex = -1;
  if (!draft) return pushHistory();
  Promise.all([loadImage(draft.add), loadImage(draft.exclusion)]).then(([addImage, exclusionImage]) => {
    if (state.currentId !== imageId || state.imageGeneration !== generation) return;
    addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0); pushHistory(); refreshMaskStatus(true); render();
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

function rebuildMosaicPreview() {
  if (!state.currentImage) return;
  const blockSize = calculatedBlockSize();
  mosaicSourceCanvas.width = Math.max(1, Math.ceil(state.currentImage.width / blockSize));
  mosaicSourceCanvas.height = Math.max(1, Math.ceil(state.currentImage.height / blockSize));
  mosaicSourceCtx.imageSmoothingEnabled = true;
  mosaicSourceCtx.clearRect(0, 0, mosaicSourceCanvas.width, mosaicSourceCanvas.height);
  mosaicSourceCtx.drawImage(state.currentImage, 0, 0, mosaicSourceCanvas.width, mosaicSourceCanvas.height);
  mosaicCtx.imageSmoothingEnabled = false;
  mosaicCtx.clearRect(0, 0, mosaicCanvas.width, mosaicCanvas.height);
  mosaicCtx.drawImage(mosaicSourceCanvas, 0, 0, mosaicCanvas.width, mosaicCanvas.height);
}

function composeCurrentMask() {
  if (!state.currentImage) return;
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) if (candidate.enabled) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
}

function refreshMaskStatus(renderGalleryAfter = false) {
  if (!state.currentId || !state.currentImage) return;
  composeCurrentMask();
  state.maskStatus.set(state.currentId, combinedCtx.getImageData(0, 0, combinedCanvas.width, combinedCanvas.height).data.some((value) => value > 0));
  if (renderGalleryAfter) renderGallery();
  else updateActionButtons();
}

function paintMosaicPreview() {
  if (!state.currentImage) return;
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(layerCtx); layerCtx.clearRect(0, 0, width, height);
  layerCtx.save(); layerCtx.translate(state.view.x, state.view.y); layerCtx.scale(state.view.scale, state.view.scale);
  layerCtx.drawImage(mosaicCanvas, 0, 0);
  layerCtx.globalCompositeOperation = "destination-in";
  layerCtx.drawImage(combinedCanvas, 0, 0);
  layerCtx.restore(); setCssTransform(ctx); ctx.drawImage(layerCanvas, 0, 0, width, height);
}

function drawBrushCursor() {
  if (!state.hover || !state.currentImage || !["brush", "eraser"].includes(state.tool)) return;
  const radius = Math.max(1, Number($("#brushSize").value) * state.view.scale / 2);
  const x = state.view.x + state.hover.x * state.view.scale;
  const y = state.view.y + state.hover.y * state.view.scale;
  ctx.save();
  if (state.tool === "eraser") ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3; ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#111316"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function roiFromPoints(start, end) {
  const left = Math.floor(Math.min(start.x, end.x)); const top = Math.floor(Math.min(start.y, end.y));
  const right = Math.ceil(Math.max(start.x, end.x)); const bottom = Math.ceil(Math.max(start.y, end.y));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}

function pointInBoundaryRoi(point) {
  const roi = state.boundaryRoi;
  return Boolean(roi && point.x >= roi.left && point.x < roi.right && point.y >= roi.top && point.y < roi.bottom);
}

function drawBoundaryRoi() {
  const roi = state.boundaryDragging ? roiFromPoints(state.boundaryStart, state.boundaryPoint) : state.boundaryRoi;
  if (!roi) return;
  const x = state.view.x + roi.left * state.view.scale; const y = state.view.y + roi.top * state.view.scale;
  const width = (roi.right - roi.left) * state.view.scale; const height = (roi.bottom - roi.top) * state.view.scale;
  ctx.save(); ctx.fillStyle = "rgba(255, 255, 255, 0.24)"; ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.strokeRect(x, y, width, height); ctx.restore();
}

function render() {
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(ctx); ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) return;
  ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale); ctx.drawImage(state.currentImage, 0, 0); ctx.restore();
  if (state.mosaicPreviewEnabled) paintMosaicPreview();
  drawBoundaryRoi();
  drawBrushCursor();
}

function renderCandidates() {
  const list = $("#candidateList"); list.textContent = "";
  if (!state.currentId) return;
  if (!state.candidates.length) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty); return;
  }
  for (const candidate of state.candidates) {
    const row = document.createElement("label"); row.className = "candidate-row";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = candidate.enabled;
    enabled.addEventListener("change", async () => {
      if (isBusy() || state.importing) { enabled.checked = candidate.enabled; return; }
      const previousEnabled = candidate.enabled;
      candidate.enabled = enabled.checked;
      refreshMaskStatus(true); render(); await updateCandidate(candidate, previousEnabled);
    });
    const label = document.createElement("span"); label.className = "candidate-label";
    label.innerHTML = `<span class="candidate-class">${escapeHtml(candidate.className)}</span><span class="candidate-conf">${Math.round(candidate.confidence * 100)}%</span>`;
    row.append(enabled, label); list.append(row);
  }
}

async function updateCandidate(candidate, previousEnabled) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  const key = `${imageId}:${candidate.id}`;
  const version = (state.candidateUpdateVersions.get(key) || 0) + 1;
  const desired = candidate.enabled;
  state.candidateUpdateVersions.set(key, version);
  const send = async () => {
    try {
      await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color }),
      });
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation) && state.candidateUpdateVersions.get(key) === version) {
        try { await reconcileCurrentCandidates(imageId, generation); }
        catch { candidate.enabled = previousEnabled; refreshMaskStatus(true); renderCandidates(); render(); }
      }
      if (state.currentId === imageId && isCurrentGeneration(generation) && state.candidateUpdateVersions.get(key) === version) setStatus(error.message, "error");
    }
  };
  const previous = state.candidateUpdateChains.get(key) || Promise.resolve();
  const queued = previous.then(send, send);
  const tracked = queued.finally(() => {
    if (state.candidateUpdateChains.get(key) === tracked) state.candidateUpdateChains.delete(key);
  });
  state.candidateUpdateChains.set(key, tracked);
  return tracked;
}

async function addBoundaryCandidate(point) {
  if (!state.currentId || !state.boundaryRoi || isBusy()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const roi = { ...state.boundaryRoi };
  const targetPoint = { ...point };
  state.boundaryPending = true; updateActionButtons(); setStatus(t("status.boundaryDetecting"), "running");
  try {
    const data = await api("/api/boundary", {
      method: "POST",
      body: JSON.stringify({ imageId, roi, point: targetPoint }),
    });
    const candidate = data.candidate;
    const record = state.images.find((image) => image.id === imageId);
    if (record) {
      record.candidateCount = Number(record.candidateCount || 0) + 1;
      record.enabledCandidateCount = Number(record.enabledCandidateCount || 0) + 1;
    }
    renderGallery();
    if (state.currentId !== imageId || state.imageGeneration !== viewGeneration) return;

    const maskImage = await loadCandidateMask(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?t=${Date.now()}`);
    if (state.currentId !== imageId || state.imageGeneration !== viewGeneration) return;
    if (state.candidates.some((item) => item.id === candidate.id)) return;
    state.candidates.push(candidate);
    state.candidateImages.set(candidate.id, maskImage);
    state.boundaryRoi = null;
    $("#candidateStatus").textContent = t("candidates.count", { count: state.candidates.length });
    refreshMaskStatus(true); renderCandidates(); render(); setStatus(t("status.boundaryDone"));
  } catch (error) { if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error"); }
  finally { state.boundaryPending = false; updateActionButtons(); }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left - state.view.x) / state.view.scale, y: (event.clientY - rect.top - state.view.y) / state.view.scale }; }
function clampPoint(point) {
  if (!state.currentImage) return point;
  return {
    x: Math.min(state.currentImage.width, Math.max(0, point.x)),
    y: Math.min(state.currentImage.height, Math.max(0, point.y)),
  };
}
function boundaryDragStarted(event) {
  return Boolean(state.boundaryStartClient) && Math.hypot(
    event.clientX - state.boundaryStartClient.x,
    event.clientY - state.boundaryStartClient.y,
  ) >= 3;
}
function snapshot() { return { add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png") }; }

function pushHistory() {
  if (!state.currentImage) return;
  state.history.splice(state.historyIndex + 1); state.history.push(snapshot());
  if (state.history.length > 20) state.history.shift();
  state.historyIndex = state.history.length - 1; updateHistoryButtons();
}
function updateHistoryButtons() { $("#undoButton").disabled = state.historyIndex <= 0; $("#redoButton").disabled = state.historyIndex >= state.history.length - 1; }
async function restoreSnapshot(index) {
  if (isBusy() || state.importing) return;
  const entry = state.history[index]; if (!entry) return;
  const [addImage, exclusionImage] = await Promise.all([loadImage(entry.add), loadImage(entry.exclusion)]);
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height); exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0); state.historyIndex = index; updateHistoryButtons(); refreshMaskStatus(true); render();
}

function drawStroke(from, to, erase) {
  const target = erase ? exclusionCtx : addCtx; const opposite = erase ? addCtx : exclusionCtx; const size = Number($("#brushSize").value);
  opposite.save(); opposite.globalCompositeOperation = "destination-out"; opposite.lineWidth = size; opposite.lineCap = "round"; opposite.beginPath(); opposite.moveTo(from.x, from.y); opposite.lineTo(to.x, to.y); opposite.stroke(); opposite.restore();
  target.save(); target.globalCompositeOperation = "source-over"; target.strokeStyle = "#ffffff"; target.lineWidth = size; target.lineCap = "round"; target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke(); target.restore(); composeCurrentMask();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  composeCurrentMask();
  return combinedCanvas.toDataURL("image/png");
}

async function runDetection(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  try {
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence: detectionConfidence() }) });
    state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "" };
    updateProgress(state.job); setStatus(t("status.detectStarted"), "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
}

function saveCurrent() {
  if (!isBusy() && !state.importing && state.currentId && imageHasMask(currentRecord())) openApplyDialog([state.currentId]);
}

function saveAll() {
  if (isBusy() || state.importing) return;
  saveDraft(); refreshMaskStatus();
  const imageIds = saveTargets();
  if (imageIds.length) openApplyDialog(imageIds);
}

function setApplyResult(message, error = false) {
  const result = $("#applyResult"); result.textContent = message; result.classList.toggle("error", error);
}

function isTerminalApply(job) {
  if (job.kind !== "apply" || !["complete", "cancelled", "error"].includes(job.state)) return false;
  return state.applyRunning || (job.startedAt != null && state.handledApplyStartedAt !== job.startedAt);
}

function selectedSaveMode() { return document.querySelector('input[name="saveMode"]:checked').value; }

function syncApplyMode() {
  const copying = selectedSaveMode() === "copy";
  $("#applySuffix").disabled = !copying || state.applyRunning;
  $("#deleteOriginalRow").hidden = !copying;
  $("#deleteOriginal").disabled = !copying || state.applyRunning;
}

function openApplyDialog(imageIds) {
  if (!imageIds.length || isBusy()) return;
  saveDraft();
  state.applyTargetIds = imageIds;
  state.applyRunning = false;
  $("#applyTargetCount").textContent = t("apply.target", { count: imageIds.length });
  $("#applyDivisor").value = $("#divisor").value;
  updateBlockSizeDisplay();
  $("#applyProgressPanel").hidden = true;
  $("#applyStartButton").hidden = false;
  $("#applyCloseButton").hidden = false;
  $("#applyPauseButton").hidden = true;
  $("#applyCancelButton").hidden = true;
  $("#applySettings").disabled = false;
  setApplyResult(""); syncApplyMode();
  $("#applyDialog").showModal();
}

function draftPayload(imageIds) {
  const drafts = {};
  for (const imageId of imageIds) {
    const draft = state.drafts.get(imageId);
    if (draft) drafts[imageId] = draft;
  }
  return drafts;
}

async function startApplyFromDialog(event) {
  event.preventDefault();
  const imageIds = state.applyTargetIds;
  if (!imageIds.length) return;
  const copy = selectedSaveMode() === "copy";
  const suffix = $("#applySuffix").value.trim();
  if (copy && !suffix) return setApplyResult(t("error.requestFailed"), true);
  try {
    await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({
        imageIds, divisor: Number($("#applyDivisor").value), mode: copy ? "copy" : "overwrite",
        suffix: copy ? suffix : "_censored", deleteOriginal: copy && $("#deleteOriginal").checked,
        drafts: draftPayload(imageIds),
      }),
    });
    state.job = { kind: "apply", state: "running", total: imageIds.length, completed: 0, current: "" };
    state.applyRunning = true;
    $("#applySettings").disabled = true;
    $("#applyProgressPanel").hidden = false;
    $("#applyStartButton").hidden = true;
    $("#applyCloseButton").hidden = true;
    $("#applyPauseButton").hidden = false;
    $("#applyCancelButton").hidden = false;
    updateProgress(state.job); setStatus(t("status.applyStarted"), "running");
  } catch (error) { setApplyResult(error.message, true); }
}

async function controlApply(action) {
  try { await api(`/api/job/${action}`, { method: "POST", body: JSON.stringify({}) }); }
  catch (error) { setApplyResult(error.message, true); }
}

function showRunningApply(job) {
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  const dialog = $("#applyDialog");
  if (!dialog.open) dialog.showModal();
}

async function finishApplyJob(job) {
  if (state.applyFinishing) return;
  state.applyFinishing = true;
  let reconciled = false;
  const generation = ++state.imageGeneration;
  try {
    const keepCurrent = state.currentId;
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : (job.state === "complete" ? requestedImageIds : []);
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const data = await api("/api/images");
    if (!isCurrentGeneration(generation)) return;
    state.images = data.images;
    state.maskStatus.clear();
    for (const imageId of completedImageIds) state.drafts.delete(imageId);
    state.applyTargetIds = requestedImageIds;
    if (reloadCurrent) {
      state.candidates = [];
      state.candidateImages.clear();
    }
    renderGallery();
    if (reloadCurrent && state.images.some((image) => image.id === keepCurrent)) {
      await selectImage(keepCurrent, true, { saveCurrentDraft: false });
    } else if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
      refreshMaskStatus(true);
      renderCandidates();
      render();
    }
    else { state.currentId = null; state.currentImage = null; clearEditor(); }
    state.applyRunning = false;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    if (job.state === "complete") setApplyResult(t("apply.complete", { completed: job.completed }));
    else if (job.state === "cancelled") setApplyResult(t("apply.cancelled", { completed: job.completed }));
    else setApplyResult(t("apply.error", { error: job.error || t("error.background") }), true);
    reconciled = true;
  } finally {
    if (reconciled && job.startedAt != null) state.handledApplyStartedAt = job.startedAt;
    state.applyFinishing = false;
  }
}

async function pollJob() {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; updateProgress(job);
    const terminalApply = isTerminalApply(job);
    if (terminalApply) {
      await finishApplyJob(job);
      setStatus(job.state === "complete" ? t("status.applyDone") : (job.state === "cancelled" ? t("status.applyCancelled") : (job.error || t("error.background"))), job.state === "error" ? "error" : "");
    } else if (job.kind === "apply" && ["running", "paused"].includes(job.state)) {
      if (!state.applyRunning) showRunningApply(job);
      $("#applyProgress").max = Math.max(1, Number(job.total) || 1);
      $("#applyProgress").value = Math.min(Number(job.total) || 1, Number(job.completed) || 0);
      $("#applyCurrentName").textContent = job.current || "";
      $("#applyProgressText").textContent = t("apply.progress", { completed: job.completed, total: job.total });
      $("#applyPauseButton").textContent = t(job.state === "paused" ? "apply.resume" : "apply.pause");
      if (job.state === "running") setStatus(t("status.applyProgress", { completed: job.completed, total: job.total, current: job.current }), "running");
    } else if (job.kind === "detect" && job.state === "error" && previous?.state !== "error") {
      setStatus(job.error || t("error.background"), "error");
    } else if (job.kind === "detect" && job.state === "complete" && previous?.state === "running") {
      const generation = ++state.imageGeneration;
      const keepCurrent = state.currentId; const data = await api("/api/images");
      if (!isCurrentGeneration(generation)) return;
      state.images = data.images; state.maskStatus.clear(); renderGallery(); if (keepCurrent) await selectImage(keepCurrent, true);
      setStatus(t(job.kind === "detect" ? "status.detectDone" : "status.applyDone"));
    }
  } catch { /* Keep the current useful message if the local server is unavailable. */ }
}

function setTool(tool) {
  if (isBusy() || state.importing) return;
  if (tool !== "boundary") clearBoundaryInteraction();
  state.tool = tool; $("#brushTool").classList.toggle("active", tool === "brush"); $("#eraserTool").classList.toggle("active", tool === "eraser"); $("#boundaryTool").classList.toggle("active", tool === "boundary");
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
  if (tool === "boundary" && state.boundaryRoi) setStatus(t("status.boundaryReady"));
  render();
}
function updateBrushSize(value) {
  if (isBusy() || state.importing) return;
  const input = $("#brushSize"); input.value = Math.min(500, Math.max(2, Math.round(value)));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render();
}
function updateBlockSizeDisplay() {
  const currentBlockSize = calculatedBlockSize(currentRecord(), mosaicDivisor());
  const applyBlockSize = calculatedBlockSize(currentRecord(), normaliseDivisor($("#applyDivisor").value));
  $("#blockSizeValue").textContent = currentBlockSize ? t("editor.calculatedPixels", { value: currentBlockSize }) : "-";
  $("#applyBlockSize").textContent = applyBlockSize ? t("editor.calculatedPixels", { value: applyBlockSize }) : "-";
}

function confirmAction(title, message) {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  return new Promise((resolve) => {
    const finish = () => resolve(dialog.returnValue === "confirm");
    dialog.addEventListener("close", finish, { once: true });
    dialog.showModal();
  });
}

function resetCurrentDraft() {
  if (!state.currentImage) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  state.history = []; state.historyIndex = -1; updateHistoryButtons(); refreshMaskStatus(true); render();
}

async function clearMasks(imageIds, titleKey, messageKey) {
  if (!imageIds.length || isBusy() || state.importing) return;
  if (!await confirmAction(t(titleKey), t(messageKey))) return;
  ++state.imageGeneration;
  try {
    await api("/api/masks/clear", { method: "POST", body: JSON.stringify({ imageIds }) });
    for (const imageId of imageIds) state.drafts.delete(imageId);
    if (imageIds.includes(state.currentId)) {
      state.candidates = []; state.candidateImages.clear(); resetCurrentDraft();
      $("#candidateStatus").textContent = t("candidates.none"); renderCandidates();
    }
    state.images.forEach((image) => {
      if (imageIds.includes(image.id)) {
        image.candidateCount = 0;
        image.enabledCandidateCount = 0;
      }
    });
    imageIds.forEach((imageId) => state.maskStatus.delete(imageId));
    renderGallery(); setStatus(t("status.editReady"));
  } catch (error) { setStatus(error.message, "error"); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"))) return;
  const catalogGeneration = ++state.catalogGeneration;
  ++state.imageGeneration;
  try {
    await api("/api/catalog/clear", { method: "POST", body: JSON.stringify({}) });
    if (state.catalogGeneration !== catalogGeneration) return;
    state.images = []; state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
    state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); clearEditor(); renderGallery();
    setStatus(t("status.chooseFolder"));
  } catch (error) { setStatus(error.message, "error"); }
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(value);
}

async function directFilesFromDrop(dataTransfer) {
  const handles = [...dataTransfer.items]
    .map((item) => item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null)
    .filter(Boolean);
  if (handles.length) {
    const files = [];
    for (const handlePromise of handles) {
      const handle = await handlePromise;
      if (handle.kind === "file") files.push(await handle.getFile());
      else if (handle.kind === "directory") {
        for await (const entry of handle.values()) if (entry.kind === "file") files.push(await entry.getFile());
      }
    }
    return files;
  }
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const files = [];
    for (const entry of entries) {
      if (entry.isFile) files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
      else if (entry.isDirectory) {
        const reader = entry.createReader(); const children = [];
        while (true) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          children.push(...batch);
        }
        for (const child of children) if (child.isFile) files.push(await new Promise((resolve, reject) => child.file(resolve, reject)));
      }
    }
    return files;
  }
  return [...dataTransfer.files];
}

function isSupportedImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

async function importFiles(files) {
  if (isBusy() || state.importing) return;
  const supportedFiles = [...files].filter(isSupportedImageFile);
  if (!supportedFiles.length) return;
  state.importing = true;
  updateActionButtons();
  try {
    let data = null;
    for (const [index, file] of supportedFiles.entries()) {
      setStatus(t("gallery.importProgress", { completed: index + 1, total: supportedFiles.length }), "running");
      data = await api("/api/import", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: file.name, data: bytesToBase64(await file.arrayBuffer()) }] }),
      });
    }
    state.images = data.images; renderGallery(); setStatus(t("gallery.imported", { count: supportedFiles.length }));
  } catch (error) { setStatus(error.message, "error"); }
  finally { state.importing = false; updateActionButtons(); }
}

async function importDroppedFiles(event) {
  event.preventDefault();
  event.stopPropagation();
  $("#gallery").classList.remove("drag-over");
  try {
    await importFiles(await directFilesFromDrop(event.dataTransfer));
  } catch (error) { setStatus(error.message, "error"); }
}

function bindEvents() {
  $("#loadFolder").addEventListener("click", loadFolder); $("#pickFolder").addEventListener("click", openBrowseDialog);
  $("#browseFolderOption").addEventListener("click", () => { $("#browseDialog").close(); void pickFolder(); });
  $("#browseImagesOption").addEventListener("click", () => { $("#browseDialog").close(); $("#importFilesInput").click(); });
  $("#browseCancelButton").addEventListener("click", () => $("#browseDialog").close());
  $("#browseDialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  $("#importFilesInput").addEventListener("change", async (event) => {
    try { await importFiles(event.target.files); }
    finally { event.target.value = ""; }
  });
  $("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
  $("#detectAllButton").addEventListener("click", () => runDetection(state.images.map((image) => image.id)));
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId]));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"));
  $("#clearCatalogButton").addEventListener("click", clearCatalog);
  $("#galleryAllTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "all"; renderGallery(); });
  $("#galleryMaskedTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "masked"; renderGallery(); });
  $("#brushTool").addEventListener("click", () => setTool("brush")); $("#eraserTool").addEventListener("click", () => setTool("eraser")); $("#boundaryTool").addEventListener("click", () => setTool("boundary"));
  $("#mosaicPreviewButton").addEventListener("click", () => setMosaicPreviewEnabled(!state.mosaicPreviewEnabled));
  $("#brushSize").addEventListener("input", () => updateBrushSize($("#brushSize").value));
  $("#divisor").addEventListener("input", () => {
    if (isBusy() || state.importing) return;
    const divisor = normaliseDivisor($("#divisor").value);
    $("#divisor").value = divisor;
    rebuildMosaicPreview(); updateBlockSizeDisplay(); render();
  });
  $("#applyDivisor").addEventListener("input", () => { if (!isBusy() && !state.importing) updateBlockSizeDisplay(); });
  $("#confidence").addEventListener("input", () => { if (!isBusy() && !state.importing) $("#confidenceValue").textContent = Number($("#confidence").value).toFixed(2); });
  $("#undoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex - 1)); $("#redoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex + 1));
  $("#applyForm").addEventListener("submit", startApplyFromDialog);
  document.querySelectorAll('input[name="saveMode"]').forEach((input) => input.addEventListener("change", syncApplyMode));
  $("#applyCloseButton").addEventListener("click", () => $("#applyDialog").close());
  $("#applyPauseButton").addEventListener("click", () => controlApply(state.job?.state === "paused" ? "resume" : "pause"));
  $("#applyCancelButton").addEventListener("click", () => controlApply("cancel"));
  $("#applyDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!state.applyRunning) $("#applyDialog").close(); });
  $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#confirmDialog").close("cancel"); });
  $("#gallery").addEventListener("dragover", (event) => { event.preventDefault(); $("#gallery").classList.add("drag-over"); });
  $("#gallery").addEventListener("dragleave", () => $("#gallery").classList.remove("drag-over"));
  $("#gallery").addEventListener("drop", importDroppedFiles);

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    if (event.button === 1 || (state.spacePressed && event.button === 0)) {
      canvas.setPointerCapture(event.pointerId); state.panning = true; state.pointer = { x: event.clientX, y: event.clientY }; canvas.style.cursor = "grabbing"; return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const point = clampPoint(pointFromEvent(event));
    state.drawing = true; state.pointer = point; state.hover = point;
    if (state.tool === "boundary") { state.boundaryStart = point; state.boundaryStartClient = { x: event.clientX, y: event.clientY }; state.boundaryPoint = point; state.boundaryDragging = false; render(); return; }
    drawStroke(point, point, state.tool === "eraser"); render();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (isBusy() || state.importing) return;
    if (state.panning) {
      state.view.x += event.clientX - state.pointer.x; state.view.y += event.clientY - state.pointer.y; state.pointer = { x: event.clientX, y: event.clientY }; render(); return;
    }
    state.hover = clampPoint(pointFromEvent(event));
    if (state.drawing && (event.buttons & 1)) {
      const point = state.hover;
      if (state.tool === "boundary") {
        state.boundaryPoint = point;
        state.boundaryDragging ||= boundaryDragStarted(event);
      } else { drawStroke(state.pointer, point, state.tool === "eraser"); state.pointer = point; }
    }
    render();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (isBusy() || state.importing) return;
    if (state.drawing && event.button === 0 && state.tool === "boundary") {
      const point = clampPoint(pointFromEvent(event));
      const roi = roiFromPoints(state.boundaryStart, point);
      if (state.boundaryDragging && roi) { state.boundaryRoi = roi; setStatus(t("status.boundaryReady")); }
      else if (pointInBoundaryRoi(point)) void addBoundaryCandidate(point);
      state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false;
    } else if (state.drawing && event.button === 0) { pushHistory(); refreshMaskStatus(true); }
    state.drawing = false; state.panning = false; if (!state.spacePressed) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair"; render();
  });
  canvas.addEventListener("pointercancel", () => { state.drawing = false; state.panning = false; state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false; render(); });
  canvas.addEventListener("pointerleave", () => { state.hover = null; render(); });
  canvas.addEventListener("wheel", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    event.preventDefault();
    if (event.shiftKey) return updateBrushSize(Number($("#brushSize").value) * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    const rect = canvas.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
    const sourceX = (mouseX - state.view.x) / state.view.scale; const sourceY = (mouseY - state.view.y) / state.view.scale;
    state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    state.view.x = mouseX - sourceX * state.view.scale; state.view.y = mouseY - sourceY * state.view.scale; render();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (isBusy() || state.importing) return;
    if (event.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); state.spacePressed = true; canvas.style.cursor = "grab"; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); restoreSnapshot(event.shiftKey ? state.historyIndex + 1 : state.historyIndex - 1); }
  });
  window.addEventListener("keyup", (event) => { if (event.code === "Space") { state.spacePressed = false; if (!state.panning) canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair"; } });
}

async function initialise() {
  await loadTranslations(); bindEvents();
  new ResizeObserver(resizeRenderCanvas).observe(stage); setInterval(pollJob, 700);
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateActionButtons();
}

initialise();
