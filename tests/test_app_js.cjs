const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  return {
    disabled: false, textContent: "", className: "", hidden: false, value: "", style: {}, dataset: {}, attributes: {},
    classList: { toggle() {} }, append() {}, appendChild() {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; }, showModal() {}, close() {}, focus() {}, click() {},
  };
}

function galleryItem() {
  const preview = element();
  const name = element();
  const meta = element();
  return {
    ...element(),
    querySelector(selector) {
      return { img: preview, ".gallery-name": name, ".gallery-meta": meta }[selector];
    },
  };
}

const elements = new Map();
for (const id of [
  "editorCanvas", "canvasStage", "detectAllButton", "detectCurrentButton", "clearCurrentMasksButton", "clearAllMasksButton", "clearCatalogButton", "saveAllButton", "saveButton", "galleryAllTab", "galleryMaskedTab", "pickFolder", "browseFolderOption", "browseImagesOption", "importFilesInput", "mosaicPreviewButton", "loadFolder", "folderPath", "brushTool", "eraserTool", "boundaryTool", "fitButton", "undoButton", "redoButton", "brushSize", "confidence",
  "status", "jobProgress", "jobProgressText", "gallery", "imageCount", "candidateList", "candidateStatus", "divisor", "blockSizeValue",
  "applyTargetCount", "applyBlockSize", "applyDivisor", "applyProgressPanel", "applyStartButton", "applyCloseButton", "applyPauseButton", "applyCancelButton", "applySettings", "applyResult", "applySuffix", "deleteOriginal", "deleteOriginalRow", "applyDialog",
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
gallery.append = function append(child) { this.children.push(child); };
Object.defineProperty(gallery, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
elements.get("#editorCanvas").getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, stroke() {}, setLineDash() {} });
elements.get("#canvasStage").clientWidth = 600;
elements.get("#canvasStage").clientHeight = 400;
elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });

const document = {
  querySelector: (selector) => selector === 'input[name="saveMode"]:checked' ? { value: "copy" } : (elements.get(selector) || element()),
  querySelectorAll: (selector) => selector === "button, input, select, textarea" ? [...elements.values()].filter((item) => item.id) : [],
  createElement: (tag) => tag === "canvas" ? {
    width: 1, height: 1,
    getContext: () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; } }),
    toDataURL: () => "data:image/png;base64,test",
  } : element(),
};
let resolveFetch;
let fetchCalls = 0;
const requests = [];
const context = {
  console, document, Date, Math, Promise, window: { devicePixelRatio: 1 }, setInterval() {}, ResizeObserver: class {},
  Image: class { set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); } },
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch: (path, options) => { fetchCalls += 1; requests.push({ path, options }); return new Promise((resolve) => { resolveFetch = resolve; }); },
};

let source = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
assert.doesNotMatch(source, /setInterval\(\s*render\s*,/);
source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__mosaicTest = { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, setMosaicPreviewEnabled, importFiles, loadCandidateBundle, selectImage, updateCandidate };\n");
vm.runInNewContext(source, context, { filename: "static/app.js" });
const { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, setMosaicPreviewEnabled, importFiles, loadCandidateBundle, selectImage, updateCandidate } = context.__mosaicTest;

(async () => {
  state.translations["status.progressCount"] = "{completed} / {total}";
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
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundarySuccess = addBoundaryCandidate({ x: 8, y: 7 });
  resolveFetch({ ok: true, json: async () => ({ candidate: { id: "boundary-success", enabled: true, confidence: 0.9, color: "#fff" } }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, blob: async () => ({}) });
  await boundarySuccess;
  assert.equal(state.boundaryRoi, null);

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
  rebuildMosaicPreview();
  paintMosaicPreview();
  saveAll();

  const importedFiles = [
    { name: "first.png", arrayBuffer: async () => new Uint8Array([1]).buffer },
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
  assert.equal(JSON.parse(importRequests[1].options.body).files[0].name, "second.webp");
  assert.equal(state.importing, false);

  console.log("test_app_js: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
