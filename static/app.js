const $ = (selector) => document.querySelector(selector);

const state = {
  images: [], currentId: null, currentImage: null, pendingImageId: null, galleryFilter: "all", maskStatus: new Map(),
  viewMode: "edit", overviewFilter: "all", overviewQuery: "", overviewFolder: "", reviewedPaths: new Set(), hiddenPaths: new Set(), reviewRoot: "",
  selectedImageIds: new Set(), selectionAnchorId: null, batchMode: false,
  navigationShortcutsEnabled: true,
  candidates: [], candidateImages: new Map(), drafts: new Map(),
  tool: "brush", panning: false, drawing: false, boundaryPending: false,
  boundaryRoi: null, boundaryStart: null, boundaryStartClient: null, boundaryPoint: null, boundaryPromptPoint: null, boundaryDragging: false,
  boundaryDrafts: [], boundaryDraftSequence: 0, boundaryActiveId: null, boundaryBrushStroke: null,
  polygonPoints: [], polygonDragIndex: -1, polygonDraftDrag: null, blinkCandidateIds: new Set(),
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
  // The save folder handle is browser-local and never sent to the server.
  outputDirectoryHandle: null, processing: null, imageInflight: new Map(), candidateInflight: new Map(), loadingDelay: null,
  galleryCollapsed: false, inspectorCollapsed: false,
  settings: null, settingsStatus: null,
  imageCache: new Map(), candidateBundleCache: new Map(),
};

const canvas = $("#editorCanvas");
const stage = $("#canvasStage");
const toolRail = $("#canvasToolRail");
const ctx = canvas.getContext("2d");
const addCanvas = document.createElement("canvas");
const exclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const mosaicCanvas = document.createElement("canvas");
const mosaicSourceCanvas = document.createElement("canvas");
const originalCanvas = document.createElement("canvas");
const historyAddCanvas = document.createElement("canvas");
const historyExclusionCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const boundaryOverlayCanvas = document.createElement("canvas");
const blinkCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const combinedCtx = combinedCanvas.getContext("2d");
const mosaicCtx = mosaicCanvas.getContext("2d");
const mosaicSourceCtx = mosaicSourceCanvas.getContext("2d");
const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true });
const layerCtx = layerCanvas.getContext("2d");
const boundaryOverlayCtx = boundaryOverlayCanvas.getContext("2d");
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
  const language = languageOverride === "en" || (!languageOverride && state.settings?.general?.language === "en") ? "en" : "ja";
  let translations;
  try {
    const response = await fetch(`/i18n/${language}.json`);
    if (!response.ok) throw new Error("translation request failed");
    translations = await response.json();
    if (!translations || Array.isArray(translations) || typeof translations !== "object") throw new Error("invalid translation response");
  } catch {
    return false;
  }
  if (generation !== translationGeneration) return false;
  state.translations = translations;
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]:not([data-i18n-dynamic])").forEach((element) => {
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
  renderModelStatus();
  renderLocalizedDynamicState();
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
  state.status = { message, kind };
  renderStatus();
}

function setStatusKey(key, params = {}, kind = "") {
  state.status = { key, params, kind };
  renderStatus();
}
function clearStatus() { state.status = { message: "", kind: "" }; renderStatus(); }

function processingTitle(kind) {
  return t(kind === "detect" ? "processing.detect" : "processing.import");
}

function showProcessing(processing) {
  state.processing = { ...state.processing, ...processing };
  const current = state.processing;
  const modal = $("#processingDialog");
  $("#processingTitle").textContent = processingTitle(current.kind);
  $("#processingCurrent").textContent = current.current || "";
  $("#processingProgress").max = Math.max(1, Number(current.total) || 1);
  $("#processingProgress").value = Math.min($("#processingProgress").max, Number(current.completed) || 0);
  $("#processingProgressText").textContent = t("status.progressCount", { completed: current.completed || 0, total: current.total || 0 });
  $("#processingPauseButton").textContent = t(current.state === "paused" ? "apply.resume" : "apply.pause");
  if (!modal.open) modal.showModal();
}

function closeProcessing() {
  state.processing = null;
  const modal = $("#processingDialog");
  if (modal.open) modal.close();
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const element = $("#status");
  element.textContent = status.key ? t(status.key, status.params) : status.message;
  element.className = `status ${status.kind}`;
}

function renderLocalizedDynamicState() {
  const record = currentRecord();
  $("#imageInfo").textContent = record && state.currentImage
    ? `${record.relativePath} / ${record.width} x ${record.height}`
    : t("editor.none");
  updateNavigationControls();
  updateCandidateStatus();
  syncApplyMode();
  updateProgress(state.job);
  renderStatus();
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
function activeDetection() { return state.job?.kind === "detect" && ["running", "paused"].includes(state.job?.state); }
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
function saveTargets() { return state.images.filter((image) => !isHidden(image) && imageHasMask(image)).map((image) => image.id); }
function normaliseReviewRoot(value) { return String(value || "").trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(); }
function reviewStoragePrefix() { return state.reviewRoot ? `mozarie.reviewed.v1:${state.reviewRoot}:` : ""; }
function reviewPath(image) { return String(image?.relativePath || "").replaceAll("\\", "/").toLowerCase(); }
function reviewStorageKey(image) { const prefix = reviewStoragePrefix(); const path = reviewPath(image); return prefix && path ? `${prefix}${path}` : ""; }
function hiddenStorageKey(image) { const prefix = reviewStoragePrefix(); const path = reviewPath(image); return prefix && path ? `${prefix}hidden:${path}` : ""; }
function isReviewed(image) { return state.reviewedPaths.has(reviewPath(image)); }
function isHidden(image) { return state.hiddenPaths.has(reviewPath(image)); }
function loadReviewedPaths() {
  if (!reviewStoragePrefix()) { state.reviewedPaths = new Set(); state.hiddenPaths = new Set(); return; }
  try {
    state.reviewedPaths = new Set(state.images.filter((image) => localStorage.getItem(reviewStorageKey(image)) === "true").map(reviewPath));
    state.hiddenPaths = new Set(state.images.filter((image) => localStorage.getItem(hiddenStorageKey(image)) === "true").map(reviewPath));
  } catch { /* Keep the in-session review state when storage is unavailable. */ }
}
function setHidden(image, hidden) {
  if (!image) return;
  const path = reviewPath(image); const key = hiddenStorageKey(image);
  if (hidden) state.hiddenPaths.add(path); else state.hiddenPaths.delete(path);
  if (key) try { if (hidden) localStorage.setItem(key, "true"); else localStorage.removeItem(key); } catch { /* Session state remains usable. */ }
  renderCatalogViews(); updateSelectionActionBar();
}
function selectedImages() { return state.images.filter((image) => state.selectedImageIds.has(image.id)); }
function updateSelectionActionBar() {
  const count = state.selectedImageIds.size; const bar = $("#selectionActionBar");
  bar.hidden = !count || (!state.batchMode && count < 2); $("#selectionCount").textContent = t("selection.count", { count });
  $("#batchModeButton").classList.toggle("active", state.batchMode); $("#batchModeButton").setAttribute("aria-pressed", String(state.batchMode));
}
function selectCatalogImage(imageId, event = null) {
  const index = state.images.findIndex((image) => image.id === imageId); if (index < 0) return;
  if (event?.shiftKey && state.selectionAnchorId) {
    const anchor = state.images.findIndex((image) => image.id === state.selectionAnchorId);
    const range = state.images.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map((image) => image.id);
    if (event.ctrlKey || event.metaKey) range.forEach((id) => state.selectedImageIds.add(id)); else state.selectedImageIds = new Set(range);
  } else if (event?.ctrlKey || event?.metaKey || state.batchMode) {
    if (state.selectedImageIds.has(imageId)) state.selectedImageIds.delete(imageId); else state.selectedImageIds.add(imageId);
    state.selectionAnchorId = imageId;
  } else { state.selectedImageIds = new Set([imageId]); state.selectionAnchorId = imageId; }
  updateSelectionActionBar(); renderCatalogViews(); void selectImage(imageId);
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
  if (state.settings?.shortcuts) state.settings.shortcuts.enabled = state.navigationShortcutsEnabled;
  const settingsControl = $("#settingsShortcutsEnabled");
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
    payload.shortcuts = { ...(payload.shortcuts || {}), enabled: Boolean(enabled) };
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.shortcuts?.enabled ?? data.settings.general.shortcuts_enabled);
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
  $("#galleryFilter").disabled = running;
  $("#saveAllButton").disabled = running || mutatingCandidates || saveTargets().length === 0;
  const currentSaveDisabled = running || mutatingCandidates || !hasImage || !imageHasMask(current);
  $("#saveButton").disabled = currentSaveDisabled;
  $("#applyStartButton").disabled = running || mutatingCandidates || Boolean(applyRestrictionMessage());
  $("#overviewButton").disabled = running || state.images.length === 0;
  $("#previousImageButton").disabled = running || imageIndex() <= 0;
  $("#nextImageButton").disabled = running || imageIndex() < 0 || imageIndex() >= state.images.length - 1;
  $("#nextUnreviewedButton").disabled = running || !nextUnreviewedImage();
  $("#reviewAndNextButton").disabled = running || !hasImage;
  $("#removeAndNextButton").disabled = running || !hasImage;
  $("#hideAndNextButton").disabled = running || !hasImage;
  updateCandidateBatchButtons(hasImage, locked);
  updateHistoryButtons();
  if (locked) for (const control of controls) {
    if (["applyPauseButton", "applyCancelButton"].includes(control.id) && state.applyRunning) continue;
    if (["processingPauseButton", "processingCancelButton"].includes(control.id) && state.processing) continue;
    if (control.id === "detectAllButton" && detecting && !state.detectCancelRequested) continue;
    if (!control.disabled) control.dataset.disabledByLock = "true";
    control.disabled = true;
  }
  $("#gallery").classList.toggle("locked", locked);
  canvas.style.pointerEvents = locked ? "none" : "";
  canvas.setAttribute("aria-disabled", String(locked));
}

function updateCandidateBatchButtons(hasImage = Boolean(state.currentId && state.currentImage && currentRecord()), locked = isBusy() || state.importing, hasManualExclude = false) {
  for (const button of document.querySelectorAll("[data-candidate-batch]")) {
    const [role] = button.dataset.candidateBatch.split(":");
    const hasRoleCandidate = hasImage && (state.candidates.some((candidate) => candidate.role === role) || (role === "apply" ? state.manualMaskPresent : hasManualExclude));
    button.disabled = locked || !hasRoleCandidate;
  }
}

function clearBoundaryInteraction() {
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryStartClient = null;
  state.boundaryPoint = null;
  state.boundaryPromptPoint = null;
  state.boundaryDragging = false;
  state.boundaryDrafts = [];
  state.boundaryActiveId = null;
  state.boundaryBrushStroke = null;
  state.polygonPoints = [];
  state.polygonDragIndex = -1;
  state.polygonDraftDrag = null;
  updateBoundaryActions();
}

function clearBoundaryConstruction() {
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryStartClient = null;
  state.boundaryPoint = null;
  state.boundaryPromptPoint = null;
  state.boundaryDragging = false;
  state.boundaryBrushStroke = null;
  state.polygonPoints = [];
  state.polygonDragIndex = -1;
  state.polygonDraftDrag = null;
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
  closeBoundaryModeMenu({ restoreFocus: true });
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
  if (job?.kind !== "apply" && ["running", "paused"].includes(job?.state)) showProcessing(job);
  updateActionButtons();
}

async function loadFolder() {
  if (isBusy() || state.importing) return;
  const path = $("#folderPath").value.trim();
  if (!path) return setStatusKey("status.enterFolder", {}, "error");
  const picker = $("#pickerMenu");
  if (picker?.matches?.(":popover-open")) picker.hidePopover();
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  setStatusKey("status.loadingImages", {}, "running");
  try {
    const data = await api("/api/folder", { method: "POST", body: JSON.stringify({ path }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    resetCatalog(data.images, path);
    setStatusKey("status.imagesLoaded", { count: state.images.length });
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
}


function renderGallery(force = false) {
  if (!force && state.viewMode === "overview") return;
  const gallery = $("#gallery");
  const scrollTop = gallery.scrollTop;
  const visibleImages = state.images.filter(imageMatchesGalleryFilter);
  const imageCount = t("gallery.count", { count: visibleImages.length });
  for (const element of document.querySelectorAll(".gallery-local-count")) element.textContent = imageCount;
  $("#galleryFilter").value = state.galleryFilter;
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
    item.classList.toggle("selected", state.selectedImageIds.has(image.id) || image.id === state.currentId);
    item.classList.toggle("hidden", isHidden(image));
    item.classList.toggle("reviewed", isReviewed(image));
    const preview = item.querySelector("img");
    const previewSource = `/api/thumbnail/${encodeURIComponent(image.id)}?v=${encodeURIComponent(`${image.mtimeNs || ""}-${image.contentVersion || 0}`)}`;
    if (!String(preview.src || "").endsWith(previewSource)) preview.src = previewSource;
    preview.alt = image.relativePath;
    item.querySelector(".gallery-name").textContent = image.relativePath.split("/").pop();
    item.querySelector(".gallery-meta").textContent = `${image.width} x ${image.height}${image.candidateCount ? ` / ${t("gallery.candidates", { count: image.candidateCount })}` : ""}`;
    const reviewBadge = item.querySelector(".gallery-review-badge");
    reviewBadge.textContent = isReviewed(image) ? t("review.reviewedBadge") : t("review.unreviewedBadge");
    item.onclick = (event) => selectCatalogImage(image.id, event);
    item.onmouseenter = () => { void cachedImage(image).catch(() => {}); void loadCandidateBundle(image.id, state.imageGeneration).catch(() => {}); prefetchNeighbors(image); };
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

function imageMatchesGalleryFilter(image) {
  if (state.galleryFilter !== "hidden" && isHidden(image)) return false;
  if (state.galleryFilter === "masked") return imageHasMask(image);
  if (state.galleryFilter === "unmasked") return !imageHasMask(image);
  if (state.galleryFilter === "hidden") return isHidden(image);
  if (state.galleryFilter === "reviewed") return isReviewed(image);
  if (state.galleryFilter === "unreviewed") return !isReviewed(image);
  return true;
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
    if (state.overviewFilter !== "hidden" && isHidden(image)) return false;
    if (state.overviewFilter === "hidden" && !isHidden(image)) return false;
    if (state.overviewFilter === "unreviewed" && isReviewed(image)) return false;
    if (state.overviewFilter === "reviewed" && !isReviewed(image)) return false;
    if (state.overviewFilter === "masked" && !imageHasMask(image)) return false;
    if (state.overviewFilter === "unmasked" && imageHasMask(image)) return false;
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
    item.classList.toggle("selected", state.selectedImageIds.has(image.id) || image.id === state.currentId);
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
    item.onclick = (event) => { setViewMode("edit"); selectCatalogImage(image.id, event); };
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
  const visible = state.images.filter((image) => !isHidden(image)); const index = visible.findIndex((image) => image.id === state.currentId);
  const target = visible[index + offset];
  if (target) void selectImage(target.id);
}
function nextUnreviewedImage() {
  const current = imageIndex();
  for (let index = Math.max(0, current + 1); index < state.images.length; index += 1) if (!isHidden(state.images[index]) && !isReviewed(state.images[index])) return state.images[index];
  return null;
}
function moveToNextUnreviewed() { if (isGestureActive()) return; const target = nextUnreviewedImage(); if (target) void selectImage(target.id); }
function reviewAndMoveNext() {
  if (isGestureActive()) return null;
  const current = currentRecord();
  if (!current) return null;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  setReviewed(current, true);
  if (target) void selectImage(target.id);
  return target;
}
async function hideAndMoveNext() {
  if (isGestureActive()) return;
  const current = currentRecord();
  if (!current) return;
  const target = state.images.slice(imageIndex(current.id) + 1).find((image) => !isHidden(image)) || null;
  setHidden(current, true);
  if (target) await selectImage(target.id);
}
function runNavigationAction(action) {
  action();
  focusCanvas();
}
function updateNavigationControls() {
  const index = imageIndex();
  const position = index < 0 ? "- / -" : `${index + 1} / ${state.images.length}`;
  $("#imagePosition").textContent = position;
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
  closeBoundaryModeMenu({ restoreFocus: true });
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
  closeBoundaryModeMenu();
  clearBoundaryInteraction();
  updateActionButtons();
  const record = state.images.find((image) => image.id === imageId);
  if (!record) {
    state.pendingImageId = null;
    updateActionButtons();
    return;
  }
  const imageCached = state.imageCache.has(imageCacheKey(record));
  const candidatesCached = state.candidateBundleCache.has(candidateCacheKey(imageId, Number(record.candidateRevision || 0)));
  if (!imageCached || !candidatesCached) {
    clearTimeout(state.loadingDelay);
    state.loadingDelay = setTimeout(() => {
      if (state.pendingImageId === imageId && isCurrentGeneration(generation)) setStatusKey("status.loadingImages", {}, "running");
    }, 150);
  }
  try {
    const [image, candidateBundle] = await Promise.all([
      cachedImage(record),
      loadCandidateBundle(imageId, generation),
    ]);
    clearTimeout(state.loadingDelay); state.loadingDelay = null;
    syncCandidateRecord(imageId, candidateBundle.candidates);
    if (!isCurrentGeneration(generation)) return;
    state.currentId = imageId;
    state.pendingImageId = null;
    state.currentImage = image;
    state.candidates = candidateBundle.candidates;
    state.candidateImages = candidateBundle.candidateImages;
    canvasSizeForImage(record); restoreDraft(imageId, generation); rebuildMosaicPreview(); fitImage();
    updateBlockSizeDisplay(); refreshMaskStatus();
    $("#emptyState").hidden = true;
    $("#imageInfo").textContent = `${record.relativePath} / ${record.width} x ${record.height}`;
    updateCandidateStatus();
    renderCandidates(); updateGallerySelection(); updateNavigationControls(); updateActionButtons(); render(); clearStatus();
    state.galleryNodes.get(imageId)?.scrollIntoView?.({ block: "nearest" });
    state.overviewNodes.get(imageId)?.scrollIntoView?.({ block: "nearest" });
    prefetchNeighbors(record);
  } catch (error) {
    if (isCurrentGeneration(generation)) {
      clearTimeout(state.loadingDelay); state.loadingDelay = null;
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
  const pending = state.imageInflight.get(key);
  if (pending) return pending;
  const request = loadImage(`/api/image/${encodeURIComponent(record.id)}?v=${encodeURIComponent(record.contentVersion || record.mtimeNs || 0)}`)
    .then((image) => lruRemember(state.imageCache, key, image, 6, releaseImageResource))
    .finally(() => state.imageInflight.delete(key));
  state.imageInflight.set(key, request);
  return request;
}

function prefetchNeighbors(record) {
  const index = state.images.findIndex((item) => item.id === record.id);
  for (const neighbor of [state.images[index - 1], state.images[index + 1]]) {
    if (!neighbor) continue;
    void cachedImage(neighbor).catch(() => {});
    void loadCandidateBundle(neighbor.id, state.imageGeneration).catch(() => {});
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
  for (const key of state.imageInflight.keys()) if (matches(key)) state.imageInflight.delete(key);
  for (const key of state.candidateInflight.keys()) if (matches(key)) state.candidateInflight.delete(key);
}

function invalidateCandidateBundles(imageId) {
  for (const [key, bundle] of state.candidateBundleCache) {
    if (!key.startsWith(`${imageId}:`)) continue;
    if (bundle.candidateImages !== state.candidateImages) releaseCandidateBundle(bundle);
    state.candidateBundleCache.delete(key);
  }
}

function retainCurrentCandidateBundle(imageId, revision) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  const currentImages = state.currentId === imageId ? state.candidateImages : null;
  let reusable = null;
  for (const [key, bundle] of state.candidateBundleCache) {
    if (!key.startsWith(`${imageId}:`) || (currentImages && bundle.candidateImages !== currentImages)) continue;
    reusable = bundle;
    state.candidateBundleCache.delete(key);
    break;
  }
  record.candidateRevision = Number(revision || 0);
  if (!reusable || !currentImages) return;
  reusable.candidates = state.candidates;
  reusable.candidateImages = currentImages;
  reusable.candidateRevision = record.candidateRevision;
  lruRemember(state.candidateBundleCache, candidateCacheKey(imageId, record.candidateRevision), reusable, 12, releaseCandidateBundle);
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
  const record = state.images.find((image) => image.id === imageId);
  const knownRevision = Number(record?.candidateRevision || 0);
  const knownKey = candidateCacheKey(imageId, knownRevision);
  const known = state.candidateBundleCache.get(knownKey);
  if (known) return lruRemember(state.candidateBundleCache, knownKey, known, 12, releaseCandidateBundle);
  const pending = state.candidateInflight.get(knownKey);
  if (pending) return pending;
  const request = (async () => {
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
      state.candidateInflight.delete(knownKey);
      return loadCandidateBundle(imageId, generation, true);
    }
    throw error;
  }
  })().finally(() => state.candidateInflight.delete(knownKey));
  state.candidateInflight.set(knownKey, request);
  return request;
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
  layerCanvas.width = canvas.width; layerCanvas.height = canvas.height;
  boundaryOverlayCanvas.width = canvas.width; boundaryOverlayCanvas.height = canvas.height;
  render();
}

function setCssTransform(context) { const dpr = window.devicePixelRatio || 1; context.setTransform(dpr, 0, 0, dpr, 0, 0); }

function rebuildMosaicPreview() {
  if (!state.currentImage) return;
  originalCanvas.width = state.currentImage.width; originalCanvas.height = state.currentImage.height;
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height); originalCtx.drawImage(state.currentImage, 0, 0);
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
  if (!state.hover || !state.currentImage || !["brush", "eraser", "boundary_brush"].includes(state.tool)) return;
  const radius = Math.max(1, Number($("#brushSize").value) * state.view.scale / 2);
  const x = state.view.x + state.hover.x * state.view.scale;
  const y = state.view.y + state.hover.y * state.view.scale;
  ctx.save();
  if (state.tool === "eraser") ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = state.tool === "boundary_brush" ? "#50d589" : "#ffffff"; ctx.lineWidth = 3; ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#111316"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function roiFromPoints(start, end) {
  const left = Math.floor(Math.min(start.x, end.x)); const top = Math.floor(Math.min(start.y, end.y));
  const right = Math.ceil(Math.max(start.x, end.x)); const bottom = Math.ceil(Math.max(start.y, end.y));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}

function boundaryDraftRoi() {
  return state.boundaryDragging && state.boundaryStart && state.boundaryPoint
    ? roiFromPoints(state.boundaryStart, state.boundaryPoint)
    : state.boundaryRoi;
}

function boundaryDraftId() { state.boundaryDraftSequence += 1; return `boundary-${state.boundaryDraftSequence}`; }
function pointForRoi(roi) { return { x: Math.round((roi.left + roi.right) / 2), y: Math.round((roi.top + roi.bottom) / 2) }; }

function polygonRoi(points) {
  if (!points.length) return null;
  return {
    left: Math.floor(Math.min(...points.map((point) => point.x))), right: Math.ceil(Math.max(...points.map((point) => point.x))),
    top: Math.floor(Math.min(...points.map((point) => point.y))), bottom: Math.ceil(Math.max(...points.map((point) => point.y))),
  };
}

function boundaryDraftBounds(draft) { return draft?.roi || polygonRoi(draft?.points || []); }

function addBoundaryDraft(draft) {
  const item = { id: boundaryDraftId(), ...draft };
  state.boundaryDrafts.push(item);
  state.boundaryActiveId = item.id;
  return item;
}

function activeBoundaryShape() {
  const rectangle = boundaryDraftRoi();
  if (rectangle) return { type: "rectangle", roi: rectangle, point: state.boundaryPromptPoint || pointForRoi(rectangle), transient: true };
  if (state.polygonPoints.length) return { type: "polygon", points: state.polygonPoints, transient: true };
  if (state.boundaryBrushStroke) return { ...state.boundaryBrushStroke, transient: true };
  return null;
}

function boundaryShapes() { return [...state.boundaryDrafts, ...[activeBoundaryShape()].filter(Boolean)]; }

function strokeRoi(points, radius) {
  if (!points.length) return null;
  const padding = Math.max(1, radius / 2);
  const image = state.currentImage;
  const clampX = (value) => Math.max(0, Math.min(image.width, value));
  const clampY = (value) => Math.max(0, Math.min(image.height, value));
  const roi = {
    left: Math.floor(clampX(Math.min(...points.map((point) => point.x)) - padding)),
    top: Math.floor(clampY(Math.min(...points.map((point) => point.y)) - padding)),
    right: Math.ceil(clampX(Math.max(...points.map((point) => point.x)) + padding)),
    bottom: Math.ceil(clampY(Math.max(...points.map((point) => point.y)) + padding)),
  };
  return roiFromPoints({ x: roi.left, y: roi.top }, { x: roi.right, y: roi.bottom });
}

function appendBoundaryBrushPoint(point) {
  const stroke = state.boundaryBrushStroke;
  if (!stroke) return;
  const previous = stroke.points.at(-1);
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) >= 0.5) stroke.points.push(point);
  stroke.roi = strokeRoi(stroke.points, stroke.radius);
}

function beginBoundaryBrushStroke(point) {
  state.boundaryBrushStroke = { type: "brush", points: [point], radius: Math.max(1, Number($("#brushSize").value)), roi: null };
  state.boundaryBrushStroke.roi = strokeRoi(state.boundaryBrushStroke.points, state.boundaryBrushStroke.radius);
}

function completeBoundaryBrushStroke() {
  const stroke = state.boundaryBrushStroke;
  state.boundaryBrushStroke = null;
  if (!stroke?.roi) return;
  addBoundaryDraft({ type: "brush", points: stroke.points.map((point) => ({ ...point })), radius: stroke.radius, roi: stroke.roi, point: pointForRoi(stroke.roi) });
  setStatusKey("status.boundaryReady");
}

function rectsTouch(first, second) {
  return first.left <= second.right + 1 && first.right + 1 >= second.left
    && first.top <= second.bottom + 1 && first.bottom + 1 >= second.top;
}

function joinRois(rois) {
  return {
    left: Math.min(...rois.map((roi) => roi.left)), right: Math.max(...rois.map((roi) => roi.right)),
    top: Math.min(...rois.map((roi) => roi.top)), bottom: Math.max(...rois.map((roi) => roi.bottom)),
  };
}

function boundaryRequests() {
  const requests = [];
  const brushGroups = [];
  state.boundaryDrafts.forEach((draft, index) => {
    if (draft.type !== "brush") {
      if (draft.type === "polygon" && !polygonPointsValid(draft.points || [])) return;
      requests.push({ firstIndex: index, draftIds: [draft.id], draft });
      return;
    }
    if (!draft.roi) return;
    let group = brushGroups.find((item) => rectsTouch(item.roi, draft.roi));
    if (!group) { brushGroups.push({ drafts: [draft], roi: { ...draft.roi }, firstIndex: index }); return; }
    group.drafts.push(draft); group.roi = joinRois(group.drafts.map((item) => item.roi));
    group.firstIndex = Math.min(group.firstIndex, index);
    for (let index = brushGroups.length - 1; index >= 0; index -= 1) {
      const other = brushGroups[index];
      if (other === group || !rectsTouch(group.roi, other.roi)) continue;
      group.drafts.push(...other.drafts); group.roi = joinRois(group.drafts.map((item) => item.roi)); group.firstIndex = Math.min(group.firstIndex, other.firstIndex); brushGroups.splice(index, 1);
    }
  });
  for (const group of brushGroups) requests.push({ firstIndex: group.firstIndex, draftIds: group.drafts.map((draft) => draft.id), draft: { type: "brush", roi: group.roi, point: pointForRoi(group.roi) } });
  return requests.sort((first, second) => first.firstIndex - second.firstIndex).map(({ draftIds, draft }) => ({ draftIds, draft }));
}

function boundaryPath(shape, context = ctx) {
  const roi = boundaryDraftBounds(shape);
  if (shape.type === "polygon" && shape.points?.length) {
    shape.points.forEach((point, index) => {
      const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    if (shape.points.length === 4) context.closePath();
    return;
  }
  if (shape.type === "brush" && shape.points?.length) {
    const points = shape.points;
    const first = points[0];
    context.moveTo(state.view.x + first.x * state.view.scale, state.view.y + first.y * state.view.scale);
    for (const point of points.slice(1)) context.lineTo(state.view.x + point.x * state.view.scale, state.view.y + point.y * state.view.scale);
    if (points.length === 1) context.lineTo(state.view.x + first.x * state.view.scale + 0.01, state.view.y + first.y * state.view.scale + 0.01);
    return;
  }
  if (roi) context.rect(state.view.x + roi.left * state.view.scale, state.view.y + roi.top * state.view.scale, (roi.right - roi.left) * state.view.scale, (roi.bottom - roi.top) * state.view.scale);
}

function drawBoundaryScrim(shapes) {
  if (!shapes.length || !state.currentImage) return;
  setCssTransform(boundaryOverlayCtx); boundaryOverlayCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  boundaryOverlayCtx.save();
  boundaryOverlayCtx.beginPath(); boundaryOverlayCtx.rect(state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale); boundaryOverlayCtx.clip();
  boundaryOverlayCtx.fillStyle = "rgba(8, 11, 14, 0.68)"; boundaryOverlayCtx.fillRect(state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale);
  boundaryOverlayCtx.globalCompositeOperation = "destination-out";
  for (const shape of shapes) {
    boundaryOverlayCtx.beginPath();
    boundaryPath(shape, boundaryOverlayCtx);
    if (shape.type === "brush") {
      boundaryOverlayCtx.lineWidth = Math.max(1, shape.radius * state.view.scale); boundaryOverlayCtx.lineCap = "round"; boundaryOverlayCtx.lineJoin = "round"; boundaryOverlayCtx.stroke();
    } else boundaryOverlayCtx.fill();
  }
  boundaryOverlayCtx.restore(); setCssTransform(ctx); ctx.drawImage(boundaryOverlayCanvas, 0, 0, stage.clientWidth, stage.clientHeight);
}

function drawBoundaryShape(shape) {
  const ready = shape.type !== "polygon" || polygonPointsValid(shape.points || []);
  ctx.save(); ctx.strokeStyle = ready ? "#50d589" : "#f0ba62"; ctx.lineWidth = 2;
  ctx.beginPath(); boundaryPath(shape);
  if (shape.type === "brush") { ctx.lineWidth = Math.max(2, shape.radius * state.view.scale); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(); }
  else ctx.stroke();
  if (shape.type === "polygon") for (const point of shape.points) {
    const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = "#effff4"; ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawBoundaryRoi() {
  const shapes = boundaryShapes();
  if (!shapes.length) return;
  drawBoundaryScrim(shapes);
  shapes.forEach(drawBoundaryShape);
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

function polygonPointsValid(points) {
  return points.length === 4
    && polygonArea(points) >= 16
    && !polygonSegmentsIntersect(points[0], points[1], points[2], points[3])
    && !polygonSegmentsIntersect(points[1], points[2], points[3], points[0]);
}

function polygonIsValid() { return polygonPointsValid(state.polygonPoints); }

function canDetectBoundary() {
  const constructing = state.boundaryDragging || state.polygonPoints.length > 0 || Boolean(state.boundaryBrushStroke);
  return Boolean(state.currentId && state.currentImage && boundaryRequests().length)
    && !constructing && !state.pendingImageId && !state.boundaryPending && !isBusy() && !state.importing;
}

function hasBoundaryDraft() {
  return Boolean(state.boundaryDrafts.length || activeBoundaryShape());
}

function boundaryActionAnchor() {
  const active = activeBoundaryShape() || state.boundaryDrafts.find((draft) => draft.id === state.boundaryActiveId) || state.boundaryDrafts.at(-1);
  const roi = boundaryDraftBounds(active);
  if (!roi) return null;
  return {
    left: state.view.x + roi.left * state.view.scale, right: state.view.x + roi.right * state.view.scale,
    top: state.view.y + roi.top * state.view.scale, bottom: state.view.y + roi.bottom * state.view.scale,
  };
}

function updateBoundaryActions() {
  const actions = $("#boundaryActions");
  if (!actions) return;
  const active = !state.boundaryPending && !state.pendingImageId && hasBoundaryDraft();
  const focusedAction = document.activeElement === $("#boundaryDetectButton") || document.activeElement === $("#boundaryCancelButton");
  actions.hidden = !active;
  $("#boundaryDetectButton").disabled = !canDetectBoundary();
  if (!active) {
    if (focusedAction) focusCanvas();
    return;
  }
  const anchor = boundaryActionAnchor();
  if (!anchor) return;
  const width = actions.offsetWidth || 142;
  const height = actions.offsetHeight || 38;
  const minLeft = 8; const maxLeft = Math.max(minLeft, stage.clientWidth - width - 8);
  const minTop = 8; const maxTop = Math.max(minTop, stage.clientHeight - height - 8);
  const horizontal = Math.max(minLeft, Math.min(maxLeft, anchor.left + (anchor.right - anchor.left - width) / 2));
  const below = anchor.bottom + 8;
  const vertical = Math.max(minTop, Math.min(maxTop, below + height <= stage.clientHeight - 8 ? below : anchor.top - height - 8));
  actions.style.left = `${Math.round(horizontal)}px`;
  actions.style.top = `${Math.round(vertical)}px`;
}

function drawPolygonBoundary() {
  // Polygon drawing is handled together with every selected boundary shape.
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
  if (!state.currentId) { updateCandidateBatchButtons(false); return; }
  const hasManualExclude = canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (!state.candidates.length && !state.manualMaskPresent && !hasManualExclude) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); applyList.append(empty); updateCandidateBatchButtons(undefined, undefined, hasManualExclude); return;
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
  updateCandidateBatchButtons(undefined, undefined, hasManualExclude);
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
      const result = await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color }),
      });
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        const currentCandidate = state.candidates.find((item) => item.id === candidate.id);
        if (currentCandidate) currentCandidate.enabled = desired;
        retainCurrentCandidateBundle(imageId, result.candidateRevision);
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
  if (confirmationRequired("candidateDelete") && !await confirmAction(t("confirm.candidateDelete.title"), t("confirm.candidateDelete.message"), "candidateDelete")) return;
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
      const result = await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      syncCandidateRecord(imageId, remainingCandidates);
      state.maskStatus.set(imageId, remainingMaskStatus);
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        state.candidates = remainingCandidates;
        state.candidateImages.delete(candidate.id);
        retainCurrentCandidateBundle(imageId, result.candidateRevision);
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

async function batchCandidateOperation(spec) {
  if (!state.currentId || isBusy() || state.importing) return;
  const [role, operation] = spec.split(":");
  const manual = role === "apply" ? state.manualMaskPresent : canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (operation === "blink") {
    const ids = state.candidates.filter((item) => item.role === role).map((item) => item.id);
    if (manual) ids.push(`manual:${role}`);
    const allActive = ids.length && ids.every((id) => state.blinkCandidateIds.has(id));
    ids.forEach((id) => allActive ? state.blinkCandidateIds.delete(id) : state.blinkCandidateIds.add(id));
    renderCandidates(); render(); return;
  }
  if (operation === "delete" && confirmationRequired("candidateRoleDelete") && !await confirmAction(t("confirm.candidateRoleDelete.title"), t("confirm.candidateRoleDelete.message"), "candidateRoleDelete")) return;
  if (manual) {
    if (operation === "delete") role === "apply" ? deleteManualMask() : deleteManualExclusion();
    else if (role === "apply") state.manualEnabled = operation === "enable";
    else state.manualExclusionEnabled = operation === "enable";
  }
  const changed = state.candidates.filter((item) => item.role === role);
  if (!changed.length) { renderCandidates(); render(); return; }
  try {
    const result = await api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageId: state.currentId, role, operation }) });
    if (operation === "delete") {
      changed.forEach((item) => state.candidateImages.delete(item.id));
      state.candidates = state.candidates.filter((item) => item.role !== role);
    } else changed.forEach((item) => { item.enabled = operation === "enable"; });
    retainCurrentCandidateBundle(state.currentId, result.candidateRevision);
    setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); renderCandidates(); render();
  } catch (error) { setStatus(error.message, "error"); }
}

async function addBoundaryCandidate() {
  if (!canDetectBoundary()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const requests = boundaryRequests();
  let catalogChanged = false;
  state.boundaryPending = true; updateBoundaryActions(); updateActionButtons(); setStatusKey("status.boundaryDetecting", {}, "running");
  try {
    for (const request of requests) {
      const body = request.draft.type === "polygon"
        ? { imageId, points: request.draft.points.map((point) => ({ ...point })) }
        : { imageId, roi: request.draft.roi, point: request.draft.point || pointForRoi(request.draft.roi) };
      let data;
      try {
        data = await api("/api/boundary", { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error");
        break;
      }
      const created = Array.isArray(data.candidates) ? data.candidates : [];
      if (!created.length || !Number.isInteger(data.candidateRevision)) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(t("error.boundaryResponse"), "error");
        break;
      }
      const record = state.images.find((item) => item.id === imageId);
      if (record) {
        record.candidateCount = (record.candidateCount || 0) + created.length;
        record.enabledCandidateCount = (record.enabledCandidateCount || 0) + created.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
        record.candidateRevision = data.candidateRevision;
        state.maskStatus.set(imageId, true);
      }
      state.boundaryDrafts = state.boundaryDrafts.filter((draft) => !request.draftIds.includes(draft.id));
      state.boundaryActiveId = state.boundaryDrafts.at(-1)?.id || null;
      invalidateCandidateBundles(imageId); catalogChanged = true;
    }
    if (catalogChanged) {
      markImagesUnreviewed([imageId], false);
      if (state.currentId === imageId && state.imageGeneration === viewGeneration) {
        await reconcileCurrentCandidates(imageId, viewGeneration);
        if (!state.boundaryDrafts.length) setStatusKey("status.boundaryDone");
      }
    }
  } catch (error) {
    if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error");
  } finally {
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
function completedPolygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  for (const draft of [...state.boundaryDrafts].reverse()) {
    if (draft.type !== "polygon") continue;
    const index = draft.points.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
    if (index >= 0) return { draft, index };
  }
  return null;
}
function rectangleDraftAt(point) {
  return [...state.boundaryDrafts].reverse().find((draft) => draft.type === "rectangle"
    && point.x >= draft.roi.left && point.x < draft.roi.right
    && point.y >= draft.roi.top && point.y < draft.roi.bottom) || null;
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

function fillAt(point) {
  if (!state.currentImage) return;
  const width = originalCanvas.width; const height = originalCanvas.height;
  const pixels = originalCtx.getImageData(0, 0, width, height).data;
  const x = Math.min(width - 1, Math.max(0, Math.floor(point.x))); const y = Math.min(height - 1, Math.max(0, Math.floor(point.y)));
  const start = (y * width + x) * 4; const seed = [pixels[start], pixels[start + 1], pixels[start + 2]];
  const tolerance = Math.max(0, Math.min(255, Number($("#bucketTolerance").value) || 0));
  const seen = new Uint8Array(width * height); const accepted = new Uint8Array(width * height); const queue = [y * width + x]; seen[queue[0]] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]; const offset = index * 4; const distance = Math.max(Math.abs(pixels[offset] - seed[0]), Math.abs(pixels[offset + 1] - seed[1]), Math.abs(pixels[offset + 2] - seed[2]));
    if (distance > tolerance) continue;
    accepted[index] = 1; const px = index % width; const py = Math.floor(index / width);
    for (const neighbor of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
      const [nx, ny] = neighbor; const next = ny * width + nx;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && !seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  const spans = [];
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width;) {
    if (!accepted[row * width + column]) { column += 1; continue; }
    const startColumn = column; while (column < width && accepted[row * width + column]) column += 1;
    spans.push([row, startColumn, column]);
  }
  applyFillSpans(spans); state.history.splice(state.historyIndex); state.history.push({ tool: "bucket", spans });
  if (state.history.length > 12) { const oldest = state.history.shift(); replayManualStroke(oldest, historyAddCanvas.getContext("2d"), historyExclusionCanvas.getContext("2d")); }
  state.historyIndex = state.history.length; state.manualMaskPresent = true; setReviewed(currentRecord(), false); updateHistoryButtons(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function paintFillSpans(addContext, exclusionContext, spans) {
  addContext.save(); addContext.fillStyle = "#ffffff";
  exclusionContext.save(); exclusionContext.globalCompositeOperation = "destination-out";
  for (const [row, start, end] of spans) { addContext.fillRect(start, row, end - start, 1); exclusionContext.fillRect(start, row, end - start, 1); }
  addContext.restore(); exclusionContext.restore();
}
function applyFillSpans(spans) { paintFillSpans(addCtx, exclusionCtx, spans); composeCurrentMask(); }

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
  if (stroke.tool === "bucket") { paintFillSpans(addContext, exclusionContext, stroke.spans); return; }
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
function detectionTargets(prefix = "detectTarget") {
  const selected = ["penis", "pussy"].filter((name) => $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked === true);
  return selected.length ? selected : (state.settings?.detection?.targets || ["penis", "pussy"]);
}
function setDetectionTargets(targets, prefix = "detectTarget") {
  const selected = new Set(targets || ["penis", "pussy"]);
  for (const name of ["penis", "pussy"]) $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked = selected.has(name);
}

function normaliseImportParallelism(value) {
  if (String(value ?? "").trim() === "") return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.round(number))) : 3;
}

function importParallelism() {
  return normaliseImportParallelism(state.settings?.importing?.parallelism);
}

function openDetectionDialog(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.pendingDetectionTargetIds = [...imageIds];
  setDetectionConfidence(detectionConfidence());
  $("#detectParallelism").value = String(detectionParallelism());
  setDetectionTargets(state.settings?.detection?.targets, "dialogTarget");
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  $("#detectDialog").showModal();
}

async function runDetection(imageIds, confidence = detectionConfidence(), parallelism = 1, targetClasses = detectionTargets()) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.detectionStarting = true;
  updateActionButtons();
  try {
    if (!targetClasses.length) throw new Error("penis または pussy を選択してください。");
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence, parallelism: Math.min(4, Math.max(1, Math.round(parallelism))), targetClasses }) });
    state.detectionTargetIds = [...imageIds];
    state.detectCancelRequested = false;
    state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "" };
    showProcessing(state.job);
    updateProgress(state.job); setStatusKey("status.detectStarted", {}, "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
  finally { state.detectionStarting = false; updateActionButtons(); }
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  const imageIds = state.pendingDetectionTargetIds;
  if (!imageIds.length) return;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  const parallelism = detectionParallelism();
  const targetClasses = detectionTargets("dialogTarget");
  setDetectionConfidence(confidence);
  $("#detectDialog").close();
  state.pendingDetectionTargetIds = [];
  if (state.settings) {
    state.settings.detection = { ...state.settings.detection, threshold: confidence, parallelism, targets: targetClasses };
    try { await api("/api/settings", { method: "POST", body: JSON.stringify(state.settings) }); }
    catch (error) { setStatus(error.message, "error"); return; }
  }
  await runDetection(imageIds, confidence, parallelism, targetClasses);
}

async function cancelDetection() {
  if (!activeDetection() || state.detectCancelRequested) return;
  state.detectCancelRequested = true;
  updateActionButtons();
  setStatusKey("status.detectCancelling", {}, "running");
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
  $("#applySuffixRow").hidden = !copying;
  $("#deleteOriginalRow").hidden = !copying;
  $("#applyOutputDirectoryRow").hidden = !copying;
  $("#applySuffix").disabled = state.applyRunning;
  $("#chooseOutputDirectoryButton").disabled = state.applyRunning || state.saveStarting;
  const outputDirectory = state.outputDirectoryHandle;
  $("#applyOutputDirectoryStatus").textContent = outputDirectory
    ? t("apply.outputDirectorySelected", { name: outputDirectory.name })
    : t("apply.outputDirectorySelected", { name: "Mozarie/output" });
  $("#deleteOriginal").disabled = !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#removeAfterSave").disabled = state.applyRunning;
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

const OUTPUT_HANDLE_DB = "mozarie-output";
const OUTPUT_HANDLE_STORE = "handles";
const OUTPUT_HANDLE_KEY = "default";

function outputHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTPUT_HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OUTPUT_HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readOutputHandle() {
  const database = await outputHandleDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTPUT_HANDLE_STORE, "readonly").objectStore(OUTPUT_HANDLE_STORE).get(OUTPUT_HANDLE_KEY);
    request.onsuccess = () => { database.close(); resolve(request.result || null); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function storeOutputHandle(handle) {
  const database = await outputHandleDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTPUT_HANDLE_STORE, "readwrite").objectStore(OUTPUT_HANDLE_STORE).put(handle, OUTPUT_HANDLE_KEY);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function ensureOutputHandlePermission(handle) {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error(t("error.directoryPermissionDenied"));
  return handle;
}

function renderOutputHandle() {
  const label = state.outputDirectoryHandle?.name || "Mozarie/output";
  $("#settingsDefaultOutputDirectory").textContent = label;
  syncApplyMode();
}

async function selectOutputDirectory() {
  if (typeof window.showDirectoryPicker !== "function") throw new Error(t("error.directoryPickerUnsupported"));
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "mozarie-output" });
  await ensureOutputHandlePermission(handle);
  await storeOutputHandle(handle);
  state.outputDirectoryHandle = handle;
  renderOutputHandle();
  return handle;
}

async function outputDirectoryForSave() {
  if (state.outputDirectoryHandle) return ensureOutputHandlePermission(state.outputDirectoryHandle);
  return selectOutputDirectory();
}

async function pickOutputDirectory() {
  return selectOutputDirectory();
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting) return;
  try { await selectOutputDirectory(); setApplyResult(""); }
  catch (error) { if (error?.name !== "AbortError") setApplyResult(error.message, true); }
}

async function restoreOutputDirectory() {
  try {
    const handle = await readOutputHandle();
    if (!handle || await handle.queryPermission({ mode: "readwrite" }) !== "granted") return;
    state.outputDirectoryHandle = handle;
    renderOutputHandle();
  } catch { /* The save picker remains available even when browser storage is unavailable. */ }
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

async function uniqueOutputFileHandle(rootHandle, relativePath, suffix) {
  const parts = String(relativePath).split("/").filter(Boolean);
  const sourceName = parts.pop();
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const extension = dot > 0 ? sourceName.slice(dot) : "";
  let directory = rootHandle;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  for (let index = 1; index < 10000; index += 1) {
    const name = `${stem}${suffix}${index === 1 ? "" : `_${index}`}${extension}`;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
      return { directory, name, fileHandle: await directory.getFileHandle(name, { create: true }) };
    }
  }
  throw new Error(t("error.outputNameExhausted"));
}

async function writeCopyOutput(rootHandle, entry, suffix, bytes) {
  const output = await uniqueOutputFileHandle(rootHandle, entry.relativePath, suffix);
  const fileHandle = output.fileHandle;
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try { await writable.write(bytes); await writable.close(); }
  catch (error) {
    try { await writable.abort?.(); } catch { /* Continue with best-effort cleanup below. */ }
    try { await output.directory.removeEntry(output.name); } catch { /* Preserve the original write error. */ }
    throw error;
  }
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
      const saveEntry = async (entry) => {
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
          await writeCopyOutput(directory, entry, suffix, bytes);
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
      };
      let nextEntry = 0;
      const parallelism = Math.min(save.entries.length, Math.max(1, Math.round(Number(state.settings?.saving?.parallelism) || 1)));
      await Promise.all(Array.from({ length: parallelism }, async () => {
        while (true) {
          // Cancellation is observed only before an entry starts. Once an output or source has
          // changed, commit that entry so browser files and catalog state remain consistent.
          if (!await waitForBrowserSave(save)) return;
          const entry = save.entries[nextEntry++];
          if (!entry) return;
          await saveEntry(entry);
        }
      }));
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
  if (!copy && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
  if (copy && $("#deleteOriginal").checked && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
  // This lock is intentionally set before the first await. A second submit must never create
  // another browser save loop while permissions or the output-directory picker are pending.
  state.saveStarting = true;
  state.saving = true;
  state.applyRunning = true;
  updateActionButtons();
  if (copy && !state.outputDirectoryHandle) {
    try {
      await api("/api/apply", { method: "POST", body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, drafts: draftPayload(imageIds), removeAfterSave: $("#removeAfterSave").checked, copyToDefault: true }) });
      state.saveStarting = false; state.job = { kind: "apply", state: "running", total: imageIds.length, completed: 0, current: "" }; showRunningApply(state.job); return;
    } catch (error) { setApplyResult(error.message, true); return finishSaveStart(); }
  }
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
      if (!outputDirectory) return finishSaveStart();
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
  closeProcessing();
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
      if (job.state === "complete") setStatusKey("status.applyDone");
      else if (job.state === "cancelled") setStatusKey("status.applyCancelled");
      else if (job.error) setStatus(job.error, "error");
      else setStatusKey("error.background", {}, "error");
    } else if (job.kind === "apply" && ["running", "paused"].includes(job.state)) {
      if (!state.applyRunning) showRunningApply(job);
      $("#applyProgress").max = Math.max(1, Number(job.total) || 1);
      $("#applyProgress").value = Math.min(Number(job.total) || 1, Number(job.completed) || 0);
      $("#applyCurrentName").textContent = job.current || "";
      $("#applyProgressText").textContent = t("apply.progress", { completed: job.completed, total: job.total });
      $("#applyPauseButton").textContent = t(job.state === "paused" ? "apply.resume" : "apply.pause");
      if (job.state === "running") setStatusKey("status.applyProgress", { completed: job.completed, total: job.total, current: job.current }, "running");
    } else if (job.kind === "detect" && job.state === "error" && previous?.state !== "error") {
      state.detectCancelRequested = false;
      await finishDetectionJob(job);
      if (job.error) setStatus(job.error, "error");
      else setStatusKey("error.background", {}, "error");
  } else if (isTerminalDetection(job, previous)) {
    await finishDetectionJob(job);
      if (job.state === "cancelled") setStatusKey("status.detectCancelled", { completed: job.completed });
      else setStatusKey("status.detectDone");
    }
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) setStatusKey("error.connectionLost", {}, "error");
  }
  })();
  try { return await state.pollInFlight; }
  finally { state.pollInFlight = null; }
}

function setTool(tool) {
  if (isBusy() || state.importing) return;
  const focusedInBoundaryMenu = closeBoundaryModeMenu();
  const boundaryTools = new Set(["boundary", "polygon", "boundary_brush", "bucket"]);
  if (!boundaryTools.has(tool)) clearBoundaryInteraction();
  else if (state.tool !== tool) clearBoundaryConstruction();
  state.tool = tool;
  for (const [id, name] of [["#brushTool", "brush"], ["#eraserTool", "eraser"], ["#rectangleTool", "boundary"], ["#polygonTool", "polygon"], ["#boundaryBrushTool", "boundary_brush"], ["#bucketTool", "bucket"]]) {
    const active = tool === name; $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("#boundaryTool").classList.toggle("active", boundaryTools.has(tool));
  $("#boundaryTool").setAttribute("aria-pressed", String(boundaryTools.has(tool)));
  $("#bucketToleranceControl").hidden = tool !== "bucket";
  canvas.style.cursor = tool === "eraser" ? "cell" : "crosshair";
  if (boundaryTools.has(tool) && state.boundaryDrafts.length) setStatusKey("status.boundaryReady");
  updateBoundaryActions(); render();
  if (focusedInBoundaryMenu) focusCanvas();
}

function setBoundaryModeMenuOpen(open) {
  const menu = $("#boundaryModeMenu");
  menu.hidden = !open;
  $("#boundaryTool").setAttribute("aria-expanded", String(open));
}

function closeBoundaryModeMenu({ restoreFocus = false } = {}) {
  const menu = $("#boundaryModeMenu");
  const focusedInMenu = menu.contains?.(document.activeElement);
  setBoundaryModeMenuOpen(false);
  if (focusedInMenu && restoreFocus) focusElement($("#boundaryTool"));
  return Boolean(focusedInMenu);
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

function confirmAction(title, message, key = null) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  if (key && (newConfirmation.has(key) ? state.settings?.confirmations?.[key] !== true : state.settings?.confirmations?.[key] === false)) return Promise.resolve(true);
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  return new Promise((resolve) => {
    const finish = () => {
      const accepted = dialog.returnValue === "confirm";
      if (accepted && key && $("#confirmNeverShow").checked && state.settings) {
        state.settings.confirmations = { ...state.settings.confirmations, [key]: false };
        void api("/api/settings", { method: "POST", body: JSON.stringify(state.settings) }).catch(() => {});
      }
      $("#confirmNeverShow").checked = false; resolve(accepted);
    };
    dialog.addEventListener("close", finish, { once: true });
    dialog.showModal();
  });
}
function confirmationRequired(key) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  return newConfirmation.has(key) ? state.settings?.confirmations?.[key] === true : state.settings?.confirmations?.[key] !== false;
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
  if (!await confirmAction(t(titleKey), t(messageKey), "clearMasks")) return;
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
    renderCatalogViews(); updateNavigationControls(); clearStatus();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.masksClearing = false; updateActionButtons(); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"), "clearCatalog")) return;
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
    setStatusKey("status.chooseFolder");
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
  if (!await confirmAction(t("confirm.removeImage.title"), t("confirm.removeImage.message"), "removeImage")) return;

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
      if (state.images.length) clearStatus();
      else setStatusKey("status.chooseFolder");
    }
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

async function runSelectionAction(action) {
  const images = selectedImages(); if (!images.length || isBusy() || state.importing) return;
  const ids = images.map((image) => image.id);
  if (action === "hide" || action === "show") { images.forEach((image) => setHidden(image, action === "hide")); return; }
  if (action === "reviewed" || action === "unreviewed") { images.forEach((image) => setReviewed(image, action === "reviewed")); renderCatalogViews(); return; }
  if (action === "detect") return openDetectionDialog(ids);
  if (action === "clear") return clearMasks(ids, "confirm.clearAllMasks.title", "confirm.clearAllMasks.message");
  if (action === "remove") {
    for (const image of [...images]) await removeImageFromCatalog(image.id);
    state.selectedImageIds.clear(); updateSelectionActionBar();
  }
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
    session.total = supportedFiles.length; session.completed = 0; session.paused = false; session.cancelled = false;
    showProcessing({ kind: "import", state: "running", total: session.total, completed: 0, current: "" });
    const results = new Array(supportedFiles.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
        if (session.cancelled) return;
        const index = nextIndex; nextIndex += 1;
        if (index >= supportedFiles.length) return;
        const entry = supportedFiles[index]; const clientKey = newClientKey();
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
        const data = await importSingleFile(entry, clientKey);
        results[index] = { entry, clientKey, data };
        session.completed += 1;
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
      }
    };
    const workerCount = Math.min(supportedFiles.length, importParallelism());
    const workers = Array.from({ length: workerCount }, worker);
    try {
      await Promise.all(workers);
    } catch (error) {
      // Do not schedule more files after an upload failure.  Wait for the
      // in-flight requests so the server can discard their temporary files.
      session.cancelled = true;
      await Promise.allSettled(workers);
      throw error;
    }
    if (!isCurrentCatalogEpoch(session.epoch) || state.importSession !== session) return;
    const latest = await api("/api/images");
    state.images = latest.images;
    if (session.cancelled) {
      pruneSourceAccess(); renderCatalogViews();
      setStatusKey("status.importCancelled", { completed: session.completed });
      return;
    }
    for (const result of results) {
      if (!result) continue;
      for (const imported of result.data.imported || []) {
        if (imported.clientKey !== result.clientKey || !result.entry.fileHandle || !imported.imageId) continue;
        state.sourceAccess.set(imported.imageId, {
          fileHandle: result.entry.fileHandle, parentHandle: result.entry.parentHandle || null,
          name: result.entry.file.name, size: result.entry.file.size, lastModified: result.entry.file.lastModified,
        });
      }
    }
    pruneSourceAccess(); renderCatalogViews(); setStatusKey("gallery.imported", { count: supportedFiles.length });
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
  const session = { id: newClientKey(), epoch: beginCatalogEpoch(), paused: false, cancelled: false, completed: 0, total: 0 };
  state.importing = true; state.importSession = session;
  updateActionButtons();
  return session;
}

function finishImportSession(session) {
  if (state.importSession !== session) return;
  state.importSession = null; state.importing = false;
  closeProcessing();
  updateActionButtons();
}

async function waitForImportSession(session) {
  while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
  return !session.cancelled && state.importSession === session;
}

async function importHandleEntries(entries, session) {
  if (!entries.length) return finishImportSession(session);
  showProcessing({ kind: "import", state: "running", total: entries.length, completed: 0, current: "" });
  const files = new Array(entries.length);
  let nextIndex = 0;
  const worker = async () => {
    while (await waitForImportSession(session)) {
      const index = nextIndex; nextIndex += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      showProcessing({ kind: "import", state: session.paused ? "paused" : "running", total: entries.length, completed: 0, current: entry.relativePath });
      const file = await entry.handle.getFile();
      files[index] = droppedFile(file, entry.relativePath, entry.handle, entry.parentHandle || null);
    }
  };
  const parallelism = Math.min(entries.length, importParallelism());
  await Promise.all(Array.from({ length: parallelism }, worker));
  if (!await waitForImportSession(session)) return finishImportSession(session);
  await importFiles(files.filter(Boolean), session);
}

async function importFileHandles(handles, session = beginImportSession()) {
  if (!session) return;
  await importHandleEntries(handles.map((handle) => ({ handle, relativePath: handle.name, parentHandle: null })), session);
}

async function importDirectoryHandle(directoryHandle, session = beginImportSession()) {
  if (!session) return;
  const entries = [];
  showProcessing({ kind: "import", state: "running", total: 1, completed: 0, current: directoryHandle.name || "" });
  async function collect(handle, relativePath = "", parentHandle = null) {
    if (!await waitForImportSession(session)) return;
    const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
    if (handle.kind === "file") entries.push({ handle, relativePath: path, parentHandle });
    else for await (const child of handle.values()) await collect(child, path, handle);
  }
  for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
  if (!await waitForImportSession(session)) return finishImportSession(session);
  await importHandleEntries(entries, session);
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
  const binding = shortcutFromEvent(event);
  const shortcuts = state.settings?.shortcuts?.bindings || { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const enabled = state.settings?.shortcuts?.actions || {};
  if ((binding === shortcuts.undo && enabled.undo !== false) || (binding === shortcuts.redo && enabled.redo !== false)) {
    event.preventDefault();
    void restoreSnapshot(binding === shortcuts.redo ? state.historyIndex + 1 : state.historyIndex - 1);
    return true;
  }
  return false;
}

function navigationShortcutAction(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || isEditableTarget(document.activeElement) || hasOpenDialog()) return null;
  const binding = shortcutFromEvent(event);
  const bindings = state.settings?.shortcuts?.bindings || { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", nextUnreviewed: "Shift+ArrowRight", reviewAndNext: "Enter", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const actionForBinding = Object.entries(bindings).find(([, value]) => value === binding)?.[0];
  if (!actionForBinding || state.settings?.shortcuts?.actions?.[actionForBinding] === false) return null;
  if (actionForBinding === "toggleOverview") return "toggleOverview";
  if (state.viewMode !== "edit") return null;
  return actionForBinding;
}

function handleNavigationKeydown(event) {
  const action = navigationShortcutAction(event);
  if (!action) return false;
  event.preventDefault();
  if (action === "toggleOverview") setViewMode(state.viewMode === "overview" ? "edit" : "overview");
  else if (action === "previous") moveCurrentBy(-1);
  else if (action === "next") moveCurrentBy(1);
  else if (action === "previousVisible") moveCurrentBy(-1);
  else if (action === "nextVisible") moveCurrentBy(1);
  else if (action === "nextUnreviewed") moveToNextUnreviewed();
  else if (action === "first" && state.images[0]) void selectImage(state.images[0].id);
  else if (action === "last" && state.images.at(-1)) void selectImage(state.images.at(-1).id);
  else if (action === "reviewAndNext") reviewAndMoveNext();
  else if (action === "undo") void restoreSnapshot(state.historyIndex - 1);
  else if (action === "redo") void restoreSnapshot(state.historyIndex + 1);
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

function renderModelStatus() {
  const modelStatus = Object.entries(state.settingsStatus?.models || {});
  const activeModels = modelStatus.filter(([, model]) => model.required === true || model.enabled === true);
  $("#settingsModelStatus").textContent = activeModels.length && activeModels.every(([, model]) => model.valid)
    ? ""
    : activeModels.map(([key, model]) => model.configured && model.detail ? `${key}: ${model.detail}` : "").filter(Boolean).join("\n");
}

const MODEL_TOGGLE_IDS = { ntd11: "#settingsNtd11Toggle", sensitive: "#settingsSensitiveToggle", hand_detection: "#settingsHandToggle" };

function setModelCardEnabled(key, enabled) {
  const toggle = $(MODEL_TOGGLE_IDS[key]);
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

function modelCardEnabled(key) { return Boolean($(MODEL_TOGGLE_IDS[key]).checked); }

function setPrecisionDetectionEnabled(enabled) {
  const toggle = $("#settingsPrecisionToggle");
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

function setFluidExclusionEnabled(enabled) {
  const toggle = $("#settingsFluidToggle");
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

const TOOL_POSITIONS = new Set(["left", "top", "right", "bottom"]);

function normaliseToolPosition(position) { return TOOL_POSITIONS.has(position) ? position : "left"; }
function toolRailItems() { return ["#brushTool", "#eraserTool", "#boundaryTool", "#fitButton", "#undoButton", "#redoButton", "#mosaicPreviewButton"].map($); }

function setToolRailTabStop(activeItem = null) {
  const items = toolRailItems().filter((item) => !item.disabled);
  if (!items.length) return;
  const selected = items.includes(activeItem) ? activeItem : items.find((item) => item.tabIndex === 0) || items[0];
  items.forEach((item) => { item.tabIndex = item === selected ? 0 : -1; });
}

function applyToolPosition(position) {
  const nextPosition = normaliseToolPosition(position);
  closeBoundaryModeMenu();
  stage.dataset.toolPosition = nextPosition;
  toolRail.setAttribute("aria-orientation", ["left", "right"].includes(nextPosition) ? "vertical" : "horizontal");
  setToolRailTabStop(document.activeElement);
}

function handleToolRailKeydown(event) {
  if ($("#boundaryModeMenu").contains?.(event.target)) return;
  const items = toolRailItems().filter((item) => !item.disabled);
  const current = items.indexOf(event.target);
  if (current < 0) return;
  const vertical = toolRail.getAttribute("aria-orientation") === "vertical";
  let next = current;
  if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = (current + 1) % items.length;
  else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = (current - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  setToolRailTabStop(items[next]);
  focusElement(items[next]);
}

function setSettingsForm(settings, status = null) {
  state.settings = settings; state.settingsStatus = status;
  $("#settingsLanguage").value = settings.general.language;
  $("#settingsOpenBrowser").checked = settings.general.open_browser;
  $("#settingsPort").value = String(settings.general.port);
  $("#settingsImportParallelism").value = String(settings.importing?.parallelism || 3);
  $("#settingsSaveParallelism").value = String(settings.saving?.parallelism || 2);
  $("#settingsShortcutsEnabled").checked = settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled;
  renderOutputHandle();
  setNavigationShortcutsEnabled(settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled);
  $("#settingsTargetModel").value = settings.models.target_segmentation;
  $("#settingsNtd11Model").value = settings.models.ntd11;
  setModelCardEnabled("ntd11", settings.models.ntd11_enabled);
  $("#settingsSensitiveModel").value = settings.models.sensitive;
  setModelCardEnabled("sensitive", settings.models.sensitive_enabled);
  $("#settingsHandModel").value = settings.models.hand_detection;
  setModelCardEnabled("hand_detection", settings.models.hand_detection_enabled);
  $("#settingsSamModel").value = settings.models.sam_checkpoint;
  setPrecisionDetectionEnabled(settings.detection.mode === "high_precision");
  setFluidExclusionEnabled(settings.detection.fluid_exclusion_enabled);
  $("#settingsSamType").value = settings.models.sam_model_type;
  $("#settingsProvider").value = settings.models.provider;
  const gpuSelect = $("#settingsGpuDevice"); gpuSelect.textContent = "";
  const gpus = status?.gpus || [];
  if (!gpus.length) { const option = document.createElement("option"); option.value = "0"; option.textContent = "GPU 0"; gpuSelect.append(option); }
  else for (const gpu of gpus) { const option = document.createElement("option"); option.value = String(gpu.id); option.textContent = `GPU ${gpu.id}: ${gpu.name}`; gpuSelect.append(option); }
  gpuSelect.value = String(settings.models.gpu_device || 0);
  $("#settingsApplyColor").value = settings.display.apply_color;
  $("#settingsExcludeColor").value = settings.display.exclude_color;
  $("#settingsOpacity").value = settings.display.overlay_opacity;
  $("#settingsMosaicPreview").checked = settings.display.mosaic_preview;
  $("#settingsToolPosition").value = normaliseToolPosition(settings.display.tool_position);
  applyToolPosition(settings.display.tool_position);
  state.mosaicPreviewEnabled = settings.display.mosaic_preview;
  $("#mosaicPreviewButton").classList.toggle("active", state.mosaicPreviewEnabled);
  $("#mosaicPreviewButton").setAttribute("aria-pressed", String(state.mosaicPreviewEnabled));
  setDetectionConfidence(settings.detection.threshold);
  $("#detectParallelism").value = String(settings.detection.parallelism);
  setDetectionTargets(settings.detection.targets);
  $("#confirmClearMasks").checked = settings.confirmations?.clearMasks !== false;
  $("#confirmClearCatalog").checked = settings.confirmations?.clearCatalog !== false;
  $("#confirmRemoveImage").checked = settings.confirmations?.removeImage !== false;
  $("#confirmCandidateDelete").checked = settings.confirmations?.candidateDelete !== false;
  $("#confirmCandidateRoleDelete").checked = settings.confirmations?.candidateRoleDelete !== false;
  $("#confirmOverwriteSource").checked = settings.confirmations?.overwriteSource !== false;
  $("#confirmDeleteSourceAfterCopy").checked = settings.confirmations?.deleteSourceAfterCopy !== false;
  renderShortcutBindings(settings.shortcuts?.bindings || {}, settings.shortcuts?.actions || {});
  renderModelStatus();
}

const SHORTCUT_LABELS = { previous: "←", next: "→", previousVisible: "↑", nextVisible: "↓", first: "Home", last: "End", nextUnreviewed: "次へ", reviewAndNext: "確認済にして次へ", toggleOverview: "一覧切替", undo: "Undo", redo: "Redo" };
function renderShortcutBindings(bindings, actions) {
  const root = $("#shortcutBindings"); root.textContent = "";
  for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
    const row = document.createElement("label"); row.className = "form-row"; const text = document.createElement("span"); text.textContent = label;
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.dataset.shortcutEnabled = action; enabled.checked = actions[action] !== false;
    const input = document.createElement("input"); input.type = "text"; input.dataset.shortcutAction = action; input.value = bindings[action] || ""; input.autocomplete = "off";
    input.addEventListener("keydown", (event) => { event.preventDefault(); input.value = shortcutFromEvent(event); }); row.append(text, enabled, input); root.append(row);
  }
}
function shortcutFromEvent(event) { return `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${event.altKey ? "Alt+" : ""}${event.key.length === 1 ? event.key.toUpperCase() : event.key}`; }
function shortcutBindingsPayload() {
  const bindings = Object.fromEntries([...document.querySelectorAll("[data-shortcut-action]")].map((input) => [input.dataset.shortcutAction, input.value.trim()]));
  if (!Object.values(bindings).every(Boolean) || new Set(Object.values(bindings)).size !== Object.keys(bindings).length) throw new Error("ショートカットのキーは重複なく設定してください。");
  return bindings;
}
function shortcutActionsPayload() { return Object.fromEntries([...document.querySelectorAll("[data-shortcut-enabled]")].map((input) => [input.dataset.shortcutEnabled, input.checked])); }

function settingsPayload() {
  return {
    general: { ...state.settings.general, language: $("#settingsLanguage").value, open_browser: $("#settingsOpenBrowser").checked, port: Number($("#settingsPort").value), shortcuts_enabled: $("#settingsShortcutsEnabled").checked },
    models: {
      target_segmentation: $("#settingsTargetModel").value.trim(), ntd11: $("#settingsNtd11Model").value.trim(), ntd11_enabled: modelCardEnabled("ntd11"),
      sensitive: $("#settingsSensitiveModel").value.trim(), sensitive_enabled: modelCardEnabled("sensitive"),
      hand_detection: $("#settingsHandModel").value.trim(), hand_detection_enabled: modelCardEnabled("hand_detection"),
      sam_checkpoint: $("#settingsSamModel").value.trim(), sam_model_type: $("#settingsSamType").value, provider: $("#settingsProvider").value, gpu_device: Number($("#settingsGpuDevice").value),
    },
    display: {
      apply_color: $("#settingsApplyColor").value, exclude_color: $("#settingsExcludeColor").value,
      overlay_opacity: Number($("#settingsOpacity").value), mosaic_preview: $("#settingsMosaicPreview").checked,
      tool_position: $("#settingsToolPosition").value,
    },
    importing: { parallelism: normaliseImportParallelism($("#settingsImportParallelism").value) },
    detection: {
      threshold: normaliseDetectionConfidence($("#detectConfidenceNumber").value),
      parallelism: detectionParallelism(),
      mode: $("#settingsPrecisionToggle").checked ? "high_precision" : "standard",
      fluid_exclusion_enabled: $("#settingsFluidToggle").checked, targets: detectionTargets(),
    },
    saving: { parallelism: Math.min(8, Math.max(1, Math.round(Number($("#settingsSaveParallelism").value) || 2))) },
    shortcuts: { enabled: $("#settingsShortcutsEnabled").checked, bindings: shortcutBindingsPayload(), actions: shortcutActionsPayload() },
    confirmations: { clearMasks: $("#confirmClearMasks").checked, clearCatalog: $("#confirmClearCatalog").checked, removeImage: $("#confirmRemoveImage").checked, candidateDelete: $("#confirmCandidateDelete").checked, candidateRoleDelete: $("#confirmCandidateRoleDelete").checked, overwriteSource: $("#confirmOverwriteSource").checked, deleteSourceAfterCopy: $("#confirmDeleteSourceAfterCopy").checked },
  };
}

function selectSettingsTab(name) {
  document.querySelectorAll(".settings-tab").forEach((button) => {
    const active = button.dataset.settingsTab === name;
    button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
}

function moveSettingsTab(event) {
  const tabs = [...document.querySelectorAll(".settings-tab")];
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0) return;
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  selectSettingsTab(tabs[next].dataset.settingsTab);
  focusElement(tabs[next]);
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

async function chooseSettingsOutputDirectory() {
  try {
    await selectOutputDirectory();
  } catch (error) {
    if (error?.name !== "AbortError") { $("#settingsResult").textContent = error.message; $("#settingsResult").classList.add("error"); }
  }
}

async function checkForUpdate() {
  try {
    const update = await api("/api/update/status");
    $("#settingsVersion").textContent = update.current;
    const button = $("#checkUpdateButton"); button.textContent = update.available ? t("update.start") : t("update.check");
    button.classList.toggle("primary", update.available); button.dataset.available = String(update.available);
    $("#updateToast").hidden = !update.available;
  } catch { /* Offline update checks stay quiet. */ }
}

async function startUpdate() {
  if ($("#checkUpdateButton").dataset.available !== "true") return checkForUpdate();
  if (!await confirmAction(t("update.title"), t("update.message"))) return;
  try { await api("/api/update/start", { method: "POST", body: JSON.stringify({}) }); } catch (error) { $("#settingsResult").textContent = error.message; }
}

function openModelHelp(key) {
  $("#modelHelpTitle").textContent = t(`modelHelp.${key}.title`);
  $("#modelHelpText").textContent = t(`modelHelp.${key}.text`);
  $("#modelHelpDialog").showModal();
}

function bindEvents() {
  const lightDismiss = (dialog, close) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  $("#settingsButton").addEventListener("click", () => { void openSettings(); });
  $("#updateToast").addEventListener("click", () => { void openSettings().then(() => selectSettingsTab("info")); });
  $("#settingsCloseButton").addEventListener("click", () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#settingsDialog").close(); });
  lightDismiss($("#settingsDialog"), () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("close", () => {
    const language = state.settings?.general?.language || "ja";
    if (state.settings?.models && state.settings?.display && state.settings?.detection) {
      setSettingsForm(state.settings, state.settingsStatus);
    } else {
      $("#settingsLanguage").value = language;
    }
    void loadTranslations(language);
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#settingsResetButton").addEventListener("click", () => { void resetSettings(); });
  $("#settingsChooseOutputDirectory").addEventListener("click", () => { void chooseSettingsOutputDirectory(); });
  $("#checkUpdateButton").addEventListener("click", () => { void startUpdate(); });
  document.querySelectorAll("[data-model-help]").forEach((button) => button.addEventListener("click", () => openModelHelp(button.dataset.modelHelp)));
  $("#modelHelpCloseButton").addEventListener("click", () => $("#modelHelpDialog").close());
  $("#modelHelpDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#modelHelpDialog").close(); });
  lightDismiss($("#modelHelpDialog"), () => $("#modelHelpDialog").close());
  toolRail.addEventListener("keydown", handleToolRailKeydown);
  toolRailItems().forEach((item) => item.addEventListener("focus", () => setToolRailTabStop(item)));
  setToolRailTabStop();
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
    button.addEventListener("keydown", moveSettingsTab);
  });
  document.querySelectorAll("[data-model-toggle]").forEach((toggle) => {
    toggle.addEventListener("change", () => setModelCardEnabled(toggle.dataset.modelToggle, toggle.checked));
  });
  $("#settingsPrecisionToggle").addEventListener("change", () => setPrecisionDetectionEnabled($("#settingsPrecisionToggle").checked));
  $("#settingsFluidToggle").addEventListener("change", () => setFluidExclusionEnabled($("#settingsFluidToggle").checked));
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
    else openDetectionDialog(state.images.filter((image) => !isHidden(image)).map((image) => image.id));
  };
  $("#detectAllButton").addEventListener("click", detectAll);
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId], detectionConfidence(), 1));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#removeCurrentImageButton").addEventListener("click", () => setHidden(currentRecord(), true));
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"); });
  $("#clearCatalogButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearCatalog(); });
  for (const [menuId, buttonId] of [["#batchMoreMenu", "#batchMoreButton"]]) {
    $(menuId).addEventListener("toggle", () => $(buttonId).setAttribute("aria-expanded", String($(menuId).matches(":popover-open"))));
  }
  $("#galleryFilter").addEventListener("change", (event) => { if (isBusy() || state.importing) return; state.galleryFilter = event.currentTarget.value; renderGallery(); });
  $("#overviewButton").addEventListener("click", () => { if (!isBusy() && !state.importing) setViewMode("overview"); });
  $("#closeOverviewButton").addEventListener("click", () => setViewMode("edit"));
  $("#previousImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(-1)));
  $("#nextImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(1)));
  $("#nextUnreviewedButton").addEventListener("click", () => runNavigationAction(moveToNextUnreviewed));
  $("#reviewAndNextButton").addEventListener("click", () => runNavigationAction(reviewAndMoveNext));
  $("#removeAndNextButton").addEventListener("click", () => { void removeImageFromCatalog(state.currentId); });
  $("#hideAndNextButton").addEventListener("click", () => { void hideAndMoveNext(); });
  document.querySelectorAll("[data-selection-action]").forEach((button) => button.addEventListener("click", () => { void runSelectionAction(button.dataset.selectionAction); }));
  $("#selectionClearButton").addEventListener("click", () => { state.selectedImageIds.clear(); state.selectionAnchorId = null; state.batchMode = false; renderCatalogViews(); updateSelectionActionBar(); });
  $("#batchModeButton").addEventListener("click", () => { state.batchMode = !state.batchMode; if (!state.batchMode && state.selectedImageIds.size < 2) state.selectedImageIds.clear(); renderCatalogViews(); updateSelectionActionBar(); });
  document.querySelectorAll("[data-candidate-batch]").forEach((button) => button.addEventListener("click", () => { void batchCandidateOperation(button.dataset.candidateBatch); }));
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
    setBoundaryModeMenuOpen($("#boundaryModeMenu").hidden);
  });
  $("#bucketTool").addEventListener("click", () => setTool("bucket"));
  $("#rectangleTool").addEventListener("click", () => setTool("boundary"));
  $("#polygonTool").addEventListener("click", () => setTool("polygon"));
  $("#boundaryBrushTool").addEventListener("click", () => setTool("boundary_brush"));
  $("#boundaryDetectButton").addEventListener("click", () => {
    if (!canDetectBoundary()) return;
    void addBoundaryCandidate();
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
  lightDismiss($("#detectDialog"), () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; });
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
  lightDismiss($("#applyDialog"), () => { if (!state.applyRunning) $("#applyDialog").close(); });
  $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#confirmDialog").close("cancel"); });
  lightDismiss($("#confirmDialog"), () => $("#confirmDialog").close("cancel"));
  $("#processingDialog").addEventListener("cancel", (event) => event.preventDefault());
  $("#processingPauseButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing) return;
    if (processing.kind === "import") {
      const session = state.importSession; if (!session) return;
      session.paused = !session.paused;
      showProcessing({ ...processing, state: session.paused ? "paused" : "running" });
      return;
    }
    try { await api(`/api/job/${processing.state === "paused" ? "resume" : "pause"}`, { method: "POST", body: JSON.stringify({}) }); }
    catch (error) { setStatus(error.message, "error"); }
  });
  $("#processingCancelButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing) return;
    if (processing.kind === "import") { if (state.importSession) state.importSession.cancelled = true; return; }
    await cancelDetection();
  });
  $("#toggleReviewMenuItem").addEventListener("click", () => {
    const image = state.images.find((item) => item.id === state.contextMenuImageId);
    if (image) setReviewed(image, !isReviewed(image));
    closeCatalogContextMenu();
  });
  $("#removeImageMenuItem").addEventListener("click", () => { setHidden(state.images.find((image) => image.id === state.contextMenuImageId), true); closeCatalogContextMenu(); });
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
        const completedVertex = completedPolygonVertexAt(point);
        if (completedVertex) {
          state.polygonDraftDrag = { id: completedVertex.draft.id, index: completedVertex.index };
        } else if (state.polygonPoints.length < 4) {
          state.polygonPoints.push(point);
          if (state.polygonPoints.length === 4 && polygonIsValid()) {
            addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
            state.polygonPoints = [];
            setStatusKey("status.boundaryReady");
          }
        }
        state.drawing = false;
      }
      updateBoundaryActions(); render(); return;
    }
    if (state.tool === "boundary_brush") { beginBoundaryBrushStroke(point); render(); return; }
    if (state.tool === "bucket") { state.drawing = false; fillAt(point); return; }
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
      } else if (state.tool === "polygon" && state.polygonDraftDrag) {
        const draft = state.boundaryDrafts.find((item) => item.id === state.polygonDraftDrag.id);
        if (draft) {
          draft.points[state.polygonDraftDrag.index] = point;
          draft.roi = polygonRoi(draft.points);
          state.boundaryActiveId = draft.id;
        }
      } else if (state.tool === "boundary_brush") {
        appendBoundaryBrushPoint(point);
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
    if (state.tool === "polygon") {
      if (state.polygonPoints.length === 4 && polygonIsValid()) {
        addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
        state.polygonPoints = [];
        setStatusKey("status.boundaryReady");
      }
      state.polygonDragIndex = -1; state.polygonDraftDrag = null; updateBoundaryActions(); render(); return;
    }
    const boundaryStart = state.boundaryStart;
    const boundaryDragging = state.boundaryDragging;
    state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false;
    canvas.style.cursor = state.tool === "eraser" ? "cell" : "crosshair";
    if (wasDrawing && manualStrokeStarted) completeManualStroke();
    if (!cancelled && wasDrawing && state.tool === "boundary_brush") completeBoundaryBrushStroke();
    if (cancelled && state.tool === "boundary_brush") state.boundaryBrushStroke = null;
    if (!cancelled && wasDrawing && boundaryStarted && !isBusy() && !state.importing && event?.button === 0) {
      const point = clampPoint(pointFromEvent(event));
      const roi = roiFromPoints(boundaryStart, point);
      if (boundaryDragging && roi) {
        addBoundaryDraft({ type: "rectangle", roi, point: pointForRoi(roi) });
        state.boundaryRoi = null;
        setStatusKey("status.boundaryReady");
      } else {
        const draft = rectangleDraftAt(point);
        if (draft) {
          draft.point = point;
          state.boundaryActiveId = draft.id;
          setStatusKey("status.boundaryReady");
        }
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
    if (event.shiftKey) {
      const current = Number($("#brushSize").value); const direction = event.deltaY < 0 ? 1 : -1;
      return updateBrushSize(Math.max(1, current + direction * Math.max(1, Math.round(current * 0.1))));
    }
    const rect = canvas.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
    const sourceX = (mouseX - state.view.x) / state.view.scale; const sourceY = (mouseY - state.view.y) / state.view.scale;
    state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    state.view.x = mouseX - sourceX * state.view.scale; state.view.y = mouseY - sourceY * state.view.scale; render();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#boundaryModeMenu").hidden) {
      event.preventDefault(); closeBoundaryModeMenu(); focusElement($("#boundaryTool")); return;
    }
    if (hasBoundaryDraft()) {
      if (event.key === "Escape") { event.preventDefault(); cancelBoundary(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        if (canDetectBoundary()) void addBoundaryCandidate();
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
    const boundaryMenu = $("#boundaryModeMenu");
    if (!boundaryMenu.hidden && event.target !== $("#boundaryTool") && !boundaryMenu.contains?.(event.target)) closeBoundaryModeMenu();
    const menu = $("#catalogContextMenu");
    if (!menu.matches?.(":popover-open") || menu.contains(event.target)) return;
    closeCatalogContextMenu();
  });
  window.addEventListener("storage", handleReviewStorageEvent);
}

async function initialise() {
  try {
    const settings = await api("/api/settings");
    setSettingsForm(settings.settings, settings.status);
  } catch { /* The defaults below keep the editor usable when settings are unavailable. */ }
  await loadTranslations(); bindEvents();
  await restoreOutputDirectory();
  setNavigationShortcutsEnabled(state.settings?.general?.shortcuts_enabled ?? true);
  new ResizeObserver(resizeRenderCanvas).observe(stage); setInterval(pollJob, 700);
  setInterval(() => { if (state.blinkCandidateIds.size) render(); }, 160);
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons();
  try {
    const data = await api("/api/images");
    if (data.images.length) {
      $("#folderPath").value = data.root || "";
      resetCatalog(data.images, data.root);
      setStatusKey("status.imagesLoaded", { count: state.images.length });
    }
  } catch (error) { setStatus(error.message, "error"); }
  if (document.visibilityState === "visible") setTimeout(() => { void checkForUpdate(); }, 1000);
}

initialise();
