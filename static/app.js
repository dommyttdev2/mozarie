const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], currentId: null, currentImage: null, pendingImageId: null, galleryFilter: "all", maskStatus: new Map(),
  viewMode: "edit", overviewFilter: "all", overviewQuery: "", overviewFolder: "", reviewedPaths: new Set(), reviewRoot: "",
  navigationShortcutsEnabled: true,
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", panning: false, drawing: false, boundaryPending: false,
  boundaryRoi: null, boundaryStart: null, boundaryStartClient: null, boundaryPoint: null, boundaryPromptPoint: null, boundaryDragging: false,
  polygonPoints: [], polygonDragIndex: -1, blinkCandidateIds: new Set(),
  pointer: null, hover: null, history: [], historyIndex: 0, activeStroke: null,
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, saveStarting: false, detectionStarting: false, masksClearing: false,
  catalogMutation: false, imageGeneration: 0, catalogGeneration: 0, catalogEpoch: 0, viewGeneration: 0, historyRestoreToken: 0, translations: {},
  applyTargetIds: [], applyRunning: false, applyFinishing: false, handledApplyStartedAt: null, importing: false, mosaicPreviewEnabled: true,
  detectionTargetIds: [], pendingDetectionTargetIds: [], detectCancelRequested: false,
  pageLoadedAt: Date.now() / 1000, handledDetectionStartedAt: null, importSession: null,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(),
  manualMaskPresent: false, manualEnabled: true, manualExclusionEnabled: true,
  galleryNodes: new Map(), overviewNodes: new Map(), contextMenuImageId: null, contextMenuOrigin: null, browserSave: null, pollInFlight: null, pollFailures: 0,
  // Browser file handles never leave this tab. They make imported images real save targets.
  sourceAccess: new Map(),
  // This handle is scoped to this browser tab and reused for copy saves.
  outputDirectory: null, outputDirectoryName: "",
  galleryCollapsed: false, inspectorCollapsed: false,
  settings: null, settingsStatus: null,
  imageCache: new Map(), candidateBundleCache: new Map(),
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const exclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const mosaicCanvas = document.createElement("canvas");
const mosaicSourceCanvas = document.createElement("canvas");
const historyAddCanvas = document.createElement("canvas");
const historyExclusionCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const blinkCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const mosaicCtx = mosaicCanvas.getContext("2d");
const mosaicSourceCtx = mosaicSourceCanvas.getContext("2d");
const layerCtx = layerCanvas.getContext("2d");
const blinkCtx = blinkCanvas.getContext("2d");
let renderedWidth = 0;
let renderedHeight = 0;
let translationGeneration = 0;

function t(key, params = {}) {
  let value = state.translations[key] || key;
  for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, replacement);
  return value;
}

async function loadTranslations(languageOverride = null) {
  const generation = ++translationGeneration;
  try {
    const language = languageOverride === "en" || (!languageOverride && state.settings?.general?.language === "en") ? "en" : "ja";
    document.documentElement.lang = language;
    const translations = await fetch(`/i18n/${language}.json`).then((response) => response.ok ? response.json() : {});
    if (generation !== translationGeneration) return false;
    state.translations = translations;
  } catch {
    if (generation !== translationGeneration) return false;
    state.translations = {};
  }
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const value = state.translations[element.dataset.i18n]; if (value) element.textContent = value;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const value = state.translations[element.dataset.i18nTitle]; if (value) element.title = value;
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    const value = state.translations[element.dataset.i18nAriaLabel]; if (value) element.setAttribute("aria-label", value);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const value = state.translations[element.dataset.i18nPlaceholder]; if (value) element.placeholder = value;
  });
  const sectionHeadings = document.querySelectorAll(".candidate-section h3");
  if (sectionHeadings[0]) sectionHeadings[0].textContent = t("candidates.applyRanges");
  if (sectionHeadings[1]) sectionHeadings[1].textContent = t("candidates.excludeRanges");
  ensureDetectionModeControl();
  renderModelStatus();
  updateBoundaryActions();
  renderCatalogViews(); renderCandidates(); render();
  return true;
}

function api(path, options = {}) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Mozarie-Token": token, ...(options.headers || {}) },
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const localized = data.error_code ? t(`errorCode.${data.error_code}`, data.params || {}) : "";
        const message = data.error_code
          ? (localized && localized !== `errorCode.${data.error_code}` ? localized : t("error.requestFailed"))
          : (data.error || t("error.requestFailed"));
        const error = new Error(message);
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
function isBusy() {
  return ["running", "paused"].includes(state.job?.state)
    || state.saving || state.saveStarting || state.detectionStarting || state.masksClearing
    || state.catalogMutation || state.boundaryPending;
}
function beginCatalogEpoch() { state.catalogGeneration += 1; state.catalogEpoch += 1; return state.catalogEpoch; }
function isCurrentCatalogEpoch(epoch) { return state.catalogEpoch === epoch; }
function isGestureActive() { return state.drawing || state.panning || state.boundaryDragging; }
function imageHasMask(image) { return state.maskStatus.get(image.id) ?? Number(image.enabledCandidateCount || 0) > 0; }
function saveTargets() { return state.images.filter(imageHasMask).map((image) => image.id); }
function normaliseReviewRoot(value) { return String(value || "").trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function reviewStoragePrefix() { return state.reviewRoot ? `mozarie.reviewed.v1:${state.reviewRoot}:` : ""; }
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
  if (state.settings?.general) state.settings.general.shortcuts_enabled = state.navigationShortcutsEnabled;
  const topControl = $("#navigationShortcutsEnabled");
  const settingsControl = $("#settingsShortcuts");
  if (topControl) topControl.checked = state.navigationShortcutsEnabled;
  if (settingsControl) settingsControl.checked = state.navigationShortcutsEnabled;
  updateNavigationControls();
  focusCanvas();
}

async function persistNavigationShortcuts(enabled) {
  setNavigationShortcutsEnabled(enabled);
  if (!state.settings) return;
  try {
    const payload = structuredClone(state.settings);
    payload.general.shortcuts_enabled = Boolean(enabled);
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
  } catch (error) { setStatus(error.message, "error"); }
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
  const batchDetectButtons = [$("#detectAllButton")];
  for (const detectAllButton of batchDetectButtons) {
    detectAllButton.textContent = t(detecting ? (state.detectCancelRequested ? "detectDialog.stopping" : "detectDialog.stop") : "gallery.detectAll");
    detectAllButton.classList.toggle("detect-stop", detecting);
    detectAllButton.disabled = detecting ? state.detectCancelRequested : (running || state.images.length === 0);
  }
  $("#detectCurrentButton").disabled = running || !hasImage;
  $("#clearCurrentMasksButton").disabled = running || !hasImage || !(current.candidateCount || state.manualMaskPresent || imageHasMask(current));
  $("#removeCurrentImageButton").disabled = running || !hasImage;
  for (const id of ["#clearAllMasksButton", "#clearCatalogButton", "#batchMoreButton"]) $(id).disabled = running || state.images.length === 0;
  $("#galleryAllTab").disabled = running;
  $("#galleryMaskedTab").disabled = running;
  $("#saveAllButton").disabled = running || mutatingCandidates || saveTargets().length === 0;
  const currentSaveDisabled = running || mutatingCandidates || !hasImage || !imageHasMask(current);
  $("#saveButton").disabled = currentSaveDisabled;
  $("#applyStartButton").disabled = running || mutatingCandidates || Boolean(applyRestrictionMessage());
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
  state.boundaryPromptPoint = null;
  state.boundaryDragging = false;
  state.polygonPoints = [];
  state.polygonDragIndex = -1;
  updateBoundaryActions();
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
  releaseImageCaches();
  state.images = images;
  state.sourceAccess.clear();
  state.reviewRoot = normaliseReviewRoot(root);
  loadReviewedPaths();
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
  state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); clearBoundaryInteraction();
  state.candidateUpdateVersions.clear(); state.candidateDeleting.clear();
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
  renderCatalogViews(); clearEditor();
}

function discardCatalogNodes(nodes, container) {
  for (const item of nodes.values()) {
    const preview = item.querySelector?.("img");
    if (preview) preview.src = "";
    item.remove?.();
  }
  nodes.clear();
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
  const picker = $("#pickerMenu");
  if (picker?.matches?.(":popover-open")) picker.hidePopover();
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  setStatus(t("status.loadingImages"), "running");
  try {
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    resetCatalog(data.images, path);
    setStatus(t("status.imagesLoaded", { count: state.images.length }));
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
}


function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const gallery = $("#gallery");
  const scrollTop = gallery.scrollTop;
  const visibleImages = state.galleryFilter === "masked" ? state.images.filter(imageHasMask) : state.images;
  const imageCount = t("gallery.count", { count: visibleImages.length });
  for (const element of document.querySelectorAll(".gallery-local-count")) element.textContent = imageCount;
  $("#galleryAllTab").classList.toggle("active", state.galleryFilter === "all");
  $("#galleryAllTab").setAttribute("aria-pressed", String(state.galleryFilter === "all"));
  $("#galleryMaskedTab").classList.toggle("active", state.galleryFilter === "masked");
  $("#galleryMaskedTab").setAttribute("aria-pressed", String(state.galleryFilter === "masked"));
  $("#galleryEmptyState").hidden = state.images.length !== 0;
  $("#galleryFilteredEmptyState").hidden = !(state.images.length && !visibleImages.length);
  const template = $("#galleryItemTemplate");
  const visibleIds = new Set(visibleImages.map((image) => image.id));
  for (const [imageId, item] of state.galleryNodes) {
    if (!visibleIds.has(imageId)) { item.remove?.(); state.galleryNodes.delete(imageId); }
  }
  for (const image of visibleImages) {
    let item = state.galleryNodes.get(image.id);
    if (!item) {
      item = template.content.firstElementChild.cloneNode(true);
      state.galleryNodes.set(image.id, item);
    }
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    item.classList.toggle("reviewed", isReviewed(image));
    const preview = item.querySelector("img");
    const previewSource = `/api/thumbnail/${encodeURIComponent(image.id)}?v=${encodeURIComponent(`${image.mtimeNs || ""}-${image.contentVersion || 0}`)}`;
    if (!String(preview.src || "").endsWith(previewSource)) preview.src = previewSource;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    const reviewBadge = item.querySelector(".gallery-review-badge");
    reviewBadge.textContent = isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.onclick = () => selectImage(image.id);
    item.oncontextmenu = (event) => openCatalogContextMenu(event, image.id);
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `${image.relativePath}、${isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge")}`);
    item.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void selectImage(image.id); }
      else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openCatalogContextMenu(event, image.id);
    };
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
  $("#overviewCount").textContent = t("overview.count", { visible: visibleImages.length, total: state.images.length });
  document.querySelectorAll(".overview-filter").forEach((button) => {
    const active = button.dataset.overviewFilter === state.overviewFilter;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  const template = $("#overviewItemTemplate");
  const visibleIds = new Set(visibleImages.map((image) => image.id));
  $("#overviewEmptyState").hidden = visibleImages.length !== 0;
  for (const [imageId, item] of state.overviewNodes) {
    if (!visibleIds.has(imageId)) { item.remove?.(); state.overviewNodes.delete(imageId); }
  }
  for (const image of visibleImages) {
    let item = state.overviewNodes.get(image.id);
    if (!item) {
      item = template.content.firstElementChild.cloneNode(true);
      state.overviewNodes.set(image.id, item);
    }
    item.dataset.id = image.id;
    item.classList.toggle("selected", image.id === state.currentId);
    const preview = item.querySelector("img");
    const previewSource = `/api/thumbnail/${encodeURIComponent(image.id)}?v=${encodeURIComponent(`${image.mtimeNs || ""}-${image.contentVersion || 0}`)}`;
    if (!String(preview.src || "").endsWith(previewSource)) preview.src = previewSource;
    preview.alt = image.relativePath;
    item.querySelector(".overview-item-name").textContent = image.relativePath.split(/[\\/]/).pop();
    item.querySelector(".overview-item-path").textContent = image.relativePath;
    const statuses = [];
    statuses.push(isReviewed(image) ? t("overview.stateReviewed") : t("overview.stateUnreviewed"));
    if (imageHasMask(image)) statuses.push(t("overview.stateMasked"));
    const stateLabel = item.querySelector(".overview-item-state");
    stateLabel.textContent = statuses.join(" / ");
    stateLabel.classList.toggle("reviewed", isReviewed(image));
    stateLabel.classList.toggle("masked", imageHasMask(image));
    item.onclick = () => { setViewMode("edit"); void selectImage(image.id); };
    item.oncontextmenu = (event) => openCatalogContextMenu(event, image.id);
    grid.append(item);
  }
}
function renderCatalogViews() { renderGallery(); renderOverview(); }
function setViewMode(mode, refreshGallery = true) {
  const viewGeneration = ++state.viewGeneration;
  state.viewMode = mode;
  const active = mode === "overview";
  $(".studio-grid").classList.toggle("overview-active", active);
  $("#overviewPane").hidden = !active;
  if (!active) {
    discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
    if (refreshGallery) renderGallery(true);
    resizeRenderCanvas(); focusCanvas(); return;
  }
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  renderOverview(true);
  requestAnimationFrame(() => {
    if (state.viewMode !== "overview" || state.viewGeneration !== viewGeneration) return;
    const current = [...$("#overviewGrid").children].find((item) => item.dataset.id === state.currentId);
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
    focusElement($("#overviewPane"));
  });
}
function moveCurrentBy(offset) {
  if (isGestureActive()) return;
  const index = imageIndex();
  const target = state.images[index + offset];
  if (target) void selectImage(target.id);
}
function nextUnreviewedImage() {
  const current = imageIndex();
  for (let index = Math.max(0, current + 1); index < state.images.length; index += 1) if (!isReviewed(state.images[index])) return state.images[index];
  return null;
}
function moveToNextUnreviewed() { if (isGestureActive()) return; const target = nextUnreviewedImage(); if (target) void selectImage(target.id); }
function reviewAndMoveNext() {
  if (isGestureActive()) return null;
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
  const position = index < 0 ? "- / -" : `${index + 1} / ${state.images.length}`;
  $("#imagePosition").textContent = position;
  $("#navigationShortcutsEnabled").checked = state.navigationShortcutsEnabled;
  const status = $("#reviewStatus");
  const record = currentRecord();
  const reviewed = isReviewed(record);
  status.textContent = record ? t(reviewed ? "review.reviewed" : "review.unreviewed") : "-";
  status.classList.toggle("reviewed", Boolean(record) && reviewed);
}

function canvasSizeForImage(image) {
  for (const target of [addCanvas, exclusionCanvas, combinedCanvas, mosaicCanvas]) { target.width = image.width; target.height = image.height; }
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
  state.manualMaskPresent = false;
  state.manualEnabled = true;
}

function clearEditor() {
  state.history = []; state.historyIndex = 0; state.activeStroke = null; state.hover = null; clearBoundaryInteraction();
  state.manualMaskPresent = false; state.manualEnabled = true;
  addCanvas.width = exclusionCanvas.width = combinedCanvas.width = mosaicCanvas.width = historyAddCanvas.width = historyExclusionCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = combinedCanvas.height = mosaicCanvas.height = historyAddCanvas.height = historyExclusionCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#imageInfo").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons(); render();
}

async function selectImage(imageId, force = false, { saveCurrentDraft = true } = {}) {
  if ((isBusy() || state.importing || isGestureActive()) && !force) return;
  if (state.currentId === imageId && !force && state.pendingImageId !== imageId) return;
  if (saveCurrentDraft) saveDraft();
  const generation = ++state.imageGeneration;
  state.pendingImageId = imageId;
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  setStatus(t("status.loadingImages"), "running");
  try {
    const [image, candidateBundle] = await Promise.all([
      cachedImage(record),
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
    prefetchNeighbors(record);
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

function releaseImageResource(image) {
  if (image && image !== state.currentImage) image.src = "";
}

function releaseCandidateBundle(bundle) {
  for (const image of bundle?.candidateImages?.values?.() || []) releaseImageResource(image);
}

function lruRemember(cache, key, value, limit, release = null) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    release?.(evicted);
  }
  return value;
}

function imageCacheKey(record) { return `${record.id}:${record.contentVersion || record.mtimeNs || 0}`; }
function candidateCacheKey(imageId, revision) { return `${imageId}:${revision}`; }

async function cachedImage(record) {
  const key = imageCacheKey(record);
  const cached = state.imageCache.get(key);
  if (cached) return lruRemember(state.imageCache, key, cached, 6, releaseImageResource);
  const image = await loadImage(`/api/image/${encodeURIComponent(record.id)}?v=${encodeURIComponent(record.contentVersion || record.mtimeNs || 0)}`);
  return lruRemember(state.imageCache, key, image, 6, releaseImageResource);
}

function prefetchNeighbors(record) {
  const index = state.images.findIndex((item) => item.id === record.id);
  for (const neighbor of [state.images[index - 1], state.images[index + 1]]) {
    if (!neighbor || state.imageCache.has(imageCacheKey(neighbor))) continue;
    void cachedImage(neighbor).catch(() => {});
  }
}

function releaseImageCaches(imageId = null) {
  const matches = (key) => !imageId || key.startsWith(`${imageId}:`);
  for (const [key, image] of state.imageCache) {
    if (!matches(key)) continue;
    image.src = "";
    state.imageCache.delete(key);
  }
  for (const [key, bundle] of state.candidateBundleCache) {
    if (!matches(key)) continue;
    releaseCandidateBundle(bundle);
    state.candidateBundleCache.delete(key);
  }
}

function invalidateCandidateBundles(imageId) {
  for (const [key, bundle] of state.candidateBundleCache) {
    if (!key.startsWith(`${imageId}:`)) continue;
    if (bundle.candidateImages !== state.candidateImages) releaseCandidateBundle(bundle);
    state.candidateBundleCache.delete(key);
  }
}

async function loadCandidateMask(source) {
  const response = await fetch(source, {
    headers: { "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
  });
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
  const cacheKey = candidateCacheKey(imageId, candidateData.candidateRevision || 0);
  const cached = state.candidateBundleCache.get(cacheKey);
  if (cached) return lruRemember(state.candidateBundleCache, cacheKey, cached, 12, releaseCandidateBundle);
  try {
    const candidateImages = new Map();
    await Promise.all(candidateData.candidates.map(async (candidate) => {
      candidateImages.set(candidate.id, await loadCandidateMask(`/api/mask/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}?v=${encodeURIComponent(candidateData.candidateRevision || 0)}`));
    }));
    return lruRemember(state.candidateBundleCache, cacheKey, { candidates: candidateData.candidates, candidateImages, candidateRevision: Number(candidateData.candidateRevision || 0) }, 12, releaseCandidateBundle);
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
    record.enabledCandidateCount = bundle.candidates.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
    record.candidateRevision = bundle.candidateRevision;
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
  record.enabledCandidateCount = candidates.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
}

function syncCurrentCandidateRecord() { syncCandidateRecord(state.currentId, state.candidates); }

function syncStoredMaskStatus(imageId, candidates) {
  const draft = state.drafts.get(imageId);
  if (!Array.isArray(draft?.visibleCandidateIds)) return;
  const visibleCandidateIds = new Set(draft.visibleCandidateIds);
  const hasVisibleCandidate = candidates.some((candidate) => candidate.enabled && visibleCandidateIds.has(candidate.id));
  const hasManualMask = Boolean(draft.manualVisible && draft.manualEnabled !== false);
  state.maskStatus.set(imageId, hasVisibleCandidate || hasManualMask);
}

async function refreshCandidateRecord(imageId, syncMask = false) {
  const data = await api(`/api/candidates/${encodeURIComponent(imageId)}`);
  syncCandidateRecord(imageId, data.candidates);
  if (syncMask) syncStoredMaskStatus(imageId, data.candidates);
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
  const hasAdd = canvasHasPixels(addCtx, addCanvas);
  const hasExclusion = canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (!hasAdd && !hasExclusion) {
    state.drafts.delete(state.currentId);
    return;
  }
  const visibility = captureCurrentMaskVisibility();
  state.drafts.set(state.currentId, {
    add: hasAdd ? addCanvas.toDataURL("image/png") : "",
    exclusion: hasExclusion ? exclusionCanvas.toDataURL("image/png") : "",
    manualEnabled: state.manualEnabled, manualExclusionEnabled: state.manualExclusionEnabled, manualMaskPresent: state.manualMaskPresent,
    visibleCandidateIds: visibility.candidateIds, manualVisible: visibility.manual,
  });
}

function restoreDraft(imageId, generation) {
  const draft = state.drafts.get(imageId);
  state.history = []; state.historyIndex = 0; state.activeStroke = null;
  state.manualEnabled = draft?.manualEnabled !== false;
  state.manualExclusionEnabled = draft?.manualExclusionEnabled !== false;
  state.manualMaskPresent = false;
  if (!draft) { resetHistoryToCurrentManualMask(); updateCandidateStatus(); renderCandidates(); return; }
  const addImagePromise = draft.add ? loadImage(draft.add) : Promise.resolve(null);
  const exclusionImagePromise = draft.exclusion ? loadImage(draft.exclusion) : Promise.resolve(null);
  const restoreToken = ++state.historyRestoreToken;
  Promise.all([addImagePromise, exclusionImagePromise]).then(([addImage, exclusionImage]) => {
    if (state.currentId !== imageId || state.imageGeneration !== generation || state.historyRestoreToken !== restoreToken) return;
    if (addImage) addCtx.drawImage(addImage, 0, 0);
    if (exclusionImage) exclusionCtx.drawImage(exclusionImage, 0, 0);
    state.manualMaskPresent = draft.manualMaskPresent ?? canvasHasPixels(addCtx, addCanvas);
    resetHistoryToCurrentManualMask();
    refreshMaskStatus(true); updateCandidateStatus(); renderCandidates(); render();
  });
}

function fitImage() {
  if (!state.currentImage) return;
  const inset = { left: 76, right: 20, top: 58, bottom: 62 };
  const width = Math.max(1, stage.clientWidth - inset.left - inset.right);
  const height = Math.max(1, stage.clientHeight - inset.top - inset.bottom);
  state.view.scale = Math.min(width / state.currentImage.width, height / state.currentImage.height);
  state.view.x = inset.left + (width - state.currentImage.width * state.view.scale) / 2;
  state.view.y = inset.top + (height - state.currentImage.height * state.view.scale) / 2;
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
  for (const candidate of state.candidates) {
    if (candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) {
    if (candidate.enabled && candidate.role === "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
}

function sourceVisibleAfterExclusion(source) {
  combinedCtx.globalCompositeOperation = "source-over";
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  combinedCtx.drawImage(source, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  return canvasHasPixels(combinedCtx, combinedCanvas);
}

function captureCurrentMaskVisibility() {
  const candidateIds = state.candidates
    .filter((candidate) => candidate.role !== "exclude")
    .filter((candidate) => {
      const image = state.candidateImages.get(candidate.id);
      return image && sourceVisibleAfterExclusion(image);
    })
    .map((candidate) => candidate.id);
  const manual = state.manualMaskPresent && sourceVisibleAfterExclusion(addCanvas);
  composeCurrentMask();
  return { candidateIds, manual };
}

function maskStatusWithoutCandidate(candidateId) {
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (candidate.id !== candidateId && candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) {
    if (candidate.id !== candidateId && candidate.enabled && candidate.role === "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
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
  if (state.boundaryPromptPoint && !state.boundaryDragging) {
    const pointX = state.view.x + state.boundaryPromptPoint.x * state.view.scale;
    const pointY = state.view.y + state.boundaryPromptPoint.y * state.view.scale;
    ctx.save(); ctx.fillStyle = "#50d589"; ctx.beginPath(); ctx.arc(pointX, pointY, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - point.y * next.x;
  }, 0) / 2);
}

function polygonSegmentsIntersect(a, b, c, d) {
  const orient = (first, second, third) => (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const abC = orient(a, b, c); const abD = orient(a, b, d); const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function polygonIsValid() {
  const points = state.polygonPoints;
  return points.length === 4
    && polygonArea(points) >= 16
    && !polygonSegmentsIntersect(points[0], points[1], points[2], points[3])
    && !polygonSegmentsIntersect(points[1], points[2], points[3], points[0]);
}

function boundaryActionAnchor() {
  const rectangle = state.boundaryRoi;
  const points = state.polygonPoints;
  if (rectangle) return {
    left: state.view.x + rectangle.left * state.view.scale,
    right: state.view.x + rectangle.right * state.view.scale,
    top: state.view.y + rectangle.top * state.view.scale,
    bottom: state.view.y + rectangle.bottom * state.view.scale,
  };
  if (!points.length) return null;
  const projected = points.map((point) => ({ x: state.view.x + point.x * state.view.scale, y: state.view.y + point.y * state.view.scale }));
  return {
    left: Math.min(...projected.map((point) => point.x)), right: Math.max(...projected.map((point) => point.x)),
    top: Math.min(...projected.map((point) => point.y)), bottom: Math.max(...projected.map((point) => point.y)),
  };
}

function updateBoundaryActions() {
  const actions = $("#boundaryActions");
  if (!actions) return;
  const isRectangleDraft = state.tool === "boundary" && Boolean(state.boundaryRoi);
  const isPolygonDraft = state.tool === "polygon" && state.polygonPoints.length > 0;
  const active = !state.boundaryPending && (isRectangleDraft || isPolygonDraft);
  actions.hidden = !active;
  $("#boundaryDetectButton").disabled = !active || (isPolygonDraft && !polygonIsValid()) || isBusy() || state.importing;
  if (!active) return;
  const anchor = boundaryActionAnchor();
  if (!anchor) return;
  const width = actions.offsetWidth || 142;
  const height = actions.offsetHeight || 38;
  const horizontal = Math.max(8, Math.min(stage.clientWidth - width - 8, anchor.left + (anchor.right - anchor.left - width) / 2));
  const below = anchor.bottom + 8;
  const vertical = below + height <= stage.clientHeight - 8 ? below : Math.max(8, anchor.top - height - 8);
  actions.style.left = `${Math.round(horizontal)}px`;
  actions.style.top = `${Math.round(vertical)}px`;
}

function drawPolygonBoundary() {
  const points = state.polygonPoints;
  if (!points.length) return;
  ctx.save();
  ctx.strokeStyle = polygonIsValid() ? "#50d589" : "#f0ba62"; ctx.fillStyle = "rgba(80, 213, 137, 0.16)"; ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
    if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  if (points.length === 4) { ctx.closePath(); ctx.fill(); }
  ctx.stroke();
  for (const point of points) {
    const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = "#effff4"; ctx.fill(); ctx.stroke();
  }
  ctx.restore(); updateBoundaryActions();
}

function drawCandidateBlinkOverlay() {
  if (!state.blinkCandidateIds.size || !state.currentImage || performance.now() % 400 > 200) return;
  blinkCanvas.width = state.currentImage.width; blinkCanvas.height = state.currentImage.height;
  blinkCtx.clearRect(0, 0, blinkCanvas.width, blinkCanvas.height);
  const settings = state.settings?.display || { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78 };
  const paintMask = (image, color) => {
    if (!image) return;
    blinkCtx.save();
    blinkCtx.drawImage(image, 0, 0);
    blinkCtx.globalCompositeOperation = "source-in";
    blinkCtx.fillStyle = color;
    blinkCtx.fillRect(0, 0, blinkCanvas.width, blinkCanvas.height);
    blinkCtx.restore();
  };
  if (state.blinkCandidateIds.has("manual:apply")) paintMask(addCanvas, settings.apply_color);
  if (state.blinkCandidateIds.has("manual:exclude")) paintMask(exclusionCanvas, settings.exclude_color);
  for (const candidate of state.candidates) {
    if (!state.blinkCandidateIds.has(candidate.id)) continue;
    const image = state.candidateImages.get(candidate.id);
    if (!image) continue;
    paintMask(image, candidate.role === "exclude" ? settings.exclude_color : settings.apply_color);
  }
  ctx.save(); ctx.globalAlpha = settings.overlay_opacity; ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale);
  ctx.drawImage(blinkCanvas, 0, 0); ctx.restore();
}

function render() {
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(ctx); ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) return;
  ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale); ctx.drawImage(state.currentImage, 0, 0); ctx.restore();
  if (state.mosaicPreviewEnabled) paintMosaicPreview();
  drawCandidateBlinkOverlay();
  drawBoundaryRoi();
  drawPolygonBoundary();
  drawBrushCursor();
  updateBoundaryActions();
}

function renderCandidates() {
  const applyList = $("#candidateList");
  const excludeList = $("#exclusionList");
  applyList.textContent = ""; excludeList.textContent = "";
  if (!state.currentId) return;
  const hasManualExclude = canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (!state.candidates.length && !state.manualMaskPresent && !hasManualExclude) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); applyList.append(empty); return;
  }
  const appendEmpty = (list) => {
    if (list.children.length) return;
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty);
  };
  const appendManual = (list, role) => {
    const isApply = role === "apply";
    const exists = isApply ? state.manualMaskPresent : hasManualExclude;
    if (!exists) return;
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-manual ${isApply ? "candidate-row-manual-apply" : "candidate-row-manual-exclude"}`;
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = isApply ? state.manualEnabled : state.manualExclusionEnabled;
    enabled.setAttribute("aria-label", isApply ? t("candidates.manualToggle") : t("candidates.manualExcludeToggle"));
    enabled.addEventListener("change", () => {
      if (isBusy() || state.importing) { enabled.checked = isApply ? state.manualEnabled : state.manualExclusionEnabled; return; }
      if (isApply) state.manualEnabled = enabled.checked; else state.manualExclusionEnabled = enabled.checked;
      setReviewed(currentRecord(), false);
      resetHistoryToCurrentManualMask(); refreshCurrentReviewAndMask(); renderCandidates(); render();
    });
    const blinkId = `manual:${role}`;
    const blink = document.createElement("button"); blink.type = "button"; blink.className = `candidate-blink ${role}`;
    blink.textContent = "◉"; blink.title = t("candidates.blink"); blink.setAttribute("aria-label", blink.title);
    blink.classList.toggle("active", state.blinkCandidateIds.has(blinkId));
    blink.addEventListener("click", () => {
      if (state.blinkCandidateIds.has(blinkId)) state.blinkCandidateIds.delete(blinkId);
      else state.blinkCandidateIds.add(blinkId);
      renderCandidates(); render();
    });
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = isApply ? t("candidates.manual") : t("candidates.manualExclude");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×";
    remove.title = isApply ? t("candidates.deleteManual") : t("candidates.deleteManualExclude");
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", isApply ? deleteManualMask : deleteManualExclusion);
    row.append(enabled, blink, label, remove); list.append(row);
  };
  appendManual(applyList, "apply");
  appendManual(excludeList, "exclude");
  for (const candidate of state.candidates) {
    const key = candidateMutationKey(state.currentId, candidate.id);
    const deleting = state.candidateDeleting.has(key);
    const role = candidate.role === "exclude" ? "exclude" : "apply";
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-${role}`;
    if (state.blinkCandidateIds.has(candidate.id)) row.classList.add(`blink-${role}`);
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = candidate.enabled; enabled.disabled = deleting;
    enabled.setAttribute("aria-label", t("candidates.toggle", { label: candidate.className }));
    enabled.addEventListener("change", async () => {
      if (isBusy() || state.importing) { enabled.checked = candidate.enabled; return; }
      const previousEnabled = candidate.enabled;
      const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
      candidate.enabled = enabled.checked;
      setReviewed(currentRecord(), false);
      syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); render(); await updateCandidate(candidate, previousEnabled, previousMaskStatus);
    });
    const blink = document.createElement("button"); blink.type = "button"; blink.className = `candidate-blink ${role}`;
    blink.textContent = "◉"; blink.title = t("candidates.blink"); blink.setAttribute("aria-label", blink.title);
    blink.classList.toggle("active", state.blinkCandidateIds.has(candidate.id));
    blink.addEventListener("click", () => {
      if (state.blinkCandidateIds.has(candidate.id)) state.blinkCandidateIds.delete(candidate.id);
      else state.blinkCandidateIds.add(candidate.id);
      renderCandidates(); render();
    });
    const label = document.createElement("span"); label.className = "candidate-label";
    const name = document.createElement("span"); name.className = "candidate-class"; name.textContent = candidate.className;
    const confidence = document.createElement("span"); confidence.className = "candidate-conf";
    confidence.textContent = Number.isFinite(candidate.confidence) ? `${Math.round(candidate.confidence * 100)}%` : "";
    label.append(name, confidence);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = deleting;
    const deleteLabel = t("candidates.delete", { label: candidate.className });
    remove.title = deleteLabel; remove.setAttribute("aria-label", deleteLabel);
    remove.addEventListener("click", () => deleteCandidate(candidate));
    row.append(enabled, blink, label, remove); (role === "apply" ? applyList : excludeList).append(row);
  }
  appendEmpty(applyList); appendEmpty(excludeList);
}

function candidateMutationKey(imageId, candidateId) { return `${imageId}:${candidateId}`; }
function nextCandidateMutationVersion(key) {
  const version = (state.candidateUpdateVersions.get(key) || 0) + 1;
  state.candidateUpdateVersions.set(key, version);
  return version;
}
function enqueueCandidateMutation(imageId, send) {
  const previous = state.candidateUpdateChains.get(imageId) || Promise.resolve();
  const queued = previous.then(send, send);
  const tracked = queued.finally(() => {
    if (state.candidateUpdateChains.get(imageId) === tracked) state.candidateUpdateChains.delete(imageId);
    updateActionButtons();
  });
  state.candidateUpdateChains.set(imageId, tracked);
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
  const mutationKey = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(mutationKey);
  const desired = candidate.enabled;
  const send = async () => {
    try {
      await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color }),
      });
      invalidateCandidateBundles(imageId);
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        const currentCandidate = state.candidates.find((item) => item.id === candidate.id);
        if (currentCandidate) currentCandidate.enabled = desired;
        syncCurrentCandidateRecord(); refreshMaskStatus(true); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId, true); } catch { /* Keep the optimistic aggregate until a later refresh. */ }
        renderCatalogViews();
      }
    } catch (error) {
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
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
        await refreshCandidateRecord(imageId, true);
      } catch { /* The local rollback already removed the optimistic aggregate. */ }
      renderCatalogViews();
    }
  };
  return enqueueCandidateMutation(imageId, send);
}

async function deleteCandidate(candidate) {
  if (!state.currentId || isBusy() || state.importing) return;
  const imageId = state.currentId;
  setReviewed(currentRecord(), false);
  const generation = state.imageGeneration;
  const mutationKey = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(mutationKey);
  const remainingCandidates = state.candidates.filter((item) => item.id !== candidate.id);
  const remainingMaskStatus = maskStatusWithoutCandidate(candidate.id);
  state.candidateDeleting.add(mutationKey); renderCandidates();
  const send = async () => {
    try {
      await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
      invalidateCandidateBundles(imageId);
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      syncCandidateRecord(imageId, remainingCandidates);
      state.maskStatus.set(imageId, remainingMaskStatus);
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        state.candidates = remainingCandidates;
        state.candidateImages.delete(candidate.id);
        updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId, true); } catch { /* The known deletion is already reflected locally. */ }
      }
      renderCatalogViews();
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation) && state.candidateUpdateVersions.get(mutationKey) === version) {
        try { await reconcileCurrentCandidates(imageId, generation); } catch { /* Keep the existing coherent row. */ }
        setStatus(error.message, "error");
      }
    } finally {
      if (state.candidateUpdateVersions.get(mutationKey) === version) {
        state.candidateDeleting.delete(mutationKey);
        if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
      }
    }
  };
  return enqueueCandidateMutation(imageId, send);
}

function deleteManualMask() {
  if (!state.manualMaskPresent || isBusy() || state.importing) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true;
  state.blinkCandidateIds.delete("manual:apply");
  setReviewed(currentRecord(), false);
  resetHistoryToCurrentManualMask(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusion() {
  if (!canvasHasPixels(exclusionCtx, exclusionCanvas) || isBusy() || state.importing) return;
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  state.manualExclusionEnabled = true;
  state.blinkCandidateIds.delete("manual:exclude");
  setReviewed(currentRecord(), false);
  resetHistoryToCurrentManualMask(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

async function addBoundaryCandidate(point = null, polygonPoints = null) {
  if (!state.currentId || (!polygonPoints && !state.boundaryRoi) || isBusy()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const roi = state.boundaryRoi ? { ...state.boundaryRoi } : null;
  const targetPoint = point ? { ...point } : (roi ? { x: Math.round((roi.left + roi.right) / 2), y: Math.round((roi.top + roi.bottom) / 2) } : null);
  let catalogChanged = false;
  state.boundaryPending = true; updateBoundaryActions(); updateActionButtons(); setStatus(t("status.boundaryDetecting"), "running");
  try {
    const data = await api("/api/boundary", {
      method: "POST",
      body: JSON.stringify(polygonPoints ? { imageId, points: polygonPoints } : { imageId, roi, point: targetPoint }),
    });
    const created = Array.isArray(data.candidates) ? data.candidates : [];
    if (!created.length || !Number.isInteger(data.candidateRevision)) throw new Error(t("error.boundaryResponse"));
    const record = state.images.find((item) => item.id === imageId);
    if (record) {
      record.candidateCount = (record.candidateCount || 0) + created.length;
      record.enabledCandidateCount = (record.enabledCandidateCount || 0) + created.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
      record.candidateRevision = data.candidateRevision;
      state.maskStatus.set(imageId, true);
    }
    invalidateCandidateBundles(imageId);
    catalogChanged = true;
    markImagesUnreviewed([imageId], false);
    if (state.currentId !== imageId || state.imageGeneration !== viewGeneration) return;

    await reconcileCurrentCandidates(imageId, viewGeneration);
    clearBoundaryInteraction();
    setStatus(t("status.boundaryDone"));
  } catch (error) { if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error"); }
  finally {
    state.boundaryPending = false;
    if (catalogChanged) renderCatalogViews();
    updateBoundaryActions(); updateActionButtons();
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
function polygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  return state.polygonPoints.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
}
function cancelBoundary() {
  clearBoundaryInteraction(); render();
}
function copyCanvas(source, target) {
  target.width = source.width; target.height = source.height;
  target.getContext("2d").drawImage(source, 0, 0);
}

function updateHistoryButtons() {
  $("#undoButton").disabled = state.historyIndex <= 0;
  $("#redoButton").disabled = state.historyIndex >= state.history.length;
}

function resetHistoryToCurrentManualMask() {
  if (!state.currentImage) return;
  copyCanvas(addCanvas, historyAddCanvas); copyCanvas(exclusionCanvas, historyExclusionCanvas);
  state.history = []; state.historyIndex = 0; state.activeStroke = null; updateHistoryButtons();
}

function paintStrokeOnContexts(addContext, exclusionContext, from, to, erase, size) {
  const target = erase ? exclusionContext : addContext; const opposite = erase ? addContext : exclusionContext;
  opposite.save(); opposite.globalCompositeOperation = "destination-out"; opposite.lineWidth = size; opposite.lineCap = "round"; opposite.beginPath(); opposite.moveTo(from.x, from.y); opposite.lineTo(to.x, to.y); opposite.stroke(); opposite.restore();
  target.save(); target.globalCompositeOperation = "source-over"; target.strokeStyle = "#ffffff"; target.lineWidth = size; target.lineCap = "round"; target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke(); target.restore();
}

function paintStroke(from, to, erase, size) {
  paintStrokeOnContexts(addCtx, exclusionCtx, from, to, erase, size);
  composeCurrentMask();
}

function drawStroke(from, to, erase, size = Number($("#brushSize").value)) {
  paintStroke(from, to, erase, size);
}

function beginManualStroke(point) {
  state.activeStroke = { tool: state.tool, size: Number($("#brushSize").value), points: [{ ...point }] };
  drawStroke(point, point, state.tool === "eraser", state.activeStroke.size);
}

function appendManualStrokePoint(point) {
  if (!state.activeStroke) return;
  const previous = state.activeStroke.points.at(-1);
  state.activeStroke.points.push({ ...point });
  drawStroke(previous, point, state.activeStroke.tool === "eraser", state.activeStroke.size);
}

function replayManualStroke(stroke, addContext = addCtx, exclusionContext = exclusionCtx) {
  const erase = stroke.tool === "eraser";
  const points = stroke.points;
  if (!points.length) return;
  paintStrokeOnContexts(addContext, exclusionContext, points[0], points[0], erase, stroke.size);
  for (let index = 1; index < points.length; index += 1) {
    paintStrokeOnContexts(addContext, exclusionContext, points[index - 1], points[index], erase, stroke.size);
  }
}

function rebuildManualMaskFromHistory() {
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  addCtx.drawImage(historyAddCanvas, 0, 0); exclusionCtx.drawImage(historyExclusionCanvas, 0, 0);
  for (const stroke of state.history.slice(0, state.historyIndex)) replayManualStroke(stroke);
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  composeCurrentMask();
}

function completeManualStroke() {
  const stroke = state.activeStroke;
  state.activeStroke = null;
  if (!stroke?.points?.length) return;
  state.history.splice(state.historyIndex);
  state.history.push(stroke);
  if (state.history.length > 12) {
    const oldest = state.history.shift();
    replayManualStroke(oldest, historyAddCanvas.getContext("2d"), historyExclusionCanvas.getContext("2d"));
  }
  state.historyIndex = state.history.length;
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates();
}

function restoreSnapshot(index) {
  if (isBusy() || state.importing || index < 0 || index > state.history.length) return;
  state.historyIndex = index;
  rebuildManualMaskFromHistory();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  composeCurrentMask();
  return combinedCanvas.toDataURL("image/png");
}

function detectionParallelism() {
  const value = Number($("#detectParallelism").value);
  return Number.isFinite(value) ? Math.min(4, Math.max(1, Math.round(value))) : 2;
}

function openDetectionDialog(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.pendingDetectionTargetIds = [...imageIds];
  setDetectionConfidence(detectionConfidence());
  $("#detectParallelism").value = String(detectionParallelism());
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  $("#detectDialog").showModal();
}

async function runDetection(imageIds, confidence = detectionConfidence(), parallelism = 1, mode = selectedDetectionMode()) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.detectionStarting = true;
  updateActionButtons();
  try {
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence, parallelism: Math.min(4, Math.max(1, Math.round(parallelism))), mode }) });
    state.detectionTargetIds = [...imageIds];
    state.detectCancelRequested = false;
    state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "" };
    updateProgress(state.job); setStatus(t("status.detectStarted"), "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
  finally { state.detectionStarting = false; updateActionButtons(); }
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  const imageIds = state.pendingDetectionTargetIds;
  if (!imageIds.length) return;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  const parallelism = detectionParallelism();
  const mode = selectedDetectionMode();
  setDetectionConfidence(confidence);
  $("#detectDialog").close();
  state.pendingDetectionTargetIds = [];
  if (state.settings) {
    state.settings.detection = { threshold: confidence, parallelism, mode };
    try { await api("/api/settings", { method: "POST", body: JSON.stringify(state.settings) }); }
    catch (error) { setStatus(error.message, "error"); return; }
  }
  await runDetection(imageIds, confidence, parallelism, mode);
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
function sourceAccessFor(imageId) { return state.sourceAccess.get(imageId) || null; }
function sourceCanOverwrite(image) { return image?.sourceKind === "filesystem" || Boolean(sourceAccessFor(image?.id)?.fileHandle); }
function sourceCanDelete(image) {
  if (image?.sourceKind === "filesystem") return true;
  const access = sourceAccessFor(image?.id);
  return Boolean(access?.fileHandle && (typeof access.fileHandle.remove === "function" || access.parentHandle));
}
function applyTargetsSupport(capability) {
  return state.applyTargetIds.every((imageId) => {
    const image = state.images.find((entry) => entry.id === imageId);
    return capability === "overwrite" ? sourceCanOverwrite(image) : sourceCanDelete(image);
  });
}
function applyRestrictionMessage() {
  const noOverwrite = state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId)));
  const noDelete = state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId)));
  if (selectedSaveMode() === "overwrite" && noOverwrite.length) return t("apply.overwriteUnavailable", { count: noOverwrite.length });
  if (selectedSaveMode() === "copy" && $("#deleteOriginal").checked && noDelete.length) return t("apply.deleteUnavailable", { count: noDelete.length });
  return "";
}

function syncApplyMode() {
  const canOverwrite = applyTargetsSupport("overwrite");
  const canDelete = applyTargetsSupport("delete");
  const copying = selectedSaveMode() === "copy";
  $("#applySuffix").disabled = !copying || state.applyRunning;
  $("#chooseOutputDirectoryButton").disabled = !copying || state.applyRunning || state.saveStarting;
  $("#applyOutputDirectoryStatus").textContent = state.outputDirectoryName
    ? t("apply.outputDirectorySelected", { name: state.outputDirectoryName })
    : t("apply.outputDirectoryUnset");
  $("#deleteOriginal").disabled = !copying || !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#removeAfterSave").disabled = state.applyRunning;
  $("#applyOverwriteNote").hidden = copying;
  $("#applyOverwriteMode").disabled = !canOverwrite || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", !canOverwrite);
  const restriction = applyRestrictionMessage();
  const capabilityNote = !canOverwrite
    ? t("apply.overwriteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId))).length })
    : (!canDelete ? t("apply.deleteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId))).length }) : "");
  $("#applyTemporarySourceNote").textContent = restriction || capabilityNote || t("apply.handleSource");
  $("#applyTemporarySourceNote").hidden = !restriction && !capabilityNote;
  $("#applyStartButton").disabled = Boolean(restriction) || state.applyRunning;
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

async function pickOutputDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error(t("error.directoryPickerUnsupported"));
  }
  try {
    return await window.showDirectoryPicker({ id: "mozarie-output", mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(t("error.directoryPickerCancelled"));
    throw error;
  }
}

function rememberOutputDirectory(directory) {
  state.outputDirectory = directory;
  state.outputDirectoryName = String(directory?.name || "");
  syncApplyMode();
  return directory;
}

async function outputDirectoryForSave() {
  const directory = state.outputDirectory;
  if (directory) {
    try {
      const options = { mode: "readwrite" };
      const permission = await directory.queryPermission?.(options);
      if (!permission || permission === "granted") return directory;
      const requested = await directory.requestPermission?.(options);
      if (!requested || requested === "granted") return directory;
    } catch {
      // A stale handle is replaced by the normal picker below.
    }
    state.outputDirectory = null;
    state.outputDirectoryName = "";
  }
  return rememberOutputDirectory(await pickOutputDirectory());
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting) return;
  try {
    rememberOutputDirectory(await pickOutputDirectory());
    setApplyResult("");
  } catch (error) {
    setApplyResult(error.message, true);
  }
}

async function outputDirectoryFor(root, relativePath) {
  let directory = root;
  const parts = String(relativePath).replaceAll("\\", "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  return directory;
}

async function uniqueOutputFile(directory, sourceName, suffix) {
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const extension = dot > 0 ? sourceName.slice(dot) : "";
  for (let number = 1; number < 10000; number += 1) {
    const name = `${stem}${suffix}${number === 1 ? "" : `_${number}`}${extension}`;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
      const reservedAt = Date.now();
      const handle = await directory.getFileHandle(name, { create: true });
      const file = await handle.getFile();
      if (file.size !== 0 || file.lastModified + 2000 < reservedAt) continue;
      return { name, handle };
    }
  }
  throw new Error(t("error.outputNameExhausted"));
}

async function writeBrowserSaveOutput(destination, entry, suffix, bytes) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = await uniqueOutputFile(destination, entry.relativePath.split("/").pop(), suffix);
    let stream = null;
    let closed = false;
    try {
      stream = await output.handle.createWritable({ mode: "exclusive", keepExistingData: false });
      await stream.write(bytes);
      await stream.close();
      closed = true;
      return output;
    } catch (error) {
      try { await stream?.abort?.(); } catch { /* The source image remains unchanged. */ }
      if (!closed) {
        try { await destination.removeEntry(output.name); } catch { /* The reservation may already have changed ownership. */ }
      }
      if (error?.name === "InvalidStateError" || error?.name === "NoModificationAllowedError") continue;
      throw error;
    }
  }
  throw new Error(t("error.outputNameExhausted"));
}

async function waitForBrowserSave(save) {
  while (save.paused && !save.cancelled) await new Promise((resolve) => setTimeout(resolve, 100));
  return !save.cancelled;
}

function showBrowserSaveProgress(save, entry) {
  state.job = { kind: "apply", state: save.paused ? "paused" : "running", total: save.entries.length, completed: save.completed, current: entry?.relativePath || "" };
  $("#applyProgress").max = Math.max(1, save.entries.length);
  $("#applyProgress").value = save.completed;
  $("#applyCurrentName").textContent = entry?.relativePath || "";
  $("#applyProgressText").textContent = t("apply.progress", { completed: save.completed, total: save.entries.length });
  $("#applyPauseButton").textContent = t(save.paused ? "apply.resume" : "apply.pause");
}

function reconcileStoredMaskStatuses() {
  const remainingImageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.maskStatus.keys()) {
    if (!remainingImageIds.has(imageId)) state.maskStatus.delete(imageId);
  }
  for (const image of state.images) {
    const draft = state.drafts.get(image.id);
    if (!draft) {
      state.maskStatus.delete(image.id);
      continue;
    }
    const hasVisibleManualAdd = Boolean(draft.add)
      && draft.manualEnabled !== false
      && draft.manualVisible !== false;
    if (hasVisibleManualAdd) {
      state.maskStatus.set(image.id, true);
      continue;
    }
    if (!draft.exclusion) {
      state.maskStatus.delete(image.id);
      continue;
    }
    const excludesAllCandidates = Array.isArray(draft.visibleCandidateIds) && draft.visibleCandidateIds.length === 0;
    if (Number(image.enabledCandidateCount || 0) === 0 || excludesAllCandidates) {
      state.maskStatus.set(image.id, false);
    }
  }
}

function reconcileBrowserSaveState() {
  reconcileStoredMaskStatuses();
  if (state.currentId && !state.images.some((image) => image.id === state.currentId)) {
    state.currentId = null;
    state.currentImage = null;
    state.candidates = [];
    state.candidateImages.clear();
    clearEditor();
  } else if (state.currentId) {
    refreshMaskStatus();
    renderCandidates();
    render();
  }
  renderCatalogViews();
}

async function ensureHandlePermission(access, requireWrite = true) {
  const handle = access?.fileHandle;
  if (!handle) return;
  const options = requireWrite ? { mode: "readwrite" } : { mode: "read" };
  let permission = await handle.queryPermission?.(options);
  if (permission !== "granted") permission = await handle.requestPermission?.(options);
  if (permission && permission !== "granted") throw new Error(t("error.sourcePermissionDenied", { name: handle.name || access.name || "" }));
  const file = await handle.getFile();
  if (access.size != null && (file.size !== access.size || file.lastModified !== access.lastModified)) {
    throw new Error(t("error.sourceChanged", { name: file.name || handle.name }));
  }
}

async function ensureSaveSources(imageIds, mode, deleteOriginal) {
  for (const imageId of imageIds) {
    const image = state.images.find((entry) => entry.id === imageId);
    const access = sourceAccessFor(imageId);
    if (mode === "overwrite" && !sourceCanOverwrite(image)) throw new Error(t("apply.overwriteUnavailable", { count: 1 }));
    if (mode === "copy" && deleteOriginal && !sourceCanDelete(image)) throw new Error(t("apply.deleteUnavailable", { count: 1 }));
    if (access?.fileHandle) await ensureHandlePermission(access, mode === "overwrite" || deleteOriginal);
  }
}

async function writeSourceHandle(access, bytes) {
  const stream = await access.fileHandle.createWritable({ keepExistingData: false });
  try {
    await stream.write(bytes);
    await stream.close();
    const file = await access.fileHandle.getFile();
    access.name = file.name;
    access.size = file.size;
    access.lastModified = file.lastModified;
  }
  catch (error) { try { await stream.abort?.(); } catch { /* Preserve the original whenever possible. */ } throw error; }
}

async function removeSourceHandle(access) {
  if (typeof access.fileHandle.remove === "function") {
    await access.fileHandle.remove();
    return;
  }
  if (access.parentHandle) {
    await access.parentHandle.removeEntry(access.fileHandle.name || access.name);
    return;
  }
  throw new Error(t("error.sourceDeleteUnavailable", { name: access.fileHandle.name || access.name || "" }));
}

async function removeCompletedImagesFromCatalog(imageIds, initialOrder, recordsById) {
  if (!imageIds.length) return;
  const currentId = state.currentId;
  const currentIndex = initialOrder.indexOf(currentId);
  const data = await api("/api/catalog/remove", { method: "POST", body: JSON.stringify({ imageIds }) });
  state.images = data.images;
  const remainingIds = new Set(state.images.map((image) => image.id));
  const removedIds = new Set([
    ...(data.removedImageIds || []),
    ...imageIds.filter((imageId) => !remainingIds.has(imageId)),
  ]);
  if (!removedIds.size) return;

  for (const imageId of removedIds) {
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    state.candidateUpdateChains.delete(imageId);
    state.candidateUpdateVersions.delete(imageId);
    state.candidateDeleting.delete(imageId);
    const image = recordsById.get(imageId);
    if (image) clearReviewForRemovedImage(image);
  }

  if (currentId && removedIds.has(currentId)) {
    state.currentId = null;
    state.currentImage = null;
    state.pendingImageId = null;
    state.candidates = [];
    state.candidateImages.clear();
    clearEditor();
  }
  pruneSourceAccess();
  renderCatalogViews();

  if (currentId && removedIds.has(currentId)) {
    const survivors = new Set(state.images.map((image) => image.id));
    const nextId = [...initialOrder.slice(currentIndex + 1), ...initialOrder.slice(0, currentIndex).reverse()]
      .find((imageId) => survivors.has(imageId));
    if (nextId) await selectImage(nextId, true, { saveCurrentDraft: false });
    else updateNavigationControls();
  }
  updateActionButtons();
}

async function runBrowserSave(directory, imageIds, suffix, deleteOriginal, mode = "copy", removeAfterSave = false) {
  const result = await api("/api/save/prepare", {
    method: "POST",
    body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, deleteOriginal: false }),
  });
  const save = {
    directory, entries: result.entries, completed: 0, stale: 0, paused: false, cancelled: false, removeAfterSave,
    removableImageIds: new Set(), initialOrder: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])),
  };
  state.browserSave = save;
  state.saving = true;
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  updateActionButtons();
  try {
    await navigator.locks.request("mozarie-output", { mode: "exclusive" }, async () => {
      for (const entry of save.entries) {
        // Cancellation is observed only before an entry starts. Once an output or source has
        // changed, commit that entry so browser files and catalog state remain consistent.
        if (!await waitForBrowserSave(save)) break;
        showBrowserSaveProgress(save, entry);
        const draft = draftPayload([entry.imageId])[entry.imageId] || null;
        const response = await fetch("/api/save/render", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "",
          },
          body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t("error.requestFailed"));
        }
        const saveToken = response.headers?.get("X-Mozarie-Save-Token") || "";
        const bytes = await response.arrayBuffer();
        const sourceImage = state.images.find((image) => image.id === entry.imageId);
        const access = sourceAccessFor(entry.imageId);
        let sourceAction = "keep";
        if (mode === "copy") {
          const destination = await outputDirectoryFor(directory, entry.relativePath);
          await writeBrowserSaveOutput(destination, entry, suffix, bytes);
          if (deleteOriginal) {
            if (access?.fileHandle) await removeSourceHandle(access);
            sourceAction = "deleted";
          }
        } else if (access?.fileHandle) {
          await writeSourceHandle(access, bytes);
          sourceAction = "overwrite";
        } else if (sourceImage?.sourceKind === "filesystem") {
          sourceAction = "overwrite";
        } else {
          throw new Error(t("apply.overwriteUnavailable", { count: 1 }));
        }
        const committed = await commitBrowserSaveWithRetry({
          imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken,
        });
        if (committed.cleared) {
          state.drafts.delete(entry.imageId);
          if (state.currentId === entry.imageId) {
            state.candidates = [];
            state.candidateImages.clear();
            state.manualMaskPresent = false;
            state.manualEnabled = true;
            resetCurrentDraft();
          }
        }
        if (save.removeAfterSave && committed.cleared && !committed.stale) save.removableImageIds.add(entry.imageId);
        if (committed.stale) save.stale += 1;
        state.images = committed.images;
        if (sourceAction === "overwrite" && state.currentId === entry.imageId) save.reloadCurrent = true;
        pruneSourceAccess();
        save.completed += 1;
        showBrowserSaveProgress(save, entry);
      }
    });
    const cancelled = save.cancelled;
    setApplyResult(cancelled
      ? t("apply.cancelled", { completed: save.completed })
      : (save.stale ? t("apply.completeWithStale", { completed: save.completed, stale: save.stale }) : t("apply.complete", { completed: save.completed })));
  } finally {
    state.saving = false;
    state.applyRunning = false;
    state.browserSave = null;
    state.job = { kind: "idle", state: "idle" };
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    try {
      await removeCompletedImagesFromCatalog([...save.removableImageIds], save.initialOrder, save.recordsById);
    } catch (error) {
      setApplyResult(error.message, true);
    }
    reconcileBrowserSaveState();
    if (save.reloadCurrent && state.currentId && state.images.some((image) => image.id === state.currentId)) {
      await selectImage(state.currentId, true, { saveCurrentDraft: false });
    }
    updateActionButtons();
  }
}

async function commitBrowserSaveWithRetry(payload) {
  const delays = [0, 150, 300, 600, 1000, 1500, 2000, 2000, 2000, 2000, 2000, 2000];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await api("/api/save/commit", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      lastError = error;
      if (error?.status && ![408, 429].includes(error.status) && error.status < 500) throw error;
    }
  }
  throw lastError || new Error(t("error.requestFailed"));
}

async function startApplyFromDialog(event) {
  event.preventDefault();
  const imageIds = [...state.applyTargetIds];
  if (!imageIds.length || isBusy() || state.importing) return;
  const mode = selectedSaveMode();
  const copy = mode === "copy";
  const suffix = $("#applySuffix").value.trim();
  if (copy && !suffix) return setApplyResult(t("error.requestFailed"), true);
  // This lock is intentionally set before the first await. A second submit must never create
  // another browser save loop while permissions or the output-directory picker are pending.
  state.saveStarting = true;
  state.saving = true;
  state.applyRunning = true;
  updateActionButtons();
  try {
    // Permission requests must begin while this submit is still a user action.
    await ensureSaveSources(imageIds, mode, copy && $("#deleteOriginal").checked);
  } catch (error) {
    setApplyResult(error.message, true);
    return finishSaveStart();
  }
  let outputDirectory = null;
  if (copy) {
    try {
      // An existing tab-scoped handle is reused. The picker only opens on the
      // first copy save or after the user explicitly changes the destination.
      outputDirectory = await outputDirectoryForSave();
    } catch (error) {
      setApplyResult(error.message, true);
      return finishSaveStart();
    }
  }
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (state.importing) return finishSaveStart();
  try {
    state.saveStarting = false;
    await runBrowserSave(outputDirectory, imageIds, suffix, copy && $("#deleteOriginal").checked, mode, $("#removeAfterSave").checked);
  } catch (error) {
    setApplyResult(error.message, true);
    state.saving = false;
    state.applyRunning = false;
    state.browserSave = null;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    updateActionButtons();
  }
}

function finishSaveStart() {
  state.saveStarting = false;
  state.saving = false;
  state.applyRunning = false;
  updateActionButtons();
}

async function controlApply(action) {
  if (state.browserSave) {
    if (action === "cancel") state.browserSave.cancelled = true;
    if (action === "pause") state.browserSave.paused = true;
    if (action === "resume") state.browserSave.paused = false;
    showBrowserSaveProgress(state.browserSave, state.browserSave.entries[state.browserSave.completed]);
    return;
  }
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
    const previousOrder = state.images.map((image) => image.id);
    const previousImagesById = new Map(state.images.map((image) => [image.id, image]));
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : (job.state === "complete" ? requestedImageIds : []);
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const data = await api("/api/images");
    if (!isCurrentGeneration(generation)) return;
    state.images = data.images;
    pruneSourceAccess();
    const reloadedImagesById = new Map(state.images.map((image) => [image.id, image]));
    for (const imageId of completedImageIds) {
      const previousImage = previousImagesById.get(imageId);
      const reloadedImage = reloadedImagesById.get(imageId);
      if (previousImage && reloadedImage) moveReviewedPathAfterApply(previousImage, reloadedImage);
    }
    state.maskStatus.clear();
    for (const imageId of completedImageIds) state.drafts.delete(imageId);
    state.applyTargetIds = requestedImageIds;
    if (job.removeAfterSave && completedImageIds.length) {
      await removeCompletedImagesFromCatalog(completedImageIds, previousOrder, previousImagesById);
    }
    const removedAfterSave = Boolean(job.removeAfterSave && completedImageIds.length);
    if (removedAfterSave) {
      // removeCompletedImagesFromCatalog already selects the next surviving image.
    } else if (reloadCurrent) {
      state.candidates = [];
      state.candidateImages.clear();
    }
    const reloadedCurrent = reloadCurrent && state.images.some((image) => image.id === keepCurrent);
    if (removedAfterSave) {
      // The batch cleanup above has restored either a neighboring image or an empty editor.
    } else if (reloadedCurrent) {
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
  pruneSourceAccess();
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
  if (state.browserSave) return;
  if (state.pollInFlight) return state.pollInFlight;
  state.pollInFlight = (async () => {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; state.pollFailures = 0; updateProgress(job);
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
      await finishDetectionJob(job);
      setStatus(job.error || t("error.background"), "error");
  } else if (isTerminalDetection(job, previous)) {
    await finishDetectionJob(job);
      setStatus(job.state === "cancelled" ? t("status.detectCancelled", { completed: job.completed }) : t("status.detectDone"));
    }
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) setStatus(t("error.connectionLost"), "error");
  }
  })();
  try { return await state.pollInFlight; }
  finally { state.pollInFlight = null; }
}

function setTool(tool) {
  if (isBusy() || state.importing) return;
  if (tool !== "boundary") clearBoundaryInteraction();
  if (tool !== "polygon") { state.polygonPoints = []; state.polygonDragIndex = -1; }
  state.tool = tool;
  for (const [id, name] of [["#brushTool", "brush"], ["#eraserTool", "eraser"], ["#rectangleTool", "boundary"], ["#polygonTool", "polygon"]]) {
    const active = tool === name; $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("#boundaryTool").classList.toggle("active", ["boundary", "polygon"].includes(tool));
  $("#boundaryTool").setAttribute("aria-pressed", String(["boundary", "polygon"].includes(tool)));
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
  if (tool === "boundary" && state.boundaryRoi) setStatus(t("status.boundaryReady"));
  updateBoundaryActions(); render();
}
function updateBrushSize(value) {
  if (isBusy() || state.importing) return;
  const input = $("#brushSize"); input.value = Math.min(500, Math.max(1, Math.round(value)));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render();
}
function updateBlockSizeDisplay() {
  const currentBlockSize = calculatedBlockSize(currentRecord(), mosaicDivisor());
  const applyBlockSize = calculatedBlockSize(currentRecord(), normaliseDivisor($("#applyDivisor").value));
  $("#blockSizeValue").textContent = currentBlockSize ? t("editor.calculatedPixels", { value: currentBlockSize }) : "";
  $("#applyBlockSize").textContent = applyBlockSize ? t("editor.calculatedPixels", { value: applyBlockSize }) : "";
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
  resetHistoryToCurrentManualMask(); refreshMaskStatus(true); render();
}

async function clearMasks(imageIds, titleKey, messageKey) {
  if (!imageIds.length || isBusy() || state.importing) return;
  if (!await confirmAction(t(titleKey), t(messageKey))) return;
  state.masksClearing = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await api("/api/masks/clear", { method: "POST", body: JSON.stringify({ imageIds }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
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
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.masksClearing = false; updateActionButtons(); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"))) return;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await api("/api/catalog/clear", { method: "POST", body: JSON.stringify({}) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    releaseImageCaches();
    state.images = []; state.sourceAccess.clear(); state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
    state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); state.overviewFolder = ""; clearEditor(); renderCatalogViews();
    setStatus(t("status.chooseFolder"));
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

function closeCatalogContextMenu() {
  const menu = $("#catalogContextMenu");
  if (menu.matches?.(":popover-open")) menu.hidePopover();
  state.contextMenuImageId = null;
  const origin = state.contextMenuOrigin;
  state.contextMenuOrigin = null;
  focusElement(origin);
}

function positionCatalogContextMenu(menu, clientX, clientY) {
  const padding = 8;
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement?.clientHeight || window.innerHeight;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(padding, clientX), Math.max(padding, viewportWidth - width - padding))}px`;
  menu.style.top = `${Math.min(Math.max(padding, clientY), Math.max(padding, viewportHeight - height - padding))}px`;
}

function openCatalogContextMenu(event, imageId) {
  if (isBusy() || state.importing) return;
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  event.preventDefault();
  state.contextMenuImageId = imageId;
  state.contextMenuOrigin = event.currentTarget || document.activeElement;
  $("#toggleReviewMenuItem").textContent = t(isReviewed(image) ? "context.unreview" : "context.review");
  const menu = $("#catalogContextMenu");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.showPopover?.();
  positionCatalogContextMenu(menu, event.clientX, event.clientY);
  focusElement($("#toggleReviewMenuItem"));
  if (state.currentId !== imageId) void selectImage(imageId);
}

function clearReviewForRemovedImage(image) {
  const path = reviewPath(image);
  state.reviewedPaths.delete(path);
  const key = reviewStorageKey(image);
  if (key) try { localStorage.removeItem(key); } catch { /* Session state is already cleared. */ }
}

async function removeImageFromCatalog(imageId = state.contextMenuImageId) {
  if (!imageId || isBusy() || state.importing) return;
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  if (!await confirmAction(t("confirm.removeImage.title"), t("confirm.removeImage.message"))) return;

  closeCatalogContextMenu();
  const index = state.images.findIndex((item) => item.id === imageId);
  const nextImageId = state.images[index + 1]?.id || state.images[index - 1]?.id || null;
  const removingCurrent = state.currentId === imageId || state.pendingImageId === imageId;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    const data = await api(`/api/catalog/image/${encodeURIComponent(imageId)}`, { method: "DELETE" });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = data.images;
    releaseImageCaches(imageId);
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    clearReviewForRemovedImage(image);
    if (removingCurrent) {
      state.currentId = null; state.currentImage = null; state.pendingImageId = null;
      state.candidates = []; state.candidateImages.clear(); clearEditor();
    }
    renderCatalogViews();
    if (removingCurrent && nextImageId && state.images.some((item) => item.id === nextImageId)) {
      await selectImage(nextImageId, true, { saveCurrentDraft: false });
    } else {
      updateNavigationControls(); updateActionButtons();
      setStatus(state.images.length ? t("status.editReady") : t("status.chooseFolder"));
    }
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

function droppedFile(file, relativePath = file.name, fileHandle = null, parentHandle = null) {
  return { file, relativePath, fileHandle, parentHandle };
}

async function directFilesFromDrop(dataTransfer) {
  const handles = [...dataTransfer.items]
    .map((item) => item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null)
    .filter(Boolean);
  if (handles.length) {
    const files = [];
    async function collectHandle(handle, parent = "", parentHandle = null) {
      if (!handle) return;
      const relativePath = parent ? `${parent}/${handle.name}` : handle.name;
      if (handle.kind === "file") files.push(droppedFile(await handle.getFile(), relativePath, handle, parentHandle));
      else for await (const entry of handle.values()) await collectHandle(entry, relativePath, handle);
    }
    for (const handlePromise of handles) {
      const handle = await handlePromise;
      if (handle) await collectHandle(handle);
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

function newClientKey() {
  return globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pruneSourceAccess() {
  const imageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.sourceAccess.keys()) if (!imageIds.has(imageId)) state.sourceAccess.delete(imageId);
}

async function importFiles(files) {
  const session = arguments.length > 1 ? arguments[1] : beginImportSession();
  if (!session || state.importSession !== session) return;
  const supportedFiles = [...files]
    .map((entry) => entry.file ? entry : { file: entry, relativePath: entry.webkitRelativePath || entry.name, fileHandle: null, parentHandle: null })
    .filter(({ file }) => isSupportedImageFile(file));
  if (!supportedFiles.length) { finishImportSession(session); return; }
  try {
    setStatus(t("gallery.importProgress", { completed: 0, total: supportedFiles.length }), "running");
    let completed = 0;
    for (const entry of supportedFiles) {
      const clientKey = newClientKey();
      const data = await importSingleFile(entry, clientKey);
      if (!isCurrentCatalogEpoch(session.epoch) || state.importSession !== session) return;
      state.images = data.images;
      for (const imported of data.imported || []) {
        if (imported.clientKey !== clientKey || !entry.fileHandle || !imported.imageId) continue;
        state.sourceAccess.set(imported.imageId, {
          fileHandle: entry.fileHandle,
          parentHandle: entry.parentHandle || null,
          name: entry.file.name,
          size: entry.file.size,
          lastModified: entry.file.lastModified,
        });
      }
      completed += 1;
      setStatus(t("gallery.importProgress", { completed, total: supportedFiles.length }), "running");
    }
    pruneSourceAccess(); renderCatalogViews(); setStatus(t("gallery.imported", { count: supportedFiles.length }));
  } catch (error) {
    try {
      const latest = await api("/api/images");
      if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) { state.images = latest.images; renderCatalogViews(); }
    } catch { /* Keep the import failure visible. */ }
    if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) setStatus(error.message, "error");
  }
  finally { finishImportSession(session); }
}

async function importSingleFile(entry, clientKey) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  const response = await fetch("/api/import/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mozarie-Token": token,
      "X-Mozarie-Name": encodeURIComponent(entry.file.name),
      "X-Mozarie-Relative-Path": encodeURIComponent(entry.relativePath),
      "X-Mozarie-Client-Key": encodeURIComponent(clientKey),
    },
    body: entry.file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || t("error.requestFailed"));
    error.status = response.status;
    throw error;
  }
  return data;
}

function beginImportSession() {
  if (isBusy() || state.importing) return null;
  const session = { id: newClientKey(), epoch: beginCatalogEpoch() };
  state.importing = true; state.importSession = session;
  updateActionButtons();
  return session;
}

function finishImportSession(session) {
  if (state.importSession !== session) return;
  state.importSession = null; state.importing = false;
  updateActionButtons();
}

async function importFileHandles(handles, session = beginImportSession()) {
  if (!session) return;
  const files = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    files.push(droppedFile(file, file.name, handle));
  }
  await importFiles(files, session);
}

async function importDirectoryHandle(directoryHandle, session = beginImportSession()) {
  if (!session) return;
  const files = [];
  async function collect(handle, relativePath = "", parentHandle = null) {
    const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
    if (handle.kind === "file") files.push(droppedFile(await handle.getFile(), path, handle, parentHandle));
    else for await (const child of handle.values()) await collect(child, path, handle);
  }
  for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
  await importFiles(files, session);
}

async function pickImageFiles() {
  $("#pickerMenu").hidePopover();
  if (typeof window.showOpenFilePicker !== "function") return $("#importImagesInput").click();
  const session = beginImportSession(); if (!session) return;
  try { await importFileHandles(await window.showOpenFilePicker({ multiple: true, types: [{ description: "Images", accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] } }] }), session); }
  catch (error) { if (error?.name !== "AbortError") setStatus(error.message, "error"); finishImportSession(session); }
}

async function pickImageDirectory() {
  $("#pickerMenu").hidePopover();
  if (typeof window.showDirectoryPicker !== "function") return $("#importFolderInput").click();
  const session = beginImportSession(); if (!session) return;
  try { await importDirectoryHandle(await window.showDirectoryPicker({ mode: "readwrite", id: "mozarie-source" }), session); }
  catch (error) { if (error?.name !== "AbortError") setStatus(error.message, "error"); finishImportSession(session); }
}

async function importDroppedFiles(event) {
  event.preventDefault();
  event.stopPropagation();
  setGalleryDropOverlay(false);
  const session = beginImportSession();
  if (!session) return;
  try {
    await importFiles(await directFilesFromDrop(event.dataTransfer), session);
  } catch (error) { setStatus(error.message, "error"); }
  finally { finishImportSession(session); setGalleryDropOverlay(false); }
}

function setGalleryDropOverlay(visible) {
  $("#galleryDropOverlay").hidden = !visible;
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
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || isEditableTarget(document.activeElement) || hasOpenDialog()) return null;
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

function closeBatchMoreMenus() {
  for (const id of ["#batchMoreMenu"]) {
    const menu = $(id);
    if (menu.matches(":popover-open")) menu.hidePopover();
  }
}

function selectedDetectionMode() {
  return document.querySelector('input[name="detectMode"]:checked')?.value || state.settings?.detection?.mode || "standard";
}

function ensureDetectionModeControl() {
  const existing = document.querySelector('input[name="detectMode"]');
  if (existing) {
    const mode = $("#detectMode");
    if (mode) mode.setAttribute("aria-label", t("detectDialog.mode"));
    const standard = $("#detectModeStandard"); const highPrecision = $("#detectModeHighPrecision");
    if (standard) standard.textContent = t("detectDialog.standard");
    if (highPrecision) highPrecision.textContent = t("detectDialog.highPrecision");
    return;
  }
  const form = $("#detectForm");
  if (!form?.insertAdjacentHTML) return;
  form.insertAdjacentHTML("beforeend", `
    <fieldset class="mode-choice" id="detectMode" aria-label="${t("detectDialog.mode")}">
      <label class="choice-row"><input type="radio" name="detectMode" value="standard" checked><span id="detectModeStandard">${t("detectDialog.standard")}</span></label>
      <label class="choice-row"><input type="radio" name="detectMode" value="high_precision"><span id="detectModeHighPrecision">${t("detectDialog.highPrecision")}</span></label>
    </fieldset>`);
}

function renderModelStatus() {
  const modelStatus = Object.entries(state.settingsStatus?.models || {});
  $("#settingsModelStatus").textContent = modelStatus.length && modelStatus.every(([, model]) => model.valid)
    ? ""
    : modelStatus.map(([key, model]) => model.configured && model.detail ? `${key}: ${model.detail}` : "").filter(Boolean).join("\n") || t("settings.modelsRequired");
}

function setSettingsForm(settings, status = null) {
  state.settings = settings; state.settingsStatus = status;
  $("#settingsLanguage").value = settings.general.language;
  $("#settingsOpenBrowser").checked = settings.general.open_browser;
  $("#settingsPort").value = String(settings.general.port);
  setNavigationShortcutsEnabled(settings.general.shortcuts_enabled);
  $("#settingsTargetModel").value = settings.models.target_segmentation;
  $("#settingsHandModel").value = settings.models.hand_detection;
  $("#settingsSamModel").value = settings.models.sam_checkpoint;
  $("#settingsSamType").value = settings.models.sam_model_type;
  $("#settingsProvider").value = settings.models.provider;
  $("#settingsApplyColor").value = settings.display.apply_color;
  $("#settingsExcludeColor").value = settings.display.exclude_color;
  $("#settingsOpacity").value = settings.display.overlay_opacity;
  $("#settingsMosaicPreview").checked = settings.display.mosaic_preview;
  state.mosaicPreviewEnabled = settings.display.mosaic_preview;
  $("#mosaicPreviewButton").classList.toggle("active", state.mosaicPreviewEnabled);
  $("#mosaicPreviewButton").setAttribute("aria-pressed", String(state.mosaicPreviewEnabled));
  setDetectionConfidence(settings.detection.threshold);
  $("#detectParallelism").value = String(settings.detection.parallelism);
  const mode = settings.detection.mode;
  const radio = document.querySelector(`input[name="detectMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  renderModelStatus();
}

function settingsPayload() {
  return {
    general: { ...state.settings.general, language: $("#settingsLanguage").value, open_browser: $("#settingsOpenBrowser").checked, port: Number($("#settingsPort").value), shortcuts_enabled: $("#settingsShortcuts").checked },
    models: {
      target_segmentation: $("#settingsTargetModel").value.trim(), hand_detection: $("#settingsHandModel").value.trim(),
      sam_checkpoint: $("#settingsSamModel").value.trim(), sam_model_type: $("#settingsSamType").value, provider: $("#settingsProvider").value,
    },
    display: {
      apply_color: $("#settingsApplyColor").value, exclude_color: $("#settingsExcludeColor").value,
      overlay_opacity: Number($("#settingsOpacity").value), mosaic_preview: $("#settingsMosaicPreview").checked,
    },
    detection: { threshold: normaliseDetectionConfidence($("#detectConfidenceNumber").value), parallelism: detectionParallelism(), mode: selectedDetectionMode() },
  };
}

function selectSettingsTab(name) {
  document.querySelectorAll(".settings-tab").forEach((button) => {
    const active = button.dataset.settingsTab === name;
    button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
}

async function openSettings() {
  if (isBusy()) return;
  try {
    const data = await api("/api/settings");
    setSettingsForm(data.settings, data.status);
    selectSettingsTab("general"); $("#settingsResult").textContent = ""; $("#settingsDialog").showModal();
  } catch (error) { setStatus(error.message, "error"); }
}

async function saveSettings(event) {
  event.preventDefault();
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(settingsPayload()) });
    const languageChanged = state.settings?.general?.language !== data.settings.general.language;
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    if (languageChanged) await loadTranslations();
    result.textContent = t("settings.saved");
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

async function resetSettings() {
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings/reset", { method: "POST", body: JSON.stringify({}) });
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    await loadTranslations();
    result.textContent = t("settings.resetDone");
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

function bindEvents() {
  $("#settingsButton").addEventListener("click", () => { void openSettings(); });
  $("#settingsCloseButton").addEventListener("click", () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#settingsDialog").close(); });
  $("#settingsDialog").addEventListener("close", () => {
    const language = state.settings?.general?.language || "ja";
    $("#settingsLanguage").value = language;
    void loadTranslations(language);
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#settingsResetButton").addEventListener("click", () => { void resetSettings(); });
  document.querySelectorAll(".settings-tab").forEach((button) => button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab)));
  $("#pickImages").addEventListener("click", () => { void pickImageFiles(); });
  $("#pickFolderFiles").addEventListener("click", () => { void pickImageDirectory(); });
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
  $("#loadFolderButton").addEventListener("click", loadFolder);
  const detectAll = () => {
    if (activeDetection()) void cancelDetection();
    else openDetectionDialog(state.images.map((image) => image.id));
  };
  $("#detectAllButton").addEventListener("click", detectAll);
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId], detectionConfidence(), 1));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#removeCurrentImageButton").addEventListener("click", () => { void removeImageFromCatalog(state.currentId); });
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"); });
  $("#clearCatalogButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearCatalog(); });
  for (const [menuId, buttonId] of [["#batchMoreMenu", "#batchMoreButton"]]) {
    $(menuId).addEventListener("toggle", () => $(buttonId).setAttribute("aria-expanded", String($(menuId).matches(":popover-open"))));
  }
  $("#galleryAllTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "all"; renderGallery(); });
  $("#galleryMaskedTab").addEventListener("click", () => { if (isBusy() || state.importing) return; state.galleryFilter = "masked"; renderGallery(); });
  $("#overviewButton").addEventListener("click", () => { if (!isBusy() && !state.importing) setViewMode("overview"); });
  $("#closeOverviewButton").addEventListener("click", () => setViewMode("edit"));
  $("#previousImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(-1)));
  $("#nextImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(1)));
  $("#nextUnreviewedButton").addEventListener("click", () => runNavigationAction(moveToNextUnreviewed));
  $("#reviewAndNextButton").addEventListener("click", () => runNavigationAction(reviewAndMoveNext));
  $("#navigationShortcutsEnabled").addEventListener("change", (event) => { void persistNavigationShortcuts(event.target.checked); });
  $("#settingsShortcuts").addEventListener("change", () => {});
  $("#settingsLanguage").addEventListener("change", (event) => { void loadTranslations(event.target.value); });
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
  $("#brushTool").addEventListener("click", () => setTool("brush")); $("#eraserTool").addEventListener("click", () => setTool("eraser"));
  $("#boundaryTool").addEventListener("click", () => {
    const menu = $("#boundaryModeMenu");
    const expanded = menu.hidden;
    menu.hidden = !expanded;
    $("#boundaryTool").setAttribute("aria-expanded", String(expanded));
  });
  $("#rectangleTool").addEventListener("click", () => { $("#boundaryModeMenu").hidden = true; $("#boundaryTool").setAttribute("aria-expanded", "false"); setTool("boundary"); });
  $("#polygonTool").addEventListener("click", () => { $("#boundaryModeMenu").hidden = true; $("#boundaryTool").setAttribute("aria-expanded", "false"); setTool("polygon"); });
  $("#boundaryDetectButton").addEventListener("click", () => {
    if (state.tool === "polygon") {
      if (polygonIsValid()) void addBoundaryCandidate(null, state.polygonPoints.map((point) => ({ ...point })));
    } else if (state.boundaryRoi) void addBoundaryCandidate(state.boundaryPromptPoint);
  });
  $("#boundaryCancelButton").addEventListener("click", cancelBoundary);
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
  const grid = $(".studio-grid");
  const setPaneCollapsed = (side, collapsed) => {
    const isGallery = side === "gallery";
    const content = $(isGallery ? "#galleryPaneContent" : "#candidatePaneContent");
    const button = $(isGallery ? "#collapseGalleryButton" : "#collapseInspectorButton");
    const className = isGallery ? "gallery-collapsed" : "inspector-collapsed";
    state[isGallery ? "galleryCollapsed" : "inspectorCollapsed"] = collapsed;
    grid.classList.toggle(className, collapsed);
    content.inert = collapsed;
    content.setAttribute("aria-hidden", String(collapsed));
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = isGallery ? (collapsed ? "›" : "‹") : (collapsed ? "‹" : "›");
    const labelKey = isGallery
      ? (collapsed ? "workspace.expandGallery" : "workspace.collapseGallery")
      : (collapsed ? "workspace.expandInspector" : "workspace.collapseInspector");
    button.setAttribute("aria-label", t(labelKey));
    button.title = t(labelKey);
    requestAnimationFrame(() => { resizeRenderCanvas(); fitImage(); });
  };
  $("#collapseGalleryButton").addEventListener("click", () => setPaneCollapsed("gallery", !state.galleryCollapsed));
  $("#collapseInspectorButton").addEventListener("click", () => setPaneCollapsed("inspector", !state.inspectorCollapsed));
  setPaneCollapsed("gallery", false);
  setPaneCollapsed("inspector", false);
  $("#applyForm").addEventListener("submit", startApplyFromDialog);
  $("#chooseOutputDirectoryButton").addEventListener("click", chooseOutputDirectory);
  document.querySelectorAll('input[name="saveMode"]').forEach((input) => input.addEventListener("change", syncApplyMode));
  $("#applyCloseButton").addEventListener("click", () => $("#applyDialog").close());
  $("#applyPauseButton").addEventListener("click", () => {
    const paused = state.browserSave ? state.browserSave.paused : state.job?.state === "paused";
    controlApply(paused ? "resume" : "pause");
  });
  $("#applyCancelButton").addEventListener("click", () => controlApply("cancel"));
  $("#applyDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!state.applyRunning) $("#applyDialog").close(); });
  $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#confirmDialog").close("cancel"); });
  $("#toggleReviewMenuItem").addEventListener("click", () => {
    const image = state.images.find((item) => item.id === state.contextMenuImageId);
    if (image) setReviewed(image, !isReviewed(image));
    closeCatalogContextMenu();
  });
  $("#removeImageMenuItem").addEventListener("click", () => { void removeImageFromCatalog(); });
  $("#gallery").addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragleave", (event) => {
    if (!$("#gallery").contains(event.relatedTarget)) setGalleryDropOverlay(false);
  });
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
    if (state.tool === "polygon") {
      const vertex = polygonVertexAt(point);
      if (vertex >= 0) {
        state.polygonDragIndex = vertex;
        state.drawing = true;
      } else {
        if (state.polygonPoints.length < 4) state.polygonPoints.push(point);
        state.drawing = false;
      }
      updateBoundaryActions(); render(); return;
    }
    beginManualStroke(point); render();
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
      } else if (state.tool === "polygon" && state.polygonDragIndex >= 0) {
        state.polygonPoints[state.polygonDragIndex] = point;
      } else { appendManualStrokePoint(point); state.pointer = point; }
    }
    render();
  });
  function finishCanvasGesture(event, cancelled = false) {
    const wasDrawing = state.drawing;
    const manualStrokeStarted = Boolean(state.activeStroke);
    const boundaryStarted = Boolean(state.boundaryStart);
    try { if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    state.drawing = false; state.panning = false;
    if (state.tool === "polygon") { state.polygonDragIndex = -1; updateBoundaryActions(); render(); return; }
    const boundaryStart = state.boundaryStart;
    const boundaryDragging = state.boundaryDragging;
    state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false;
    canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair";
    if (wasDrawing && manualStrokeStarted) completeManualStroke();
    if (!cancelled && wasDrawing && boundaryStarted && !isBusy() && !state.importing && event?.button === 0) {
      const point = clampPoint(pointFromEvent(event));
      const roi = roiFromPoints(boundaryStart, point);
      if (boundaryDragging && roi) {
        state.boundaryRoi = roi;
        state.boundaryPromptPoint = { x: Math.round((roi.left + roi.right) / 2), y: Math.round((roi.top + roi.bottom) / 2) };
        setStatus(t("status.boundaryReady"));
      } else if (pointInBoundaryRoi(point)) {
        state.boundaryPromptPoint = point;
        setStatus(t("status.boundaryReady"));
      }
    }
    render();
  }
  canvas.addEventListener("pointerup", (event) => finishCanvasGesture(event));
  canvas.addEventListener("pointercancel", (event) => finishCanvasGesture(event, true));
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
    if ((state.tool === "boundary" && state.boundaryRoi) || (state.tool === "polygon" && state.polygonPoints.length)) {
      if (event.key === "Escape") { event.preventDefault(); cancelBoundary(); return; }
      if (event.key === "Enter" && !isBusy()) {
        event.preventDefault();
        if (state.tool === "polygon" && polygonIsValid()) void addBoundaryCandidate(null, state.polygonPoints.map((point) => ({ ...point })));
        else if (state.tool === "boundary") void addBoundaryCandidate(state.boundaryPromptPoint);
        return;
      }
    }
    const menu = $("#catalogContextMenu");
    if (menu.matches?.(":popover-open")) {
      const items = [...menu.querySelectorAll("button:not([disabled])")];
      const currentIndex = items.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeCatalogContextMenu(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        focusElement(items[nextIndex]); return;
      }
    }
    handleWindowKeydown(event);
  });
  window.addEventListener("dragend", () => setGalleryDropOverlay(false));
  document.addEventListener("pointerdown", (event) => {
    const menu = $("#catalogContextMenu");
    if (!menu.matches?.(":popover-open") || menu.contains(event.target)) return;
    closeCatalogContextMenu();
  });
  window.addEventListener("storage", handleReviewStorageEvent);
}

async function initialise() {
  ensureDetectionModeControl();
  try {
    const settings = await api("/api/settings");
    setSettingsForm(settings.settings, settings.status);
  } catch { /* The defaults below keep the editor usable when settings are unavailable. */ }
  await loadTranslations(); bindEvents();
  setNavigationShortcutsEnabled(state.settings?.general?.shortcuts_enabled ?? true);
  new ResizeObserver(resizeRenderCanvas).observe(stage); setInterval(pollJob, 700);
  setInterval(() => { if (state.blinkCandidateIds.size) render(); }, 160);
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
