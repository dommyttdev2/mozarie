const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  return {
    disabled: false, textContent: "", className: "", hidden: false, value: "", style: {}, dataset: {},
    classList: { toggle() {} }, append() {}, appendChild() {}, addEventListener() {}, setAttribute() {}, showModal() {}, close() {},
  };
}

function galleryItem() {
  const checkbox = element();
  const preview = element();
  const name = element();
  const meta = element();
  return {
    ...element(),
    querySelector(selector) {
      return { input: checkbox, img: preview, ".gallery-name": name, ".gallery-meta": meta }[selector];
    },
  };
}

const elements = new Map();
for (const id of [
  "editorCanvas", "canvasStage", "detectAllButton", "detectCurrentButton", "clearCurrentMasksButton", "clearAllMasksButton", "clearCatalogButton", "applyButton", "saveButton",
  "status", "jobProgress", "gallery", "imageCount", "selectAllButton", "selectedCount", "candidateList", "candidateStatus",
  "applyTargetCount", "applyBlockSize", "blockSize", "applyProgressPanel", "applyStartButton", "applyCloseButton", "applyPauseButton", "applyCancelButton", "applySettings", "applyResult", "applyPrefix", "deleteOriginal", "deleteOriginalRow", "applyDialog",
]) elements.set(`#${id}`, element());
elements.get("#applyPrefix").value = "censored_";
elements.get("#applyBlockSize").value = "4";
elements.get("#blockSize").value = "4";
const gallery = elements.get("#gallery");
gallery.children = [];
gallery.append = function append(child) { this.children.push(child); };
Object.defineProperty(gallery, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
elements.get("#editorCanvas").getContext = () => ({ });
elements.get("#canvasStage").clientWidth = 600;
elements.get("#canvasStage").clientHeight = 400;
elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });

const document = {
  querySelector: (selector) => selector === 'input[name="saveMode"]:checked' ? { value: "copy" } : (elements.get(selector) || element()),
  querySelectorAll: () => [],
  createElement: (tag) => tag === "canvas" ? {
    width: 1, height: 1,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    toDataURL: () => "data:image/png;base64,test",
  } : element(),
};
let resolveFetch;
let fetchCalls = 0;
const requests = [];
const context = {
  console, document, Date, Math, Promise, setInterval() {}, ResizeObserver: class {},
  fetch: (path, options) => { fetchCalls += 1; requests.push({ path, options }); return new Promise((resolve) => { resolveFetch = resolve; }); },
};

let source = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__mosaicTest = { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, startApplyFromDialog, isBusy, updateActionButtons, updateProgress, isTerminalApply };\n");
vm.runInNewContext(source, context, { filename: "static/app.js" });
const { state, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, saveCurrent, startApplyFromDialog, isBusy, updateActionButtons, updateProgress, isTerminalApply } = context.__mosaicTest;

(async () => {
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
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 4 },
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

  // Regression: opening the current-image flow and changing selection before
  // its request resolves must retain the original target and not mutate view state.
  state.saving = false;
  state.job = null;
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.drafts = new Map([["first", { add: "data:image/png;base64,test", exclusion: "data:image/png;base64,test" }]]);
  saveCurrent();
  state.currentId = "second";
  state.currentImage = { width: 55, height: 44 };
  const applying = startApplyFromDialog({ preventDefault() {} });
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await applying;
  const applyRequest = requests.at(-1);
  assert.equal(applyRequest.path, "/api/apply");
  assert.deepEqual(JSON.parse(applyRequest.options.body).imageIds, ["first"]);
  assert.equal(state.currentId, "second");

  state.job = { state: "paused" };
  assert.equal(isBusy(), true);
  updateProgress({ state: "paused", total: 3, completed: 1 });
  assert.equal(elements.get("#jobProgress").hidden, false);
  updateActionButtons();
  assert.equal(elements.get("#detectCurrentButton").disabled, true);

  state.applyRunning = true;
  assert.equal(isTerminalApply({ kind: "apply", state: "complete" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "cancelled" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "error" }), true);
  assert.equal(isTerminalApply({ kind: "apply", state: "running" }), false);

  console.log("test_app_js: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
