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
  settings: null, settingsStatus: null, jobPollTimer: null,
  imageCache: null, candidateBundleCache: null, catalogLoadControllers: new Set(),
  prefetchQueue: [], prefetchActive: 0, prefetchTimer: null,
  fillWorker: null, fillPending: false,
  renderFrame: 0,
  maskDirty: false,
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
  $("#processingPauseButton").disabled = current.state === "pausing";
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
function activeDetection() { return state.job?.kind === "detect" && ["running", "pausing", "paused"].includes(state.job?.state); }
function normaliseDivisor(value) { return Math.max(1, Math.min(10000, Math.round(Number(value) || 100))); }
function mosaicDivisor() { return normaliseDivisor($("#divisor").value); }
function calculatedBlockSize(image = currentRecord(), divisor = mosaicDivisor()) {
  return image ? Math.max(4, Math.ceil(Math.max(image.width, image.height) / divisor)) : 0;
}
function isBusy() {
  return ["running", "pausing", "paused"].includes(state.job?.state)
    || state.saving || state.saveStarting || state.detectionStarting || state.masksClearing
    || state.catalogMutation || state.boundaryPending;
}
function beginCatalogEpoch() { state.catalogGeneration += 1; state.catalogEpoch += 1; return state.catalogEpoch; }
function isCurrentCatalogEpoch(epoch) { return state.catalogEpoch === epoch; }
function catalogRecordMatches(record, epoch, { version = imageAssetVersion(record), revision = null } = {}) {
  const current = state.images.find((image) => image.id === record?.id);
  return Boolean(record) && isCurrentCatalogEpoch(epoch) && current === record && imageAssetVersion(current) === version
    && (revision == null || Number(current.candidateRevision || 0) === Number(revision));
}
function abortCatalogLoads() {
  for (const controller of state.catalogLoadControllers) controller.abort();
  state.catalogLoadControllers.clear();
  state.imageInflight.clear(); state.candidateInflight.clear(); state.prefetchQueue = [];
  clearTimeout(state.prefetchTimer); state.prefetchTimer = null;
}
function cancelFillWork() { state.fillWorker?.terminate?.(); state.fillWorker = null; state.fillPending = false; }
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
function clearStoredCatalogState(root = state.reviewRoot) {
  const prefix = root ? `mozarie.reviewed.v1:${root}:` : "";
  if (!prefix) return;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index); if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* Storage is an optional convenience. */ }
  state.reviewedPaths.clear(); state.hiddenPaths.clear();
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
  if (!prefix) return;
  if (event.key === null) { loadReviewedPaths(); refreshReviewViews(); return; }
  if (!event.key.startsWith(prefix)) return;
  const rawPath = event.key.slice(prefix.length);
  const hidden = rawPath.startsWith("hidden:");
  const path = hidden ? rawPath.slice("hidden:".length) : rawPath;
  if (!path) return;
  const paths = hidden ? state.hiddenPaths : state.reviewedPaths;
  if (event.newValue === "true") paths.add(path); else paths.delete(path);
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
  abortCatalogLoads();
  releaseImageCaches();
  state.images = images;
  state.sourceAccess.clear();
  state.reviewRoot = normaliseReviewRoot(root);
  state.overviewFolder = "";
  loadReviewedPaths();
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.maskStatus.clear();
  state.candidates = []; state.candidateImages.clear(); state.drafts.clear(); state.selectedImageIds.clear(); state.selectionAnchorId = null; state.batchMode = false; state.blinkCandidateIds.clear(); state.contextMenuImageId = null; state.contextMenuOrigin = null; clearBoundaryInteraction();
  state.candidateUpdateVersions.clear(); state.candidateDeleting.clear();
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
  renderCatalogViews(); clearEditor();
}

function discardCatalogNodes(nodes, container) {
  for (const item of nodes.values()) {
    const preview = item.querySelector?.("img");
    if (preview) forgetThumbnail(preview);
    item.remove?.();
  }
  nodes.clear();
}

function updateProgress(job) {
  if (job?.kind !== "apply" && ["running", "pausing", "paused"].includes(job?.state)) showProcessing(job);
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
