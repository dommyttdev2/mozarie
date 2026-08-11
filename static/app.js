const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], currentId: null, currentImage: null, pendingImageId: null, galleryFilter: "all", maskStatus: new Map(),
  viewMode: "edit", overviewFilter: "all", overviewQuery: "", overviewFolder: "", reviewedPaths: new Set(), reviewRoot: "",
  navigationShortcutsEnabled: true,
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", panning: false, drawing: false, boundaryPending: false,
  boundaryRoi: null, boundaryStart: null, boundaryStartClient: null, boundaryPoint: null, boundaryDragging: false,
  pointer: null, hover: null, history: [], historyIndex: -1,
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, imageGeneration: 0, catalogGeneration: 0, translations: {},
  applyTargetIds: [], applyRunning: false, applyFinishing: false, handledApplyStartedAt: null, importing: false, mosaicPreviewEnabled: true,
  detectionTargetIds: [], pendingDetectionTargetIds: [], detectCancelRequested: false,
  pageLoadedAt: Date.now() / 1000, handledDetectionStartedAt: null,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(),
  manualMaskPresent: false, manualEnabled: true,
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
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
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
function normaliseDetectionConfidence(value) { return Math.max(0.10, Math.min(1.00, Number(value) || 0.50)); }
function detectionConfidence() { return normaliseDetectionConfidence($("#confidence").value); }
function setDetectionConfidence(value) {
  const confidence = normaliseDetectionConfidence(value);
  $("#confidence").value = confidence.toFixed(2);
  $("#confidenceValue").textContent = confidence.toFixed(2);
  $("#detectConfidenceRange").value = confidence.toFixed(2);
  $("#detectConfidenceNumber").value = confidence.toFixed(2);
}
function activeDetection() { return state.job?.kind === "detect" && state.job?.state === "running"; }
function normaliseDivisor(value) { return Math.max(1, Math.min(10000, Math.round(Number(value) || 100))); }
function mosaicDivisor() { return normaliseDivisor($("#divisor").value); }
function calculatedBlockSize(image = currentRecord(), divisor = mosaicDivisor()) {
  return image ? Math.max(4, Math.ceil(Math.max(image.width, image.height) / divisor)) : 0;
}
function isBusy() { return ["running", "paused"].includes(state.job?.state) || state.saving || state.boundaryPending; }
function imageHasMask(image) { return state.maskStatus.get(image.id) ?? Number(image.enabledCandidateCount || 0) > 0; }
function saveTargets() { return state.images.filter(imageHasMask).map((image) => image.id); }
function normaliseReviewRoot(value) { return String(value || "").trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function reviewStoragePrefix() { return state.reviewRoot ? `lets-censoring.reviewed.v1:${state.reviewRoot}:` : ""; }
function reviewPath(image) { return String(image?.relativePath || "").replaceAll("\\", "/").toLowerCase(); }
function reviewStorageKey(image) { const prefix = reviewStoragePrefix(); const path = reviewPath(image); return prefix && path ? `${prefix}${path}` : ""; }
function isReviewed(image) { return state.reviewedPaths.has(reviewPath(image)); }
function loadReviewedPaths() {
  if (!reviewStoragePrefix()) { state.reviewedPaths = new Set(); return; }
  try {
    state.reviewedPaths = new Set(state.images
      .filter((image) => localStorage.getItem(reviewStorageKey(image)) === "true")
      .map(reviewPath));
  } catch { /* Keep the in-session review state when storage is unavailable. */ }
}
function refreshReviewViews() {
  renderGallery(true);
  if (state.viewMode === "overview") renderOverview();
  updateNavigationControls();
  updateActionButtons();
}
function setReviewed(image, reviewed) {
  if (!image) return;
  const path = reviewPath(image);
  const changed = reviewed ? !state.reviewedPaths.has(path) : state.reviewedPaths.has(path);
  if (!changed) return;
  if (reviewed) state.reviewedPaths.add(path); else state.reviewedPaths.delete(path);
  const key = reviewStorageKey(image);
  if (key) try { if (reviewed) localStorage.setItem(key, "true"); else localStorage.removeItem(key); } catch { /* Keep review state usable for this session. */ }
  refreshReviewViews();
}
function moveReviewedPathAfterApply(previousImage, reloadedImage) {
  const previousPath = reviewPath(previousImage);
  const reloadedPath = reviewPath(reloadedImage);
  if (!previousPath || !reloadedPath || previousPath === reloadedPath) return;

  const previousKey = reviewStorageKey(previousImage);
  const reloadedKey = reviewStorageKey(reloadedImage);
  let wasReviewed;
  try {
    const previousValue = previousKey ? localStorage.getItem(previousKey) : null;
    const reloadedValue = reloadedKey ? localStorage.getItem(reloadedKey) : null;
    wasReviewed = previousValue === "true" || reloadedValue === "true";
  } catch {
    wasReviewed = state.reviewedPaths.has(previousPath) || state.reviewedPaths.has(reloadedPath);
  }
  state.reviewedPaths.delete(previousPath);
  if (!wasReviewed) state.reviewedPaths.delete(reloadedPath);
  else state.reviewedPaths.add(reloadedPath);

  try {
    if (previousKey) localStorage.removeItem(previousKey);
    if (reloadedKey) {
      if (wasReviewed) localStorage.setItem(reloadedKey, "true");
      else localStorage.removeItem(reloadedKey);
    }
  } catch { /* Keep the reviewed paths migrated for this session. */ }
}
function markImagesUnreviewed(imageIds, renderAfter = true) {
  let changed = false;
  for (const imageId of imageIds) {
    const image = state.images.find((item) => item.id === imageId);
    if (!image) continue;
    const path = reviewPath(image);
    if (!state.reviewedPaths.delete(path)) continue;
    changed = true;
    const key = reviewStorageKey(image);
    if (key) try { localStorage.removeItem(key); } catch { /* Keep review state usable for this session. */ }
  }
  if (!changed) return false;
  if (renderAfter) refreshReviewViews();
  return true;
}
function markCurrentUnreviewed(renderAfter = true) { return markImagesUnreviewed([state.currentId], renderAfter); }
function refreshCurrentReviewAndMask() {
  const reviewChanged = markCurrentUnreviewed(false);
  const maskChanged = refreshMaskStatus(true);
  if (reviewChanged && !maskChanged) refreshReviewViews();
  return reviewChanged || maskChanged;
}
function imageIndex(imageId = state.currentId) { return state.images.findIndex((image) => image.id === imageId); }
function hasOpenDialog() { return [...document.querySelectorAll("dialog")].some((dialog) => dialog.open); }
function isEditableTarget(target) {
  return Boolean(target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target?.tagName));
}
function focusElement(element) { element?.focus({ preventScroll: true }); }
function focusCanvas() { focusElement(canvas); }
function setNavigationShortcutsEnabled(enabled) {
  state.navigationShortcutsEnabled = Boolean(enabled);
  try { localStorage.setItem("lets-censoring.navigation-shortcuts.v1", String(state.navigationShortcutsEnabled)); } catch { /* Session setting still applies. */ }
  updateNavigationControls();
  focusCanvas();
}
function handleReviewStorageEvent(event) {
  const prefix = reviewStoragePrefix();
  if (!prefix || !event.key?.startsWith(prefix)) return;
  const path = event.key.slice(prefix.length);
  if (!path) return;
  if (event.newValue === "true") state.reviewedPaths.add(path);
  else state.reviewedPaths.delete(path);
  refreshReviewViews();
}

function updateActionButtons() {
  const running = isBusy();
  const locked = running || state.importing;
  const mutatingCandidates = state.candidateUpdateChains.size > 0;
  const detecting = activeDetection();
  const current = currentRecord();
  const hasImage = Boolean(state.currentId && state.currentImage && current);
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
  const detectAllButton = $("#detectAllButton");
  detectAllButton.textContent = t(detecting ? (state.detectCancelRequested ? "detectDialog.stopping" : "detectDialog.stop") : "gallery.detectAll");
  detectAllButton.classList.toggle("detect-stop", detecting);
  detectAllButton.disabled = detecting ? state.detectCancelRequested : (running || state.images.length === 0);
  $("#detectCurrentButton").disabled = running || !hasImage;
  $("#clearCurrentMasksButton").disabled = running || !hasImage;
  $("#clearAllMasksButton").disabled = running || state.images.length === 0;
  $("#clearCatalogButton").disabled = running || state.images.length === 0;
  $("#batchMoreButton").disabled = running || state.images.length === 0;
  $("#galleryAllTab").disabled = running;
  $("#galleryMaskedTab").disabled = running;
  $("#saveAllButton").disabled = running || mutatingCandidates || saveTargets().length === 0;
  $("#saveButton").disabled = running || mutatingCandidates || !hasImage || !imageHasMask(current);
  $("#applyStartButton").disabled = running || mutatingCandidates;
  $("#overviewButton").disabled = running || state.images.length === 0;
  $("#previousImageButton").disabled = running || imageIndex() <= 0;
  $("#nextImageButton").disabled = running || imageIndex() < 0 || imageIndex() >= state.images.length - 1;
  $("#nextUnreviewedButton").disabled = running || !nextUnreviewedImage();
  $("#reviewAndNextButton").disabled = running || !hasImage;
  $("#navigationShortcutsEnabled").disabled = running;
  updateHistoryButtons();
  if (locked) for (const control of controls) {
    if (["applyPauseButton", "applyCancelButton"].includes(control.id) && state.applyRunning) continue;
    if (control.id === "detectAllButton" && detecting && !state.detectCancelRequested) continue;
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

function resetCatalog(images, root) {
  state.images = images;
  state.reviewRoot = normaliseReviewRoot(root);
  loadReviewedPaths();
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
  state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); state.boundaryRoi = null;
  renderCatalogViews(); clearEditor();
}

function updateProgress(job) {
  const progress = $("#jobProgress");
  const progressText = $("#jobProgressText");
  const running = ["running", "paused"].includes(job?.state);
  progress.hidden = !running;
  progressText.hidden = !running;
  if (running) {
    progress.max = Math.max(1, Number(job.total) || 1);
    progress.value = Math.min(progress.max, Number(job.completed) || 0);
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
    resetCatalog(data.images, path);
    setStatus(t("status.imagesLoaded", { count: state.images.length }));
  } catch (error) { setStatus(error.message, "error"); }
}


function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const gallery = $("#gallery");
  const scrollTop = gallery.scrollTop;
  gallery.textContent = "";
  const visibleImages = state.galleryFilter === "masked" ? state.images.filter(imageHasMask) : state.images;
  $("#imageCount").textContent = t("gallery.count", { count: visibleImages.length });
  $("#galleryAllTab").classList.toggle("active", state.galleryFilter === "all");
  $("#galleryAllTab").setAttribute("aria-pressed", String(state.galleryFilter === "all"));
  $("#galleryMaskedTab").classList.toggle("active", state.galleryFilter === "masked");
  $("#galleryMaskedTab").setAttribute("aria-pressed", String(state.galleryFilter === "masked"));
  $("#batchImageCount").textContent = t("gallery.count", { count: state.images.length });
  const template = $("#galleryItemTemplate");
  for (const image of visibleImages) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    item.classList.toggle("reviewed", isReviewed(image));
    const preview = item.querySelector("img");
    preview.src = `/api/thumbnail/${encodeURIComponent(image.id)}`;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    const reviewBadge = item.querySelector(".gallery-review-badge");
    reviewBadge.textContent = isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.addEventListener("click", () => selectImage(image.id));
    gallery.append(item);
  }
  gallery.scrollTop = scrollTop;
  updateActionButtons();
}

function updateGallerySelection() {
  for (const item of $("#gallery").children) item.classList.toggle("selected", item.dataset.id === state.currentId);
  updateActionButtons();
}

function overviewFolderOptions() {
  const folders = new Set();
  for (const image of state.images) {
    const parts = image.relativePath.replaceAll("\\", "/").split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}
function overviewImages() {
  const query = state.overviewQuery.trim().toLowerCase();
  const folder = state.overviewFolder;
  return state.images.filter((image) => {
    if (state.overviewFilter === "unreviewed" && isReviewed(image)) return false;
    if (state.overviewFilter === "reviewed" && !isReviewed(image)) return false;
    if (state.overviewFilter === "masked" && !imageHasMask(image)) return false;
    const path = image.relativePath.replaceAll("\\", "/");
    if (folder && path !== folder && !path.startsWith(`${folder}/`)) return false;
    return !query || path.toLowerCase().includes(query);
  });
}
function syncOverviewFolders() {
  const select = $("#overviewFolder");
  const options = overviewFolderOptions();
  if (state.overviewFolder && !options.includes(state.overviewFolder)) state.overviewFolder = "";
  select.textContent = "";
  const all = document.createElement("option"); all.value = ""; all.textContent = t("overview.folder"); select.append(all);
  for (const folder of options) {
    const option = document.createElement("option"); option.value = folder; option.textContent = folder; select.append(option);
  }
  select.value = state.overviewFolder;
}
function renderOverview(force = false) {
  if (!force && state.viewMode !== "overview") return;
  const grid = $("#overviewGrid");
  if (!grid) return;
  syncOverviewFolders();
  const visibleImages = overviewImages();
  grid.textContent = "";
  $("#overviewCount").textContent = t("overview.count", { visible: visibleImages.length, total: state.images.length });
  document.querySelectorAll(".overview-filter").forEach((button) => {
    const active = button.dataset.overviewFilter === state.overviewFilter;
    button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
  });
  const template = $("#overviewItemTemplate");
  for (const image of visibleImages) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    const preview = item.querySelector("img");
    preview.src = `/api/thumbnail/${encodeURIComponent(image.id)}`; preview.alt = image.relativePath;
    item.querySelector(".overview-item-name").textContent = image.relativePath.split(/[\\/]/).pop();
    item.querySelector(".overview-item-path").textContent = image.relativePath;
    const statuses = [];
    statuses.push(isReviewed(image) ? t("overview.stateReviewed") : t("overview.stateUnreviewed"));
    if (imageHasMask(image)) statuses.push(t("overview.stateMasked"));
    const stateLabel = item.querySelector(".overview-item-state");
    stateLabel.textContent = statuses.join(" / ");
    stateLabel.classList.toggle("reviewed", isReviewed(image));
    stateLabel.classList.toggle("masked", imageHasMask(image));
    item.addEventListener("click", () => { setViewMode("edit"); void selectImage(image.id); });
    grid.append(item);
  }
}
function renderCatalogViews() { renderGallery(); renderOverview(); }
function setViewMode(mode, refreshGallery = true) {
  state.viewMode = mode;
  const active = mode === "overview";
  $(".studio-grid").classList.toggle("overview-active", active);
  $("#overviewPane").hidden = !active;
  if (!active) { if (refreshGallery) renderGallery(true); resizeRenderCanvas(); focusCanvas(); return; }
  renderOverview(true);
  requestAnimationFrame(() => {
    const current = [...$("#overviewGrid").children].find((item) => item.dataset.id === state.currentId);
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
    focusElement($("#overviewPane"));
  });
}
function moveCurrentBy(offset) {
  const index = imageIndex();
  const target = state.images[index + offset];
  if (target) void selectImage(target.id);
}
function nextUnreviewedImage() {
  const current = imageIndex();
  for (let index = Math.max(0, current + 1); index < state.images.length; index += 1) if (!isReviewed(state.images[index])) return state.images[index];
  return null;
}
function moveToNextUnreviewed() { const target = nextUnreviewedImage(); if (target) void selectImage(target.id); }
function reviewAndMoveNext() {
  const current = currentRecord();
  if (!current) return null;
  const target = state.images[imageIndex(current.id) + 1] || null;
  setReviewed(current, true);
  if (target) void selectImage(target.id);
  return target;
}
function runNavigationAction(action) {
  action();
  focusCanvas();
}
function updateNavigationControls() {
  const index = imageIndex();
  $("#imagePosition").textContent = index < 0 ? "- / -" : `${index + 1} / ${state.images.length}`;
  $("#navigationShortcutsEnabled").checked = state.navigationShortcutsEnabled;
  const status = $("#reviewStatus");
  const reviewed = isReviewed(currentRecord());
  status.textContent = currentRecord() ? t(reviewed ? "review.reviewed" : "review.unreviewed") : t("review.unreviewed");
  status.classList.toggle("reviewed", Boolean(currentRecord()) && reviewed);
}

function canvasSizeForImage(image) {
  for (const target of [addCanvas, exclusionCanvas, combinedCanvas, mosaicCanvas]) { target.width = image.width; target.height = image.height; }
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
  state.manualMaskPresent = false;
  state.manualEnabled = true;
}

function clearEditor() {
  state.history = []; state.historyIndex = -1; state.hover = null; clearBoundaryInteraction();
  state.manualMaskPresent = false; state.manualEnabled = true;
  addCanvas.width = exclusionCanvas.width = combinedCanvas.width = mosaicCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = combinedCanvas.height = mosaicCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#imageInfo").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons(); render();
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
    syncCandidateRecord(imageId, candidateBundle.candidates);
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
    updateCandidateStatus();
    renderCandidates(); updateGallerySelection(); updateNavigationControls(); updateActionButtons(); render(); setStatus(t("status.editReady"));
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
  refreshMaskStatus(true); updateCandidateStatus(); renderCandidates(); render();
  return true;
}

function canvasHasPixels(context, target) {
  return context.getImageData(0, 0, target.width, target.height).data.some((value) => value > 0);
}

function syncCandidateRecord(imageId, candidates) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  record.candidateCount = candidates.length;
  record.enabledCandidateCount = candidates.filter((candidate) => candidate.enabled).length;
}

function syncCurrentCandidateRecord() { syncCandidateRecord(state.currentId, state.candidates); }

async function refreshCandidateRecord(imageId) {
  const data = await api(`/api/candidates/${encodeURIComponent(imageId)}`);
  syncCandidateRecord(imageId, data.candidates);
  return data.candidates;
}

function updateCandidateStatus() {
  const status = $("#candidateStatus");
  if (!state.currentId) { status.textContent = t("candidates.unselected"); return; }
  if (state.manualMaskPresent) {
    status.textContent = state.candidates.length
      ? t("candidates.countWithManual", { count: state.candidates.length })
      : t("candidates.manualOnly");
    return;
  }
  status.textContent = state.candidates.length ? t("candidates.count", { count: state.candidates.length }) : t("candidates.none");
}

function saveDraft() {
  if (!state.currentId || !state.currentImage) return;
  state.drafts.set(state.currentId, {
    add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png"),
    manualEnabled: state.manualEnabled, manualMaskPresent: state.manualMaskPresent,
  });
}

function restoreDraft(imageId, generation) {
  const draft = state.drafts.get(imageId);
  state.history = []; state.historyIndex = -1;
  state.manualEnabled = draft?.manualEnabled !== false;
  state.manualMaskPresent = false;
  if (!draft) { pushHistory(); updateCandidateStatus(); renderCandidates(); return; }
  Promise.all([loadImage(draft.add), loadImage(draft.exclusion)]).then(([addImage, exclusionImage]) => {
    if (state.currentId !== imageId || state.imageGeneration !== generation) return;
    addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0);
    state.manualMaskPresent = draft.manualMaskPresent ?? canvasHasPixels(addCtx, addCanvas);
    pushHistory(); refreshMaskStatus(true); updateCandidateStatus(); renderCandidates(); render();
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
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
}

function maskStatusWithoutCandidate(candidateId) {
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (candidate.id !== candidateId && candidate.enabled) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  const hasMask = canvasHasPixels(combinedCtx, combinedCanvas);
  composeCurrentMask();
  return hasMask;
}

function refreshMaskStatus(renderGalleryAfter = false) {
  if (!state.currentId || !state.currentImage) return;
  const record = currentRecord();
  const previous = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : Boolean(record && Number(record.enabledCandidateCount || 0) > 0);
  composeCurrentMask();
  const current = combinedCtx.getImageData(0, 0, combinedCanvas.width, combinedCanvas.height).data.some((value) => value > 0);
  state.maskStatus.set(state.currentId, current);
  if (renderGalleryAfter && previous !== current) renderCatalogViews();
  else updateActionButtons();
  return previous !== current;
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
  if (!state.candidates.length && !state.manualMaskPresent) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty); return;
  }
  if (state.manualMaskPresent) {
    const row = document.createElement("div"); row.className = "candidate-row candidate-row-manual";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = state.manualEnabled;
    enabled.setAttribute("aria-label", t("candidates.manualToggle"));
    enabled.addEventListener("change", () => {
      if (isBusy() || state.importing) { enabled.checked = state.manualEnabled; return; }
      state.manualEnabled = enabled.checked; pushHistory(); refreshCurrentReviewAndMask(); render();
    });
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = t("candidates.manual");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×";
    remove.title = t("candidates.deleteManual"); remove.setAttribute("aria-label", t("candidates.deleteManual"));
    remove.addEventListener("click", deleteManualMask);
    row.append(enabled, label, remove); list.append(row);
  }
  for (const candidate of state.candidates) {
    const key = candidateMutationKey(state.currentId, candidate.id);
    const deleting = state.candidateDeleting.has(key);
    const row = document.createElement("div"); row.className = "candidate-row";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = candidate.enabled; enabled.disabled = deleting;
    enabled.setAttribute("aria-label", t("candidates.toggle", { label: candidate.className }));
    enabled.addEventListener("change", async () => {
      if (isBusy() || state.importing) { enabled.checked = candidate.enabled; return; }
      const previousEnabled = candidate.enabled;
      const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
      candidate.enabled = enabled.checked;
      syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); render(); await updateCandidate(candidate, previousEnabled, previousMaskStatus);
    });
    const label = document.createElement("span"); label.className = "candidate-label";
    label.innerHTML = `<span class="candidate-class">${escapeHtml(candidate.className)}</span><span class="candidate-conf">${Math.round(candidate.confidence * 100)}%</span>`;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = deleting;
    const deleteLabel = t("candidates.delete", { label: candidate.className });
    remove.title = deleteLabel; remove.setAttribute("aria-label", deleteLabel);
    remove.addEventListener("click", () => deleteCandidate(candidate));
    row.append(enabled, label, remove); list.append(row);
  }
}

function candidateMutationKey(imageId, candidateId) { return `${imageId}:${candidateId}`; }
function nextCandidateMutationVersion(key) {
  const version = (state.candidateUpdateVersions.get(key) || 0) + 1;
  state.candidateUpdateVersions.set(key, version);
  return version;
}
function enqueueCandidateMutation(key, send) {
  const previous = state.candidateUpdateChains.get(key) || Promise.resolve();
  const queued = previous.then(send, send);
  const tracked = queued.finally(() => {
    if (state.candidateUpdateChains.get(key) === tracked) state.candidateUpdateChains.delete(key);
    updateActionButtons();
  });
  state.candidateUpdateChains.set(key, tracked);
  updateActionButtons();
  return tracked;
}

async function waitForCandidateMutations() {
  while (state.candidateUpdateChains.size) {
    await Promise.allSettled([...state.candidateUpdateChains.values()]);
  }
}

async function updateCandidate(candidate, previousEnabled, previousMaskStatus) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  const targetCandidates = [...state.candidates];
  const key = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(key);
  const desired = candidate.enabled;
  const send = async () => {
    try {
      await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color }),
      });
    } catch (error) {
      if (state.candidateUpdateVersions.get(key) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        try {
          if (await reconcileCurrentCandidates(imageId, generation)) {
            setStatus(error.message, "error");
            return;
          }
        } catch {
          if (state.currentId === imageId && isCurrentGeneration(generation)) {
            candidate.enabled = previousEnabled; syncCurrentCandidateRecord(); refreshMaskStatus(true); renderCandidates(); render();
            setStatus(error.message, "error");
            return;
          }
        }
      }
      candidate.enabled = previousEnabled;
      syncCandidateRecord(imageId, targetCandidates);
      if (previousMaskStatus !== undefined) state.maskStatus.set(imageId, previousMaskStatus);
      try {
        const candidates = await refreshCandidateRecord(imageId);
        if (previousMaskStatus === undefined) state.maskStatus.set(imageId, candidates.some((item) => item.enabled));
      } catch { /* The local rollback already removed the optimistic aggregate. */ }
      renderCatalogViews();
    }
  };
  return enqueueCandidateMutation(key, send);
}

async function deleteCandidate(candidate) {
  if (!state.currentId || isBusy() || state.importing) return;
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  const key = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(key);
  const remainingCandidates = state.candidates.filter((item) => item.id !== candidate.id);
  const remainingMaskStatus = maskStatusWithoutCandidate(candidate.id);
  state.candidateDeleting.add(key); renderCandidates();
  const send = async () => {
    try {
      await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
      if (state.candidateUpdateVersions.get(key) !== version) return;
      syncCandidateRecord(imageId, remainingCandidates);
      state.maskStatus.set(imageId, remainingMaskStatus);
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        state.candidates = remainingCandidates;
        state.candidateImages.delete(candidate.id);
        updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId); } catch { /* The known deletion is already reflected locally. */ }
      }
      renderCatalogViews();
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation) && state.candidateUpdateVersions.get(key) === version) {
        try { await reconcileCurrentCandidates(imageId, generation); } catch { /* Keep the existing coherent row. */ }
        setStatus(error.message, "error");
      }
    } finally {
      if (state.candidateUpdateVersions.get(key) === version) {
        state.candidateDeleting.delete(key);
        if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
      }
    }
  };
  return enqueueCandidateMutation(key, send);
}

function deleteManualMask() {
  if (!state.manualMaskPresent || isBusy() || state.importing) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true;
  pushHistory(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

async function addBoundaryCandidate(point) {
  if (!state.currentId || !state.boundaryRoi || isBusy()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const roi = { ...state.boundaryRoi };
  const targetPoint = { ...point };
  let catalogChanged = false;
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
    state.maskStatus.delete(imageId);
    catalogChanged = true;
    markImagesUnreviewed([imageId], false);
    if (state.currentId !== imageId || state.imageGeneration !== viewGeneration) return;

    const maskImage = await loadCandidateMask(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?t=${Date.now()}`);
    if (state.currentId !== imageId || state.imageGeneration !== viewGeneration) return;
    if (state.candidates.some((item) => item.id === candidate.id)) return;
    state.candidates.push(candidate);
    state.candidateImages.set(candidate.id, maskImage);
    state.boundaryRoi = null;
    $("#candidateStatus").textContent = t("candidates.count", { count: state.candidates.length });
    refreshMaskStatus(false);
    renderCandidates(); render(); setStatus(t("status.boundaryDone"));
  } catch (error) { if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error"); }
  finally {
    state.boundaryPending = false;
    if (catalogChanged) renderCatalogViews();
    updateActionButtons();
  }
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
function snapshot() {
  return {
    add: addCanvas.toDataURL("image/png"), exclusion: exclusionCanvas.toDataURL("image/png"),
    manualEnabled: state.manualEnabled, manualMaskPresent: state.manualMaskPresent,
  };
}

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
  addCtx.drawImage(addImage, 0, 0); exclusionCtx.drawImage(exclusionImage, 0, 0);
  state.manualEnabled = entry.manualEnabled !== false;
  state.manualMaskPresent = entry.manualMaskPresent ?? canvasHasPixels(addCtx, addCanvas);
  state.historyIndex = index; updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
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

function openDetectionDialog(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.pendingDetectionTargetIds = [...imageIds];
  setDetectionConfidence(detectionConfidence());
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  $("#detectDialog").showModal();
}

async function runDetection(imageIds, confidence = detectionConfidence()) {
  if (!imageIds.length || isBusy() || state.importing) return;
  try {
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence }) });
    state.detectionTargetIds = [...imageIds];
    state.detectCancelRequested = false;
    state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "" };
    updateProgress(state.job); setStatus(t("status.detectStarted"), "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  const imageIds = state.pendingDetectionTargetIds;
  if (!imageIds.length) return;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  setDetectionConfidence(confidence);
  $("#detectDialog").close();
  state.pendingDetectionTargetIds = [];
  await runDetection(imageIds, confidence);
}

async function cancelDetection() {
  if (!activeDetection() || state.detectCancelRequested) return;
  state.detectCancelRequested = true;
  updateActionButtons();
  setStatus(t("status.detectCancelling"), "running");
  try { await api("/api/job/cancel", { method: "POST", body: JSON.stringify({}) }); }
  catch (error) { state.detectCancelRequested = false; updateActionButtons(); setStatus(error.message, "error"); }
}

async function saveCurrent() {
  const imageId = state.currentId;
  if (isBusy() || state.importing || !imageId) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const record = state.images.find((image) => image.id === imageId);
  if (isBusy() || state.importing || state.currentId !== imageId || !record || !imageHasMask(record)) return;
  await openApplyDialog([imageId]);
}

async function saveAll() {
  if (isBusy() || state.importing) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (isBusy() || state.importing) return;
  saveDraft(); refreshMaskStatus();
  const imageIds = saveTargets();
  if (imageIds.length) await openApplyDialog(imageIds);
}

function setApplyResult(message, error = false) {
  const result = $("#applyResult"); result.textContent = message; result.classList.toggle("error", error);
}

function isTerminalApply(job) {
  if (job.kind !== "apply" || !["complete", "cancelled", "error"].includes(job.state)) return false;
  return state.applyRunning || (job.startedAt != null && state.handledApplyStartedAt !== job.startedAt);
}

function selectedSaveMode() { return document.querySelector('input[name="saveMode"]:checked').value; }
function applyTargetsContainSessionImage() {
  return state.applyTargetIds.some((imageId) => state.images.find((image) => image.id === imageId)?.sourceKind === "session");
}

function syncApplyMode() {
  const containsSessionImage = applyTargetsContainSessionImage();
  if (containsSessionImage) {
    $("#applyCopyMode").checked = true;
    $("#deleteOriginal").checked = false;
  }
  const copying = selectedSaveMode() === "copy";
  $("#applySuffix").disabled = !copying || state.applyRunning;
  $("#deleteOriginalRow").hidden = !copying || containsSessionImage;
  $("#deleteOriginal").disabled = !copying || containsSessionImage || state.applyRunning;
  $("#applyOverwriteMode").disabled = containsSessionImage || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", containsSessionImage);
  $("#applyTemporarySourceNote").hidden = !containsSessionImage;
}

async function openApplyDialog(imageIds) {
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (!imageIds.length || isBusy() || state.importing) return;
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
    if (draft) drafts[imageId] = {
      add: draft.manualEnabled === false ? "" : draft.add,
      exclusion: draft.exclusion,
    };
  }
  return drafts;
}

async function startApplyFromDialog(event) {
  event.preventDefault();
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (isBusy() || state.importing) return;
  const imageIds = state.applyTargetIds;
  if (!imageIds.length) return;
  const copy = selectedSaveMode() === "copy" || applyTargetsContainSessionImage();
  const suffix = $("#applySuffix").value.trim();
  if (copy && !suffix) return setApplyResult(t("error.requestFailed"), true);
  try {
    const result = await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({
        imageIds, divisor: Number($("#applyDivisor").value), mode: copy ? "copy" : "overwrite",
        suffix: copy ? suffix : "_censored", deleteOriginal: copy && $("#deleteOriginal").checked,
        drafts: draftPayload(imageIds),
      }),
    });
    if (result.cancelled) return;
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
    const previousImagesById = new Map(state.images.map((image) => [image.id, image]));
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : (job.state === "complete" ? requestedImageIds : []);
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const data = await api("/api/images");
    if (!isCurrentGeneration(generation)) return;
    state.images = data.images;
    const reloadedImagesById = new Map(state.images.map((image) => [image.id, image]));
    for (const imageId of completedImageIds) {
      const previousImage = previousImagesById.get(imageId);
      const reloadedImage = reloadedImagesById.get(imageId);
      if (previousImage && reloadedImage) moveReviewedPathAfterApply(previousImage, reloadedImage);
    }
    state.maskStatus.clear();
    for (const imageId of completedImageIds) state.drafts.delete(imageId);
    state.applyTargetIds = requestedImageIds;
    if (reloadCurrent) {
      state.candidates = [];
      state.candidateImages.clear();
    }
    const reloadedCurrent = reloadCurrent && state.images.some((image) => image.id === keepCurrent);
    if (reloadedCurrent) {
      await selectImage(keepCurrent, true, { saveCurrentDraft: false });
    } else if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
      refreshMaskStatus();
      renderCandidates();
      render();
    }
    else { state.currentId = null; state.currentImage = null; clearEditor(); }
    renderCatalogViews();
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

function isTerminalDetection(job, previous) {
  if (job.kind !== "detect" || !["complete", "cancelled"].includes(job.state) || job.startedAt == null || state.handledDetectionStartedAt === job.startedAt) return false;
  const observedRunning = previous?.kind === "detect" && previous?.startedAt === job.startedAt && ["running", "paused"].includes(previous.state);
  return observedRunning || Number(job.startedAt) >= state.pageLoadedAt;
}

async function finishDetectionJob(job) {
  const generation = ++state.imageGeneration;
  const keepCurrent = state.currentId;
  const requestedIds = Array.isArray(job.imageIds) && job.imageIds.length ? job.imageIds : state.detectionTargetIds;
  const targetIds = Array.isArray(job.completedImageIds) && job.completedImageIds.length
    ? job.completedImageIds
    : (job.state === "complete" ? requestedIds : []);
  const data = await api("/api/images");
  if (!isCurrentGeneration(generation)) return;
  state.images = data.images;
  state.maskStatus.clear();
  markImagesUnreviewed(targetIds, false);
  state.handledDetectionStartedAt = job.startedAt;
  state.detectionTargetIds = [];
  state.detectCancelRequested = false;
  if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
    await selectImage(keepCurrent, true);
  }
  renderCatalogViews();
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
      state.detectCancelRequested = false;
      setStatus(job.error || t("error.background"), "error");
  } else if (isTerminalDetection(job, previous)) {
    await finishDetectionJob(job);
      setStatus(job.state === "cancelled" ? t("status.detectCancelled", { completed: job.completed }) : t("status.detectDone"));
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
  state.manualMaskPresent = false; state.manualEnabled = true;
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
    markImagesUnreviewed(imageIds, false);
    renderCatalogViews(); updateNavigationControls(); setStatus(t("status.editReady"));
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
    state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); state.overviewFolder = ""; clearEditor(); renderCatalogViews();
    setStatus(t("status.chooseFolder"));
  } catch (error) { setStatus(error.message, "error"); }
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer); let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(value);
}

function droppedFile(file, relativePath = file.name) { return { file, relativePath }; }

async function directFilesFromDrop(dataTransfer) {
  const handles = [...dataTransfer.items]
    .map((item) => item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null)
    .filter(Boolean);
  if (handles.length) {
    const files = [];
    async function collectHandle(handle, parent = "") {
      const relativePath = parent ? `${parent}/${handle.name}` : handle.name;
      if (handle.kind === "file") files.push(droppedFile(await handle.getFile(), relativePath));
      else for await (const entry of handle.values()) await collectHandle(entry, relativePath);
    }
    for (const handlePromise of handles) {
      const handle = await handlePromise;
      await collectHandle(handle);
    }
    return files;
  }
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const files = [];
    async function collectEntry(entry, parent = "") {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isFile) files.push(droppedFile(await new Promise((resolve, reject) => entry.file(resolve, reject)), relativePath));
      else if (entry.isDirectory) {
        const reader = entry.createReader(); const children = [];
        while (true) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          children.push(...batch);
        }
        for (const child of children) await collectEntry(child, relativePath);
      }
    }
    for (const entry of entries) await collectEntry(entry);
    return files;
  }
  return [...dataTransfer.files].map((file) => droppedFile(file));
}

function isSupportedImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

async function importFiles(files) {
  if (isBusy() || state.importing) return;
  const supportedFiles = [...files]
    .map((entry) => entry.file ? entry : { file: entry, relativePath: entry.webkitRelativePath || entry.name })
    .filter(({ file }) => isSupportedImageFile(file));
  if (!supportedFiles.length) return;
  state.importing = true;
  updateActionButtons();
  try {
    let data = null;
    for (const [index, { file, relativePath }] of supportedFiles.entries()) {
      setStatus(t("gallery.importProgress", { completed: index + 1, total: supportedFiles.length }), "running");
      data = await api("/api/import", {
        method: "POST",
        body: JSON.stringify({ files: [{ name: file.name, relativePath, data: bytesToBase64(await file.arrayBuffer()) }] }),
      });
    }
    state.images = data.images; renderCatalogViews(); setStatus(t("gallery.imported", { count: supportedFiles.length }));
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

function handleEditorKeydown(event) {
  if (isBusy() || state.importing || isEditableTarget(document.activeElement) || hasOpenDialog()) return false;
  if (state.viewMode !== "edit") return false;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    void restoreSnapshot(event.shiftKey ? state.historyIndex + 1 : state.historyIndex - 1);
    return true;
  }
  return false;
}

function navigationShortcutAction(event) {
  if (isBusy() || state.importing || !state.navigationShortcutsEnabled || isEditableTarget(document.activeElement) || hasOpenDialog()) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === "g" || event.key === "G") return "toggleOverview";
  if (state.viewMode !== "edit") return null;
  if (event.key === "ArrowLeft") return "previous";
  if (event.key === "ArrowRight" && event.shiftKey) return "nextUnreviewed";
  if (event.key === "ArrowRight") return "next";
  if (event.key === "Home") return "first";
  if (event.key === "End") return "last";
  if (event.key === "Enter") return "reviewAndNext";
  return null;
}

function handleNavigationKeydown(event) {
  const action = navigationShortcutAction(event);
  if (!action) return false;
  event.preventDefault();
  if (action === "toggleOverview") setViewMode(state.viewMode === "overview" ? "edit" : "overview");
  else if (action === "previous") moveCurrentBy(-1);
  else if (action === "next") moveCurrentBy(1);
  else if (action === "nextUnreviewed") moveToNextUnreviewed();
  else if (action === "first" && state.images[0]) void selectImage(state.images[0].id);
  else if (action === "last" && state.images.at(-1)) void selectImage(state.images.at(-1).id);
  else if (action === "reviewAndNext") reviewAndMoveNext();
  return true;
}

function handleWindowKeydown(event) {
  if (handleEditorKeydown(event)) return;
  handleNavigationKeydown(event);
}

function openImportPicker(inputId) {
  $("#pickerMenu").hidePopover();
  $(inputId).click();
}

function closeBatchMoreMenu() {
  const menu = $("#batchMoreMenu");
  if (menu.matches(":popover-open")) menu.hidePopover();
}

function bindEvents() {
  $("#pickImages").addEventListener("click", () => openImportPicker("#importImagesInput"));
  $("#pickFolderFiles").addEventListener("click", () => openImportPicker("#importFolderInput"));
  for (const inputId of ["#importImagesInput", "#importFolderInput"]) $(inputId).addEventListener("change", (event) => {
    const input = event.currentTarget;
    const files = [...input.files];
    input.value = "";
    if (files.length) void importFiles(files);
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) void importDroppedFiles(event);
  });
  $("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
  $("#detectAllButton").addEventListener("click", () => {
    if (activeDetection()) void cancelDetection();
    else openDetectionDialog(state.images.map((image) => image.id));
  });
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId], detectionConfidence()));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => { closeBatchMoreMenu(); void clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"); });
  $("#clearCatalogButton").addEventListener("click", () => { closeBatchMoreMenu(); void clearCatalog(); });
  $("#batchMoreMenu").addEventListener("toggle", () => {
    $("#batchMoreButton").setAttribute("aria-expanded", String($("#batchMoreMenu").matches(":popover-open")));
  });
  $("#galleryAllTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "all"; renderGallery(); });
  $("#galleryMaskedTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "masked"; renderGallery(); });
  $("#overviewButton").addEventListener("click", () => { if (!isBusy() && !state.importing) setViewMode("overview"); });
  $("#closeOverviewButton").addEventListener("click", () => setViewMode("edit"));
  $("#previousImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(-1)));
  $("#nextImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(1)));
  $("#nextUnreviewedButton").addEventListener("click", () => runNavigationAction(moveToNextUnreviewed));
  $("#reviewAndNextButton").addEventListener("click", () => runNavigationAction(reviewAndMoveNext));
  $("#navigationShortcutsEnabled").addEventListener("change", (event) => {
    setNavigationShortcutsEnabled(event.target.checked);
  });
  document.querySelectorAll(".overview-filter").forEach((button) => button.addEventListener("click", () => {
    if (isBusy() || state.importing) return;
    state.overviewFilter = button.dataset.overviewFilter; renderOverview();
  }));
  let overviewQueryTimer = null;
  $("#overviewQuery").addEventListener("input", (event) => {
    state.overviewQuery = event.target.value;
    clearTimeout(overviewQueryTimer);
    overviewQueryTimer = setTimeout(() => renderOverview(), 120);
  });
  $("#overviewFolder").addEventListener("change", (event) => { state.overviewFolder = event.target.value; renderOverview(); });
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
  $("#confidence").addEventListener("input", () => { if (!isBusy() && !state.importing) setDetectionConfidence($("#confidence").value); });
  $("#detectConfidenceRange").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceRange").value));
  $("#detectConfidenceNumber").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceNumber").value));
  $("#detectForm").addEventListener("submit", startDetectionFromDialog);
  $("#detectCancelButton").addEventListener("click", () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; });
  $("#detectDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#detectDialog").close(); state.pendingDetectionTargetIds = []; });
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
    if (event.button === 1) {
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
    } else if (state.drawing && event.button === 0) {
      state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
      pushHistory(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates();
    }
    state.drawing = false; state.panning = false; canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair"; render();
  });
  canvas.addEventListener("pointercancel", () => {
    if (state.drawing && state.tool !== "boundary") {
      state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
      pushHistory(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates();
    }
    state.drawing = false; state.panning = false; state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false; render();
  });
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
  window.addEventListener("keydown", handleWindowKeydown);
  window.addEventListener("storage", handleReviewStorageEvent);
}

async function initialise() {
  await loadTranslations(); bindEvents();
  try { state.navigationShortcutsEnabled = localStorage.getItem("lets-censoring.navigation-shortcuts.v1") !== "false"; } catch { state.navigationShortcutsEnabled = true; }
  new ResizeObserver(resizeRenderCanvas).observe(stage); setInterval(pollJob, 700);
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons();
  try {
    const data = await api("/api/images");
    if (data.images.length) {
      $("#folderPath").value = data.root || "";
      resetCatalog(data.images, data.root);
      setStatus(t("status.imagesLoaded", { count: state.images.length }));
    }
  } catch (error) { setStatus(error.message, "error"); }
}

initialise();
