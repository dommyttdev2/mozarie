const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const listeners = new Map();
  return {
    disabled: false, textContent: "", className: "", hidden: false, value: "", style: {}, dataset: {}, attributes: {},
    classList: { toggle() {} }, append() {}, appendChild() {}, addEventListener(type, listener) { listeners.set(type, listener); }, setAttribute(name, value) { this.attributes[name] = value; }, showModal() { this.open = true; }, close() { this.open = false; }, hidePopover() { this.hidePopoverCalls = (this.hidePopoverCalls || 0) + 1; }, focus(options) { document.activeElement = this; this.focusOptions = options; }, click() { this.clickCalls = (this.clickCalls || 0) + 1; this.focus(); listeners.get("click")?.({ currentTarget: this, target: this }); }, dispatch(type, event = {}) { listeners.get(type)?.({ currentTarget: this, target: this, ...event }); }, scrollIntoView() {},
  };
}

function galleryItem() {
  const preview = element();
  const badge = element();
  const name = element();
  const meta = element();
  return {
    ...element(),
    meta,
    querySelector(selector) {
      return { img: preview, ".gallery-review-badge": badge, ".gallery-name": name, ".gallery-meta": meta }[selector];
    },
  };
}

function overviewItem() {
  const preview = element();
  const name = element();
  const itemPath = element();
  const state = element();
  return {
    ...element(),
    querySelector(selector) {
      return { img: preview, ".overview-item-name": name, ".overview-item-path": itemPath, ".overview-item-state": state }[selector];
    },
  };
}

const elements = new Map();
for (const id of [
  "editorCanvas", "canvasStage", "detectAllButton", "detectCurrentButton", "clearCurrentMasksButton", "clearAllMasksButton", "clearCatalogButton", "saveAllButton", "saveButton", "galleryAllTab", "galleryMaskedTab", "pickFolder", "pickImages", "pickFolderFiles", "pickerMenu", "importImagesInput", "importFolderInput", "mosaicPreviewButton", "loadFolder", "folderPath", "brushTool", "eraserTool", "boundaryTool", "fitButton", "undoButton", "redoButton", "brushSize", "confidence", "confidenceValue", "detectDialog", "detectForm", "detectTargetCount", "detectConfidenceRange", "detectConfidenceNumber", "detectCancelButton", "detectStartButton",
  "overviewButton", "previousImageButton", "nextImageButton", "nextUnreviewedButton", "reviewAndNextButton", "navigationShortcutsEnabled", "imagePosition", "reviewStatus", "closeOverviewButton", "overviewPane", "overviewGrid", "overviewCount", "overviewQuery", "overviewFolder", "confirmDialog",
  "status", "jobProgress", "jobProgressText", "gallery", "imageCount", "candidateList", "candidateStatus", "divisor", "blockSizeValue",
  "applyTargetCount", "applyBlockSize", "applyDivisor", "applyProgressPanel", "applyStartButton", "applyCloseButton", "applyPauseButton", "applyCancelButton", "applySettings", "applyResult", "applySuffix", "deleteOriginal", "deleteOriginalRow", "applyDialog", "applyCopyMode", "applyOverwriteMode", "applyOverwriteRow", "applyTemporarySourceNote",
]) {
  const value = element();
  value.id = id;
  elements.set(`#${id}`, value);
}
elements.get("#applySuffix").value = "_censored";
elements.get("#applyDivisor").value = "100";
elements.get("#divisor").value = "100";
const gallery = elements.get("#gallery");
gallery.children = [];
let galleryAppendCount = 0;
gallery.append = function append(child) { galleryAppendCount += 1; this.children.push(child); };
Object.defineProperty(gallery, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
const overviewGrid = elements.get("#overviewGrid");
overviewGrid.children = [];
overviewGrid.append = function append(child) { this.children.push(child); };
Object.defineProperty(overviewGrid, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
elements.get("#editorCanvas").getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, stroke() {}, setLineDash() {} });
elements.get("#canvasStage").clientWidth = 600;
elements.get("#canvasStage").clientHeight = 400;
elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });
elements.set("#overviewItemTemplate", { content: { firstElementChild: { cloneNode: overviewItem } } });

const document = {
  addEventListener() {},
  querySelector: (selector) => selector === 'input[name="saveMode"]:checked'
    ? { value: elements.get("#applyOverwriteMode").checked ? "overwrite" : "copy" }
    : (elements.get(selector) || element()),
  querySelectorAll: (selector) => {
    if (selector === "button, input, select, textarea") return [...elements.values()].filter((item) => item.id);
    if (selector === "dialog") return [elements.get("#confirmDialog"), elements.get("#applyDialog"), elements.get("#detectDialog")];
    return [];
  },
  createElement: (tag) => tag === "canvas" ? {
    width: 1, height: 1,
    getContext: () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, getImageData() { return { data: new Uint8ClampedArray(combinedMaskPresent ? [255] : [0]) }; } }),
    toDataURL: () => "data:image/png;base64,test",
  } : element(),
};
document.activeElement = null;
let combinedMaskPresent = false;
let resolveFetch;
let fetchCalls = 0;
const requests = [];
const storage = new Map();
let storageWrites = 0;
const windowListeners = new Map();
const context = {
  console, document, Date, Math, Promise, window: { devicePixelRatio: 1, addEventListener(type, listener) { windowListeners.set(type, listener); } }, setInterval() {}, setTimeout(callback) { callback(); return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); }, ResizeObserver: class { observe() {} },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storageWrites += 1; storage.set(key, value); },
    removeItem(key) { storageWrites += 1; storage.delete(key); },
  },
  Image: class { set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); } },
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch: (path, options) => { fetchCalls += 1; requests.push({ path, options }); return new Promise((resolve) => { resolveFetch = resolve; }); },
};

let source = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
assert.doesNotMatch(source, /setInterval\(\s*render\s*,/);
source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__mosaicTest = { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, loadCandidateBundle, selectImage, updateCandidate, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, applyTargetsContainSessionImage, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence };\n");
vm.runInNewContext(source, context, { filename: "static/app.js" });
const { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, loadCandidateBundle, selectImage, updateCandidate, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, applyTargetsContainSessionImage, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence } = context.__mosaicTest;
bindEvents();

function keyEvent(key, options = {}) {
  return { key, code: options.code || key, shiftKey: Boolean(options.shiftKey), ctrlKey: Boolean(options.ctrlKey), metaKey: Boolean(options.metaKey), altKey: Boolean(options.altKey), prevented: false, preventDefault() { this.prevented = true; } };
}

(async () => {
  const initialiseRun = initialise();
  resolveFetch({ ok: true, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  const initialImage = { id: "initial", relativePath: "initial.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  resolveFetch({ ok: true, json: async () => ({ images: [initialImage], root: "G:/images/initial" }) });
  await initialiseRun;
  assert.equal(requests.at(-1).path, "/api/images");
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [initialImage]);
  assert.equal(state.reviewRoot, "g:\\images\\initial");
  assert.notEqual(elements.get("#status").className, "status error");

  const loadedImage = { id: "loaded", relativePath: "loaded.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  elements.get("#folderPath").value = "G:/images/loaded";
  state.currentId = "initial";
  state.currentImage = { width: 100, height: 80 };
  state.maskStatus.set("initial", true);
  const folderLoad = loadFolder();
  resolveFetch({ ok: true, json: async () => ({ images: [loadedImage] }) });
  await folderLoad;
  assert.equal(requests.at(-1).path, "/api/folder");
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [loadedImage]);
  assert.equal(state.reviewRoot, "g:\\images\\loaded");
  assert.equal(state.currentId, null);
  assert.equal(state.maskStatus.size, 0);

  elements.get("#pickImages").click();
  assert.equal(elements.get("#pickerMenu").hidePopoverCalls, 1);
  assert.equal(elements.get("#importImagesInput").clickCalls, 1);
  elements.get("#pickFolderFiles").click();
  assert.equal(elements.get("#pickerMenu").hidePopoverCalls, 2);
  assert.equal(elements.get("#importFolderInput").clickCalls, 1);

  fetchCalls = 0;
  requests.length = 0;
  state.translations["status.progressCount"] = "{completed} / {total}";
  state.translations["gallery.candidates"] = "{count} candidates";
  state.translations["folder.loadCurrent"] = "Load this folder";
  state.translations["folder.loadSelected"] = "Load {count} selected";
  state.translations["review.reviewed"] = "Reviewed";
  state.translations["review.unreviewed"] = "Unreviewed";
  state.translations["review.reviewedBadge"] = "Reviewed badge";
  state.translations["review.unreviewedBadge"] = "Unreviewed badge";
  state.translations["gallery.detectAll"] = "Detect all";
  state.translations["detectDialog.target"] = "Target: {count}";
  state.translations["detectDialog.stop"] = "Stop detection";
  state.translations["detectDialog.stopping"] = "Stopping...";
  state.translations["status.detectCancelling"] = "Stopping after current image";
  state.translations["status.detectCancelled"] = "Stopped. {completed} complete.";
  state.images = [loadedImage];
  state.job = null;
  state.detectCancelRequested = false;
  updateActionButtons();
  const requestsBeforeDetectionDialog = requests.length;
  elements.get("#detectAllButton").click();
  assert.equal(elements.get("#detectDialog").open, true, "detect all should open settings before starting");
  assert.equal(requests.length, requestsBeforeDetectionDialog, "opening settings must not call /api/detect");
  assert.equal(elements.get("#detectTargetCount").textContent, "Target: 1");
  elements.get("#detectConfidenceNumber").value = "0.67";
  const startDetection = startDetectionFromDialog({ preventDefault() {} });
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await startDetection;
  assert.equal(requests.at(-1).path, "/api/detect");
  assert.equal(JSON.parse(requests.at(-1).options.body).confidence, 0.67);
  assert.equal(elements.get("#confidence").value, "0.67", "dialog confidence should synchronize to the right pane");
  updateActionButtons();
  assert.equal(elements.get("#detectAllButton").disabled, false, "stop must remain available while detecting");
  assert.equal(elements.get("#detectCurrentButton").disabled, true);
  assert.equal(elements.get("#saveAllButton").disabled, true);
  const cancelDetectionRequest = cancelDetection();
  assert.equal(elements.get("#detectAllButton").disabled, true, "stop button disables while cancellation is pending");
  assert.equal(elements.get("#detectAllButton").textContent, "Stopping...");
  resolveFetch({ ok: true, json: async () => ({ kind: "detect", state: "running" }) });
  await cancelDetectionRequest;
  assert.equal(requests.at(-1).path, "/api/job/cancel");
  state.job = null;
  state.detectCancelRequested = false;
  updateActionButtons();
  fetchCalls = 0;
  requests.length = 0;
  state.currentImage = { width: 100, height: 80 };
  const clampedLow = clampPoint({ x: -0.5, y: 80.5 });
  assert.equal(clampedLow.x, 0);
  assert.equal(clampedLow.y, 80);
  const clampedHigh = clampPoint({ x: 99.5, y: 1.25 });
  assert.equal(clampedHigh.x, 99.5);
  assert.equal(clampedHigh.y, 1.25);
  assert.deepEqual(
    JSON.parse(JSON.stringify(roiFromPoints({ x: 50, y: 40 }, clampPoint({ x: 120, y: 100 })))),
    { left: 50, top: 40, right: 100, bottom: 80 },
  );
  state.boundaryStartClient = { x: 120, y: 140 };
  state.view.scale = 0.25;
  assert.equal(boundaryDragStarted({ clientX: 122.9, clientY: 140 }), false);
  state.view.scale = 12;
  assert.equal(boundaryDragStarted({ clientX: 123, clientY: 140 }), true);

  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 4, enabledCandidateCount: 2 },
  ];
  state.currentId = "first";
  state.imageGeneration = 1;
  state.reviewedPaths = new Set(["first.png"]);
  const staleBoundaryAppends = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  state.candidates = [];
  state.candidateImages = new Map();
  const pending = addBoundaryCandidate({ x: 8.5, y: 7.5 });
  state.currentId = "second";
  state.imageGeneration += 1;
  state.currentId = "first";
  state.imageGeneration += 1;
  resolveFetch({ ok: true, json: async () => ({ candidate: { id: "boundary", enabled: true, confidence: 0.9, color: "#fff" } }) });
  await pending;
  assert.equal(state.images[0].candidateCount, 1);
  assert.equal(state.images[0].enabledCandidateCount, 1);
  assert.equal(state.images[1].candidateCount, 4);
  assert.equal(state.candidates.length, 0);
  assert.equal(state.candidateImages.size, 0);
  assert.equal(gallery.children.length, 2);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - staleBoundaryAppends, state.images.length);
  assert.notEqual(elements.get("#status").className, "status error");

  state.currentId = "first";
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  state.job = { state: "running" };
  await addBoundaryCandidate({ x: 8, y: 7 });
  assert.equal(fetchCalls, 1);

  state.job = null;
  state.saving = true;
  await addBoundaryCandidate({ x: 8, y: 7 });
  assert.equal(fetchCalls, 1);

  state.saving = false;
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 20;
  state.reviewRoot = "";
  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", true]]);
  combinedMaskPresent = true;
  const candidateCountBeforeBoundary = state.images[0].candidateCount;
  const galleryAppendsBeforeBoundary = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundarySuccess = addBoundaryCandidate({ x: 8, y: 7 });
  resolveFetch({ ok: true, json: async () => ({ candidate: { id: "boundary-success", enabled: true, confidence: 0.9, color: "#fff" } }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, blob: async () => ({}) });
  await boundarySuccess;
  assert.equal(state.boundaryRoi, null);
  assert.equal(state.images[0].candidateCount, candidateCountBeforeBoundary + 1);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - galleryAppendsBeforeBoundary, state.images.length);
  assert.match(gallery.children[0].meta.textContent, /2 candidates/);
  combinedMaskPresent = false;

  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", false]]);
  const candidateCountBeforeMaskFailure = state.images[0].candidateCount;
  const maskFailureAppends = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundaryMaskFailure = addBoundaryCandidate({ x: 8, y: 7 });
  resolveFetch({ ok: true, json: async () => ({ candidate: { id: "boundary-mask-failure", enabled: true, confidence: 0.9, color: "#fff" } }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: false, status: 500, blob: async () => ({}) });
  await boundaryMaskFailure;
  assert.equal(state.images[0].candidateCount, candidateCountBeforeMaskFailure + 1);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - maskFailureAppends, state.images.length);
  assert.equal(imageHasMask(state.images[0]), true);
  state.galleryFilter = "masked";
  renderGallery();
  assert.equal(gallery.children.some((item) => item.dataset.id === "first"), true);
  state.galleryFilter = "all";

  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundaryFailure = addBoundaryCandidate({ x: 8, y: 7 });
  resolveFetch({ ok: false, json: async () => ({ error: "boundary failed" }) });
  await boundaryFailure;
  assert.deepEqual(JSON.parse(JSON.stringify(state.boundaryRoi)), { left: 1, top: 1, right: 20, bottom: 20 });

  // Regression: opening the current-image flow and changing selection before
  // its request resolves must retain the original target and not mutate view state.
  state.saving = false;
  state.job = null;
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.maskStatus.set("first", true);
  state.drafts = new Map([["first", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }]]);
  saveCurrent();
  state.currentId = "second";
  state.currentImage = { width: 55, height: 44 };
  const applying = startApplyFromDialog({ preventDefault() {} });
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await applying;
  const applyRequest = requests.at(-1);
  assert.equal(applyRequest.path, "/api/apply");
  const applyPayload = JSON.parse(applyRequest.options.body);
  assert.deepEqual(applyPayload.imageIds, ["first"]);
  assert.equal(applyPayload.suffix, "_censored");
  assert.equal(applyPayload.divisor, 100);
  assert.equal("blockSize" in applyPayload, false);
  assert.equal("prefix" in applyPayload, false);
  assert.equal(state.currentId, "second");

  // Session imports are never offered an overwrite path and are sent as copies.
  state.images = [{ id: "session", sourceKind: "session", relativePath: "dropped.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 }];
  state.currentId = "session";
  state.applyTargetIds = ["session"];
  state.applyRunning = false;
  elements.get("#applyOverwriteMode").checked = true;
  elements.get("#deleteOriginal").checked = true;
  syncApplyMode();
  assert.equal(applyTargetsContainSessionImage(), true);
  assert.equal(elements.get("#applyCopyMode").checked, true);
  assert.equal(elements.get("#applyOverwriteMode").disabled, true);
  assert.equal(elements.get("#applyTemporarySourceNote").hidden, false);
  assert.equal(elements.get("#deleteOriginal").checked, false);
  assert.equal(elements.get("#deleteOriginal").disabled, true);
  assert.equal(elements.get("#deleteOriginalRow").hidden, true);
  const sessionApply = startApplyFromDialog({ preventDefault() {} });
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await sessionApply;
  const sessionApplyPayload = JSON.parse(requests.at(-1).options.body);
  assert.equal(sessionApplyPayload.mode, "copy");
  assert.equal(sessionApplyPayload.suffix, "_censored");
  assert.equal(sessionApplyPayload.deleteOriginal, false);
  assert.match(source, /async function initialise\(\)[\s\S]*?await api\("\/api\/images"\)/);

  state.job = { state: "paused" };
  assert.equal(isBusy(), true);
  updateProgress({ state: "paused", total: 3, completed: 1 });
  assert.equal(elements.get("#jobProgress").hidden, false);
  updateActionButtons();
  assert.equal(elements.get("#detectCurrentButton").disabled, true);

  state.applyRunning = false;
  state.job = { kind: "detect", state: "running", total: 80, completed: 0 };
  updateProgress(state.job);
  assert.equal(elements.get("#jobProgressText").textContent, "0 / 80");
  assert.equal(elements.get("#loadFolder").disabled, true);
  assert.equal(elements.get("#folderPath").disabled, true);
  assert.equal(elements.get("#galleryAllTab").disabled, true);
  assert.equal(elements.get("#brushTool").disabled, true);
  assert.equal(elements.get("#confidence").disabled, true);
  assert.equal(elements.get("#mosaicPreviewButton").disabled, true);
  const maskBeforeToggle = state.maskStatus.get("first");
  setMosaicPreviewEnabled(false);
  assert.equal(state.mosaicPreviewEnabled, true);
  assert.equal(state.maskStatus.get("first"), maskBeforeToggle);
  state.job = { kind: "detect", state: "complete", total: 80, completed: 80 };
  updateProgress(state.job);
  assert.equal(elements.get("#jobProgressText").textContent, "80 / 80");
  assert.equal(elements.get("#loadFolder").disabled, false);
  setMosaicPreviewEnabled(false);
  assert.equal(state.mosaicPreviewEnabled, false);
  assert.equal(state.maskStatus.get("first"), maskBeforeToggle);
  setMosaicPreviewEnabled(true);

  // A stale mask is reconciled by exactly one fresh candidate-list request.
  state.imageGeneration = 30;
  const staleCandidateRequestCount = requests.filter((request) => request.path === "/api/candidates/first").length;
  const staleMask = loadCandidateBundle("first", 30);
  resolveFetch({ ok: true, json: async () => ({ candidates: [{ id: "stale-one" }, { id: "stale-two" }] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: false, status: 404 });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [] }) });
  const reconciled = await staleMask;
  assert.equal(reconciled.candidates.length, 0);
  const staleCandidateRequests = requests.filter((request) => request.path === "/api/candidates/first");
  assert.equal(staleCandidateRequests.length - staleCandidateRequestCount, 2);

  // A failed selection leaves the previously coherent editor state untouched.
  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 50, height: 40, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.candidates = [{ id: "first-candidate", enabled: true }];
  state.imageGeneration = 50;
  const failedSelection = selectImage("second");
  resolveFetch({ ok: false, status: 500, json: async () => ({ error: "candidate request failed" }) });
  await failedSelection;
  assert.equal(state.currentId, "first");
  assert.equal(state.currentImage.width, 100);
  assert.equal(state.candidates[0].id, "first-candidate");

  // Rapid clicks for one candidate are sent in order, never concurrently.
  state.currentId = "first";
  state.imageGeneration = 60;
  const toggled = { id: "serialized", enabled: true, color: "#ffffff" };
  const firstUpdate = updateCandidate(toggled, false);
  toggled.enabled = false;
  const secondUpdate = updateCandidate(toggled, true);
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await Promise.all([firstUpdate, secondUpdate]);
  const updateRequests = requests.filter((request) => request.path.endsWith("/serialized"));
  assert.deepEqual(updateRequests.map((request) => JSON.parse(request.options.body).enabled), [true, false]);

  // Same-tab completion reloads a target image without putting its old canvas
  // back into drafts.
  const target = { id: "target", relativePath: "target.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [target];
  state.currentId = "target";
  state.currentImage = { width: 100, height: 80 };
  state.drafts = new Map([["target", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }]]);
  state.applyTargetIds = ["target"];
  state.applyRunning = true;
  state.applyFinishing = false;
  state.imageGeneration += 1;
  const completion = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["target"], startedAt: 200 });
  resolveFetch({ ok: true, json: async () => ({ images: [target] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [] }) });
  await completion;
  assert.equal(state.drafts.has("target"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.applyTargetIds)), ["target"]);

  // A tab that did not start the job still uses the server's immutable target
  // IDs when its first job poll sees the terminal state.
  state.images = [target];
  state.currentId = "target";
  state.currentImage = { width: 100, height: 80 };
  state.drafts = new Map([["target", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }]]);
  state.applyTargetIds = [];
  state.applyRunning = false;
  state.applyFinishing = false;
  state.handledApplyStartedAt = null;
  state.job = { kind: "idle", state: "idle" };
  state.imageGeneration += 1;
  const crossTabPoll = pollJob();
  resolveFetch({ ok: true, json: async () => ({ kind: "apply", state: "complete", completed: 1, total: 1, imageIds: ["target"], startedAt: 201 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: [target] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [] }) });
  await crossTabPoll;
  assert.equal(state.drafts.has("target"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.applyTargetIds)), ["target"]);
  assert.equal(state.handledApplyStartedAt, 201);

  // A cancelled same-tab job only clears drafts for already completed images;
  // the current unprocessed image remains editable without a reload.
  const completedTarget = { id: "completed", relativePath: "completed.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const pendingTarget = { id: "pending", relativePath: "pending.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 };
  state.images = [completedTarget, pendingTarget];
  state.currentId = "pending";
  state.currentImage = { width: 100, height: 80, preserved: true };
  state.candidates = [{ id: "pending-candidate", enabled: true }];
  state.candidateImages = new Map([["pending-candidate", { width: 100, height: 80 }]]);
  state.drafts = new Map([
    ["completed", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }],
    ["pending", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }],
  ]);
  state.applyTargetIds = ["completed", "pending"];
  state.applyRunning = true;
  state.applyFinishing = false;
  state.imageGeneration += 1;
  const cancelledCompletion = finishApplyJob({ kind: "apply", state: "cancelled", completed: 1, imageIds: ["completed", "pending"], completedImageIds: ["completed"], startedAt: 300 });
  resolveFetch({ ok: true, json: async () => ({ images: [completedTarget, pendingTarget] }) });
  await cancelledCompletion;
  assert.equal(state.drafts.has("completed"), false);
  assert.equal(state.drafts.has("pending"), true);
  assert.equal(state.currentId, "pending");
  assert.equal(state.currentImage.preserved, true);
  assert.equal(state.candidates[0].id, "pending-candidate");

  // A tab observing a terminal error from elsewhere follows the same rule.
  state.images = [completedTarget, pendingTarget];
  state.currentId = "pending";
  state.currentImage = { width: 100, height: 80, preserved: true };
  state.candidates = [{ id: "pending-candidate", enabled: true }];
  state.candidateImages = new Map([["pending-candidate", { width: 100, height: 80 }]]);
  state.drafts = new Map([
    ["completed", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }],
    ["pending", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }],
  ]);
  state.applyTargetIds = [];
  state.applyRunning = false;
  state.applyFinishing = false;
  state.handledApplyStartedAt = null;
  state.job = { kind: "idle", state: "idle" };
  state.imageGeneration += 1;
  const errorPoll = pollJob();
  resolveFetch({ ok: true, json: async () => ({ kind: "apply", state: "error", completed: 1, total: 2, imageIds: ["completed", "pending"], completedImageIds: ["completed"], startedAt: 301, error: "failed" }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: [completedTarget, pendingTarget] }) });
  await errorPoll;
  assert.equal(state.drafts.has("completed"), false);
  assert.equal(state.drafts.has("pending"), true);
  assert.equal(state.currentId, "pending");
  assert.equal(state.currentImage.preserved, true);
  assert.equal(state.candidates[0].id, "pending-candidate");

  // Copy-save with delete-original keeps a completed image's reviewed state
  // when the server preserves its ID but changes its relative path.
  const reviewedOldPath = { id: "migrated", relativePath: "old.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const reviewedNewPath = { ...reviewedOldPath, relativePath: "old_censored.png" };
  state.images = [reviewedOldPath];
  state.currentId = null;
  state.currentImage = null;
  state.reviewRoot = "g:\\images\\apply";
  state.reviewedPaths = new Set(["old.png"]);
  storage.set("lets-censoring.reviewed.v1:g:\\images\\apply:old.png", "true");
  state.applyFinishing = false;
  const reviewedPathMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["migrated"], completedImageIds: ["migrated"], startedAt: 302 });
  resolveFetch({ ok: true, json: async () => ({ images: [reviewedNewPath] }) });
  await reviewedPathMigration;
  assert.equal(storage.has("lets-censoring.reviewed.v1:g:\\images\\apply:old.png"), false);
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\apply:old_censored.png"), "true");
  assert.equal(isReviewed(reviewedNewPath), true);

  // A second tab can finish the same copy-delete job after the first one has
  // already removed the old key. The reviewed result must remain intact.
  const idempotentOldPath = { id: "idempotent", relativePath: "idempotent.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const idempotentNewPath = { ...idempotentOldPath, relativePath: "idempotent_censored.png" };
  const idempotentOldKey = "lets-censoring.reviewed.v1:g:\\images\\apply:idempotent.png";
  const idempotentNewKey = "lets-censoring.reviewed.v1:g:\\images\\apply:idempotent_censored.png";
  storage.set(idempotentOldKey, "true");
  storage.delete(idempotentNewKey);
  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.has(idempotentOldKey), false);
  assert.equal(storage.get(idempotentNewKey), "true");
  assert.equal(isReviewed(idempotentNewPath), true);

  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.get(idempotentNewKey), "true");
  assert.equal(isReviewed(idempotentNewPath), true);

  storage.delete(idempotentOldKey);
  storage.delete(idempotentNewKey);
  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.has(idempotentNewKey), false);
  assert.equal(isReviewed(idempotentNewPath), false);

  // Storage is the source of truth when another tab changed the old path just
  // before this tab migrated it.
  const storageWinsOldPath = { id: "storage-wins", relativePath: "storage-wins.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const storageWinsNewPath = { ...storageWinsOldPath, relativePath: "storage-wins_censored.png" };
  state.images = [storageWinsOldPath];
  state.reviewedPaths = new Set();
  storage.set("lets-censoring.reviewed.v1:g:\\images\\apply:storage-wins.png", "true");
  state.applyFinishing = false;
  const storageWinsMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["storage-wins"], completedImageIds: ["storage-wins"], startedAt: 307 });
  resolveFetch({ ok: true, json: async () => ({ images: [storageWinsNewPath] }) });
  await storageWinsMigration;
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\apply:storage-wins_censored.png"), "true");
  assert.equal(isReviewed(storageWinsNewPath), true);

  // If another tab already migrated the state, the new key is authoritative
  // even when this tab still has the old path selected in memory.
  const storageMissingOldPath = { id: "storage-missing", relativePath: "storage-missing.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const storageMissingNewPath = { ...storageMissingOldPath, relativePath: "storage-missing_censored.png" };
  state.images = [storageMissingOldPath];
  state.reviewedPaths = new Set(["storage-missing.png"]);
  storage.delete("lets-censoring.reviewed.v1:g:\\images\\apply:storage-missing.png");
  storage.set("lets-censoring.reviewed.v1:g:\\images\\apply:storage-missing_censored.png", "true");
  state.applyFinishing = false;
  const storageMissingMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["storage-missing"], completedImageIds: ["storage-missing"], startedAt: 308 });
  resolveFetch({ ok: true, json: async () => ({ images: [storageMissingNewPath] }) });
  await storageMissingMigration;
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\apply:storage-missing_censored.png"), "true");
  assert.equal(isReviewed(storageMissingNewPath), true);

  // An unreviewed source remains unreviewed at its new path, while any stale
  // record at that path is removed.
  const unreviewedOldPath = { id: "unreviewed", relativePath: "plain.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const unreviewedNewPath = { ...unreviewedOldPath, relativePath: "plain_censored.png" };
  state.images = [unreviewedOldPath];
  state.reviewedPaths = new Set();
  storage.delete("lets-censoring.reviewed.v1:g:\\images\\apply:plain.png");
  storage.delete("lets-censoring.reviewed.v1:g:\\images\\apply:plain_censored.png");
  state.applyFinishing = false;
  const unreviewedPathMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["unreviewed"], completedImageIds: ["unreviewed"], startedAt: 303 });
  resolveFetch({ ok: true, json: async () => ({ images: [unreviewedNewPath] }) });
  await unreviewedPathMigration;
  assert.equal(storage.has("lets-censoring.reviewed.v1:g:\\images\\apply:plain.png"), false);
  assert.equal(storage.has("lets-censoring.reviewed.v1:g:\\images\\apply:plain_censored.png"), false);
  assert.equal(isReviewed(unreviewedNewPath), false);

  // Storage failures do not prevent the in-session reviewed state from moving.
  const storageGetItem = context.localStorage.getItem;
  const storageSetItem = context.localStorage.setItem;
  const storageRemoveItem = context.localStorage.removeItem;
  const memoryOnlyOldPath = { id: "memory-only", relativePath: "memory.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const memoryOnlyNewPath = { ...memoryOnlyOldPath, relativePath: "memory_censored.png" };
  state.images = [memoryOnlyOldPath];
  state.reviewedPaths = new Set(["memory.png"]);
  context.localStorage.getItem = () => { throw new Error("storage unavailable"); };
  context.localStorage.setItem = () => { throw new Error("storage unavailable"); };
  context.localStorage.removeItem = () => { throw new Error("storage unavailable"); };
  state.applyFinishing = false;
  const memoryOnlyMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["memory-only"], completedImageIds: ["memory-only"], startedAt: 304 });
  resolveFetch({ ok: true, json: async () => ({ images: [memoryOnlyNewPath] }) });
  await memoryOnlyMigration;
  assert.equal(isReviewed(memoryOnlyNewPath), true);
  assert.equal(state.reviewedPaths.has("memory.png"), false);
  context.localStorage.getItem = storageGetItem;
  context.localStorage.setItem = storageSetItem;
  context.localStorage.removeItem = storageRemoveItem;

  // A normal copy creates a new ID, so it must never inherit review state.
  const copiedSource = { id: "source", relativePath: "source.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const copiedOutput = { id: "copy", relativePath: "source_censored.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [copiedSource];
  state.reviewedPaths = new Set(["source.png"]);
  storage.set("lets-censoring.reviewed.v1:g:\\images\\apply:source.png", "true");
  state.applyFinishing = false;
  const normalCopy = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["source"], completedImageIds: ["source"], startedAt: 305 });
  resolveFetch({ ok: true, json: async () => ({ images: [copiedSource, copiedOutput] }) });
  await normalCopy;
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\apply:source.png"), "true");
  assert.equal(isReviewed(copiedOutput), false);

  // Overwrite retains the same path, so reviewed state remains untouched.
  state.images = [copiedSource];
  state.reviewedPaths = new Set(["source.png"]);
  state.applyFinishing = false;
  const overwritten = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["source"], completedImageIds: ["source"], startedAt: 306 });
  resolveFetch({ ok: true, json: async () => ({ images: [copiedSource] }) });
  await overwritten;
  assert.equal(isReviewed(copiedSource), true);

  // A tab that did not start detection must use the server job's immutable
  // target IDs, rather than its own stale local target list.
  const detectedTarget = { id: "detected", relativePath: "detected.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [detectedTarget];
  state.currentId = null;
  state.currentImage = null;
  state.reviewRoot = "g:\\images\\detect";
  state.reviewedPaths = new Set(["detected.png", "fallback.png"]);
  storage.set("lets-censoring.reviewed.v1:g:\\images\\detect", '["detected.png", "fallback.png"]');
  state.detectionTargetIds = ["fallback"];
  state.pageLoadedAt = 1000;
  state.handledDetectionStartedAt = null;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 999 }, { kind: "idle", state: "idle" }), false);
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 1001 }, { kind: "idle", state: "idle" }), true);
  state.handledDetectionStartedAt = 1001;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 1001 }, { kind: "idle", state: "idle" }), false);
  state.handledDetectionStartedAt = null;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 999 }, { kind: "detect", state: "running", startedAt: 999 }), true);
  const crossTabDetection = finishDetectionJob({ kind: "detect", state: "complete", imageIds: ["detected"], startedAt: 777 });
  resolveFetch({ ok: true, json: async () => ({ images: [detectedTarget] }) });
  await crossTabDetection;
  assert.equal(isReviewed(detectedTarget), false);
  assert.equal(state.reviewedPaths.has("fallback.png"), true);
  assert.equal(state.handledDetectionStartedAt, 777);
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 777 }, { kind: "detect", state: "complete", startedAt: 777 }), false);

  state.currentId = null;
  state.currentImage = null;
  state.job = { kind: "detect", state: "running", total: 3, completed: 0 };
  updateProgress(state.job);
  state.job = { kind: "detect", state: "complete", total: 3, completed: 3 };
  updateProgress(state.job);
  assert.equal(elements.get("#detectCurrentButton").disabled, true);
  assert.equal(elements.get("#saveButton").disabled, true);
  assert.equal(elements.get("#folderPath").disabled, false);
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };

  state.applyRunning = true;
  assert.equal(isTerminalApply({ kind: "apply", state: "complete" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "cancelled" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "error" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "running" }), false);
  state.applyRunning = false;
  state.handledApplyStartedAt = null;
  assert.equal(isTerminalApply({ kind: "apply", state: "complete", startedAt: 123 }), true);
  state.handledApplyStartedAt = 123;
  assert.equal(isTerminalApply({ kind: "apply", state: "complete", startedAt: 123 }), false);

  assert.equal(calculatedBlockSize({ width: 832, height: 1216 }, 100), 13);
  assert.equal(calculatedBlockSize({ width: 832, height: 1216 }, 200), 7);
  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 4, enabledCandidateCount: 2 },
  ];
  state.maskStatus = new Map([["first", true], ["second", false]]);
  assert.equal(imageHasMask(state.images[0]), true);
  assert.deepEqual(JSON.parse(JSON.stringify(saveTargets())), ["first"]);
  state.galleryFilter = "masked";
  gallery.scrollTop = 111;
  renderGallery();
  assert.equal(gallery.children.length, 1);
  assert.equal(gallery.scrollTop, 111);
  state.galleryFilter = "all";
  gallery.scrollTop = 247;
  refreshMaskStatus(true);
  assert.equal(gallery.scrollTop, 247);
  state.reviewRoot = "g:\\images\\work";
  state.reviewedPaths = new Set();
  setReviewed(state.images[0], true);
  assert.equal(isReviewed(state.images[0]), true);
  assert.equal(isReviewed(state.images[1]), false);
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\work:first.png"), "true");
  assert.equal(storage.has("lets-censoring.reviewed.v1:g:\\images\\work:second.png"), false);
  state.reviewedPaths = new Set();
  loadReviewedPaths();
  assert.equal(isReviewed(state.images[0]), true);
  state.reviewRoot = "g:\\images\\other";
  loadReviewedPaths();
  assert.equal(isReviewed(state.images[0]), false);
  state.reviewRoot = "g:\\images\\work";
  loadReviewedPaths();
  storage.set("lets-censoring.reviewed.v1:g:\\images\\work:second.png", "true");
  state.reviewedPaths = new Set();
  setReviewed(state.images[0], true);
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\work:first.png"), "true");
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\work:second.png"), "true");
  markImagesUnreviewed(["first"]);
  assert.equal(storage.has("lets-censoring.reviewed.v1:g:\\images\\work:first.png"), false);
  assert.equal(storage.get("lets-censoring.reviewed.v1:g:\\images\\work:second.png"), "true");
  handleReviewStorageEvent({ key: "lets-censoring.reviewed.v1:g:\\images\\work:first.png", newValue: "true" });
  assert.equal(isReviewed(state.images[0]), true);
  handleReviewStorageEvent({ key: "lets-censoring.reviewed.v1:g:\\images\\work:first.png", newValue: null });
  assert.equal(isReviewed(state.images[0]), false);
  handleReviewStorageEvent({ key: "lets-censoring.reviewed.v1:g:\\images\\work:second.png", newValue: "true" });
  assert.equal(isReviewed(state.images[1]), true);
  const overviewSentinel = { sentinel: true };
  overviewGrid.children = [overviewSentinel];
  const writesBeforeNoop = storageWrites;
  state.viewMode = "edit";
  const gallerySentinel = { sentinel: true };
  gallery.children = [gallerySentinel];
  setReviewed(state.images[1], true);
  renderOverview();
  assert.equal(storageWrites, writesBeforeNoop);
  assert.equal(overviewGrid.children[0], overviewSentinel);
  setReviewed(state.images[0], false);
  assert.equal(overviewGrid.children[0], overviewSentinel);
  assert.equal(gallery.children[0], gallerySentinel);
  setReviewed(state.images[0], true);
  setReviewed(state.images[1], false);
  state.overviewFilter = "unreviewed";
  assert.deepEqual(JSON.parse(JSON.stringify(overviewImages().map((image) => image.id))), ["second"]);
  assert.equal(nextUnreviewedImage()?.id, "second");
  setViewMode("overview");
  assert.equal(overviewGrid.children.length, 1);
  state.overviewFilter = "all";
  state.images = [
    { id: "nested", relativePath: "A/B/C/file.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "sibling", relativePath: "A/D/file.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(overviewFolderOptions())), ["A", "A/B", "A/B/C", "A/D"]);
  state.overviewFolder = "A/B";
  assert.deepEqual(JSON.parse(JSON.stringify(overviewImages().map((image) => image.id))), ["nested"]);
  state.overviewFolder = "";
  state.viewMode = "edit";
  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "third", relativePath: "third.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.reviewedPaths = new Set(["second.png"]);
  setViewMode("overview");
  overviewGrid.children[0].click();
  assert.equal(state.viewMode, "edit");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  state.navigationShortcutsEnabled = false;
  const disabledEnter = keyEvent("Enter");
  assert.equal(handleNavigationKeydown(disabledEnter), false);
  assert.equal(disabledEnter.prevented, false);
  assert.equal(isReviewed(state.images[0]), false);
  state.navigationShortcutsEnabled = true;
  elements.get("#applyDialog").open = false;
  assert.equal(navigationShortcutAction(keyEvent("ArrowRight", { shiftKey: true })), "nextUnreviewed");
  assert.equal(navigationShortcutAction(keyEvent("Home")), "first");
  assert.equal(navigationShortcutAction(keyEvent("End")), "last");
  document.activeElement = { tagName: "INPUT" };
  assert.equal(navigationShortcutAction(keyEvent("g")), null);
  document.activeElement = null;
  elements.get("#confirmDialog").open = true;
  assert.equal(navigationShortcutAction(keyEvent("g")), null);
  elements.get("#confirmDialog").open = false;
  const toggleOverview = keyEvent("g");
  assert.equal(handleNavigationKeydown(toggleOverview), true);
  assert.equal(toggleOverview.prevented, true);
  assert.equal(state.viewMode, "overview");
  assert.equal(document.activeElement, elements.get("#overviewPane"));
  setViewMode("edit");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  const shortcutCheckbox = elements.get("#navigationShortcutsEnabled");
  shortcutCheckbox.focus();
  shortcutCheckbox.checked = true;
  shortcutCheckbox.dispatch("change");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  runNavigationAction(() => {});
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  const space = keyEvent(" ", { code: "Space" });
  state.navigationShortcutsEnabled = false;
  assert.equal(handleEditorKeydown(space), false);
  assert.equal(space.prevented, false);
  const undo = keyEvent("z", { ctrlKey: true });
  assert.equal(handleEditorKeydown(undo), true);
  assert.equal(undo.prevented, true);
  state.viewMode = "overview";
  const overviewSpace = keyEvent(" ", { code: "Space" });
  assert.equal(handleEditorKeydown(overviewSpace), false);
  assert.equal(overviewSpace.prevented, false);
  const overviewUndo = keyEvent("z", { ctrlKey: true });
  assert.equal(handleEditorKeydown(overviewUndo), false);
  assert.equal(overviewUndo.prevented, false);
  state.viewMode = "edit";
  state.navigationShortcutsEnabled = true;
  const shiftRight = keyEvent("ArrowRight", { shiftKey: true });
  assert.equal(handleNavigationKeydown(shiftRight), true);
  assert.equal(shiftRight.prevented, true);
  assert.equal(requests.at(-1).path, "/api/candidates/third");
  const enter = keyEvent("Enter");
  assert.equal(handleNavigationKeydown(enter), true);
  assert.equal(enter.prevented, true);
  assert.equal(isReviewed(state.images[0]), true);
  assert.equal(requests.at(-1).path, "/api/candidates/second");
  rebuildMosaicPreview();
  paintMosaicPreview();
  saveAll();

  const importedFiles = [
    { name: "first.png", webkitRelativePath: "album/first.png", arrayBuffer: async () => new Uint8Array([1]).buffer },
    { name: "ignored.txt", arrayBuffer: async () => new Uint8Array([2]).buffer },
    { name: "second.webp", arrayBuffer: async () => new Uint8Array([3]).buffer },
  ];
  const importing = importFiles(importedFiles);
  assert.equal(state.importing, true);
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await importing;
  const importRequests = requests.filter((request) => request.path === "/api/import");
  assert.equal(importRequests.length, 2);
  assert.equal(JSON.parse(importRequests[0].options.body).files[0].name, "first.png");
  assert.equal(JSON.parse(importRequests[0].options.body).files[0].relativePath, "album/first.png");
  assert.equal(JSON.parse(importRequests[1].options.body).files[0].name, "second.webp");
  assert.equal(state.importing, false);

  const imageInput = elements.get("#importImagesInput");
  const requestCountBeforeCancel = requests.length;
  const catalogBeforeCancel = JSON.stringify(state.images);
  imageInput.files = [];
  imageInput.value = "previous-selection";
  imageInput.dispatch("change");
  assert.equal(imageInput.value, "");
  assert.equal(requests.length, requestCountBeforeCancel);
  assert.equal(JSON.stringify(state.images), catalogBeforeCancel);

  const folderInput = elements.get("#importFolderInput");
  folderInput.value = "same-folder";
  const folderImport = importFiles([{ name: "nested.png", webkitRelativePath: "source/nested/nested.png", arrayBuffer: async () => new Uint8Array([4]).buffer }]);
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await folderImport;
  folderInput.value = "";
  assert.equal(folderInput.value, "");
  const folderRequest = requests.at(-1);
  assert.equal(JSON.parse(folderRequest.options.body).files[0].relativePath, "source/nested/nested.png");

  console.log("test_app_js: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
