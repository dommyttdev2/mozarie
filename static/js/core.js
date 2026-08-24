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
  polygonPoints: [], polygonDragIndex: -1, polygonDraftDrag: null, blinkCandidateIds: new Set(), blinkModes: new Map(),
  pointer: null, hover: null, history: [], historyIndex: 0, activeStroke: null, removedCandidateIds: new Set(),
  view: { scale: 1, x: 0, y: 0 }, job: null, saving: false, saveStarting: false, detectionStarting: false, masksClearing: false,
  catalogMutation: false, imageGeneration: 0, catalogEpoch: 0, viewGeneration: 0, historyRestoreToken: 0, translations: {},
  applyTargetIds: [], applyTargetMode: "masked", applyCatalogSnapshot: null, applyRunning: false, applyFinishing: false, handledApplyStartedAt: null, importing: false, mosaicPreviewEnabled: true, mosaicPreviewGeneration: 0, mosaicWorker: null,
  outputDirectoryPicking: false,
  detectionTargetIds: [], pendingDetectionTargetIds: [], detectCancelRequested: false,
  pageLoadedAt: Date.now() / 1000, handledDetectionStartedAt: null, importSession: null,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(), candidateBatchPending: new Set(),
  manualMaskPresent: false, manualEnabled: true, manualExclusionEnabled: true, manualExclusionForced: true, manualExclusionEraseEnabled: true,
  galleryNodes: new Map(), overviewNodes: new Map(), contextMenuImageId: null, contextMenuOrigin: null, browserSave: null, pollInFlight: null, pollFailures: 0,
  // Browser file handles never leave this tab. They make imported images real save targets.
  sourceAccess: new Map(),
  processing: null, imageInflight: new Map(), candidateInflight: new Map(), loadingDelay: null, pendingImageKey: null, pendingCandidateKey: null,
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
const exclusionEraseCanvas = document.createElement("canvas");
const effectiveExclusionCanvas = document.createElement("canvas");
const combinedCanvas = document.createElement("canvas");
const mosaicCanvas = document.createElement("canvas");
const mosaicSourceCanvas = document.createElement("canvas");
const originalCanvas = document.createElement("canvas");
const historyAddCanvas = document.createElement("canvas");
const historyExclusionCanvas = document.createElement("canvas");
const historyExclusionEraseCanvas = document.createElement("canvas");
const layerCanvas = document.createElement("canvas");
const boundaryOverlayCanvas = document.createElement("canvas");
const blinkCanvas = document.createElement("canvas");
const addCtx = addCanvas.getContext("2d");
const exclusionCtx = exclusionCanvas.getContext("2d");
const exclusionEraseCtx = exclusionEraseCanvas.getContext("2d");
const effectiveExclusionCtx = effectiveExclusionCanvas.getContext("2d");
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
        error.code = data.error_code || "";
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

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const remainder = total % 60;
  if (hours) return `${t("duration.hour", { count: hours })} ${t("duration.minute", { count: minutes })}`;
  if (minutes) return `${t("duration.minute", { count: minutes })} ${t("duration.second", { count: remainder })}`;
  return t("duration.second", { count: remainder });
}

function progressText(job) {
  const count = t("status.progressCount", { completed: job.completed || 0, total: job.total || 0 });
  if (job.kind !== "detect" || job.state !== "running" || !job.completed || job.completed >= job.total) return count;
  const key = `${job.kind}:${job.startedAt || ""}`;
  const eta = state.detectionEta;
  if (!eta || eta.key !== key || Number(job.completed) > eta.completed) {
    state.detectionEta = {
      key,
      completed: Number(job.completed),
      remaining: (Number(job.activeElapsed) / Number(job.completed)) * (Number(job.total) - Number(job.completed)),
    };
  }
  return `${count} · ${t("status.eta", { duration: formatDuration(state.detectionEta.remaining) })}`;
}

function processingCurrentPath(job) {
  if (job?.kind !== "detect") return job?.current || "";
  const imageIds = Array.isArray(job.imageIds) && job.imageIds.length ? job.imageIds : state.detectionTargetIds;
  const completedIds = new Set(Array.isArray(job.completedImageIds) ? job.completedImageIds : []);
  const targetIds = new Set(imageIds);
  if (![...targetIds].some((imageId) => !completedIds.has(imageId))) return "";
  const nextImage = state.images.find((image) => targetIds.has(image.id) && !completedIds.has(image.id));
  return nextImage ? (nextImage.relativePath || "") : (job.current || "");
}

function showProcessing(processing) {
  state.processing = { ...state.processing, ...processing };
  const current = state.processing;
  const modal = $("#processingDialog");
  $("#processingTitle").textContent = processingTitle(current.kind);
  $("#processingCurrent").textContent = processingCurrentPath(current);
  $("#processingProgress").max = Math.max(1, Number(current.total) || 1);
  $("#processingProgress").value = Math.min($("#processingProgress").max, Number(current.completed) || 0);
  $("#processingProgressText").textContent = progressText(current);
  const cancelling = Boolean(state.detectCancelRequested || state.importSession?.cancelled);
  $("#processingPauseButton").textContent = t(current.state === "paused" ? "apply.resume" : "apply.pause");
  $("#processingPauseButton").disabled = current.state === "pausing" || cancelling;
  $("#processingCancelButton").disabled = cancelling;
  if (!modal.open) modal.showModal();
}

function closeProcessing() {
  state.processing = null;
  state.detectionEta = null;
  for (const id of ["#processingPauseButton", "#processingCancelButton"]) {
    const control = $(id); control.disabled = false; delete control.dataset.disabledByLock;
  }
  const modal = $("#processingDialog");
  if (modal.open) modal.close();
  updateActionButtons();
}

function renderStatus() {
  const status = state.status;
  const message = status ? (status.key ? t(status.key, status.params) : status.message) : "";
  const headerStatus = $("#connectionStatus");
  headerStatus.textContent = message;
  headerStatus.className = `appbar-status ${status?.kind || ""}`;
  const isError = status?.kind === "error";
  headerStatus.setAttribute("role", isError ? "alert" : "status");
  headerStatus.setAttribute("aria-live", isError ? "assertive" : "polite");
  headerStatus.hidden = !message;
}

function renderLocalizedDynamicState() {
  const record = currentRecord();
  $("#currentFileName").textContent = record && state.currentImage
    ? record.relativePath
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
    || state.processing?.kind === "detect"
    || state.catalogMutation || state.boundaryPending || state.fillPending;
}
function beginCatalogEpoch() { state.catalogEpoch += 1; return state.catalogEpoch; }
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
function saveTargets(mode = "masked") {
  if (mode === "current") return state.currentId && imageHasMask(currentRecord()) ? [state.currentId] : [];
  return state.images.filter((image) => !isHidden(image) && imageHasMask(image) && (mode !== "reviewed" || isReviewed(image))).map((image) => image.id);
}
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
function clearBatchSelection() { state.selectedImageIds.clear(); state.selectionAnchorId = null; }
function updateSelectionActionBar() {
  const count = state.selectedImageIds.size;
  $("#batchModeButton").setAttribute("aria-pressed", String(state.batchMode));
  $("#overviewSelectionBar").hidden = !state.batchMode;
  $("#selectionCount").textContent = t("selection.count", { count });
  $("#selectionActionsButton").disabled = count === 0;
}
function selectCatalogImage(imageId) {
  if (!state.images.some((image) => image.id === imageId)) return;
  clearBatchSelection();
  updateSelectionActionBar();
  void selectImage(imageId);
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
    const data = await api("/api/settings?status=0", { method: "POST", body: JSON.stringify(payload) });
    setSettingsForm(data.settings, state.settingsStatus);
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
  const switchingImages = state.candidateBatchPending.size > 0;
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
  detectAllButton.textContent = t("gallery.detectAll");
  detectAllButton.disabled = running || state.images.length === 0;
  $("#detectCurrentButton").disabled = running || !hasImage;
  $("#clearCurrentMasksButton").disabled = running || !hasImage || !(current.candidateCount || state.manualMaskPresent || imageHasMask(current));
  $("#removeCurrentImageButton").disabled = running || !hasImage;
  for (const id of ["#clearAllMasksButton", "#clearCatalogButton", "#batchMoreButton"]) $(id).disabled = running || state.images.length === 0;
  $("#batchModeButton").disabled = locked || state.images.length === 0;
  $("#galleryFilter").disabled = running;
  $("#saveAllButton").disabled = running || mutatingCandidates || saveTargets().length === 0;
  const currentSaveDisabled = running || mutatingCandidates || !hasImage || !imageHasMask(current);
  $("#saveButton").disabled = currentSaveDisabled;
  $("#applyStartButton").disabled = running || mutatingCandidates || Boolean(applyRestrictionMessage());
  $("#overviewButton").disabled = running || state.images.length === 0;
  $("#previousImageButton").disabled = running || switchingImages || imageIndex() <= 0;
  $("#nextImageButton").disabled = running || switchingImages || imageIndex() < 0 || imageIndex() >= state.images.length - 1;
  $("#reviewAndNextButton").disabled = running || switchingImages || !hasImage;
  $("#removeAndNextButton").disabled = running || switchingImages || !hasImage;
  $("#hideAndNextButton").disabled = running || switchingImages || !hasImage;
  updateCandidateBatchButtons(hasImage, locked);
  updateHistoryButtons();
  if (locked) for (const control of controls) {
    if (["applyPauseButton", "applyCancelButton"].includes(control.id) && state.applyRunning) continue;
    if (["processingPauseButton", "processingCancelButton"].includes(control.id) && state.processing) continue;
    if (control.id === "selectionClearButton" && state.batchMode) continue;
    if (!control.disabled) control.dataset.disabledByLock = "true";
    control.disabled = true;
  }
  $("#gallery").classList.toggle("locked", locked);
  canvas.style.pointerEvents = locked ? "none" : "";
  canvas.setAttribute("aria-disabled", String(locked));
}

function updateCandidateBatchButtons(hasImage = Boolean(state.currentId && state.currentImage && currentRecord()), locked = isBusy() || state.importing || state.candidateBatchPending.has(state.currentId), hasManualExclude = false) {
  for (const button of document.querySelectorAll("[data-candidate-batch]")) {
    const [role, operation] = button.dataset.candidateBatch.split(":");
    const hasRoleCandidate = hasImage && (state.candidates.some((candidate) => candidate.role === role) || (role === "apply" ? state.manualMaskPresent : hasManualExclude));
    button.disabled = locked || !hasRoleCandidate;
    if (operation === "toggle") {
      const enabled = state.candidates.filter((candidate) => candidate.role === role).map((candidate) => candidate.enabled);
      if (role === "apply" ? state.manualMaskPresent : canvasHasPixels(exclusionCtx, exclusionCanvas)) enabled.push(role === "apply" ? state.manualEnabled : state.manualExclusionEnabled);
      if (role === "exclude" && canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas)) enabled.push(state.manualExclusionEraseEnabled);
      const active = enabled.length > 0 && enabled.every(Boolean);
      button.textContent = t(active ? "settings.on" : "settings.off");
      button.setAttribute("aria-pressed", String(active));
    }
    if (operation === "blink") {
      const ids = state.candidates.filter((candidate) => candidate.role === role).map((candidate) => candidate.id);
      if (role === "apply" && state.manualMaskPresent) ids.push("manual:apply");
      if (role === "exclude" && canvasHasPixels(exclusionCtx, exclusionCanvas)) ids.push("manual:exclude");
      if (role === "exclude" && canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas)) ids.push("manual:excludeErase");
      const active = ids.length > 0 && ids.every((id) => state.blinkCandidateIds.has(id));
      button.textContent = t("candidates.blinkState", { state: t(active ? "settings.on" : "settings.off") });
      button.setAttribute("aria-pressed", String(active));
    }
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
  closeCatalogContextMenu();
  abortCatalogLoads();
  cancelFillWork();
  releaseImageCaches();
  state.images = images;
  state.sourceAccess.clear();
  state.reviewRoot = normaliseReviewRoot(root);
  state.overviewFolder = "";
  loadReviewedPaths();
  state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null; state.maskStatus.clear();
  state.candidates = []; state.candidateImages = new Map(); state.drafts.clear(); state.selectedImageIds.clear(); state.selectionAnchorId = null; state.batchMode = false; state.blinkCandidateIds.clear(); state.contextMenuImageId = null; state.contextMenuOrigin = null; clearBoundaryInteraction();
  state.candidateUpdateChains.clear(); state.candidateUpdateVersions.clear(); state.candidateDeleting.clear(); state.candidateBatchPending.clear();
  discardCatalogNodes(state.galleryNodes, $("#gallery"));
  discardCatalogNodes(state.overviewNodes, $("#overviewGrid"));
  renderCatalogViews(); updateSelectionActionBar(); clearEditor();
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
