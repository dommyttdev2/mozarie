const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function canvasContext(name) {
  const context = {
    name, pixels: false, calls: [],
    canvas: { width: 100, height: 80 },
    save() { this.calls.push("save"); }, restore() { this.calls.push("restore"); },
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { this.pixels = true; this.calls.push(`stroke:${this.globalCompositeOperation}`); },
    clearRect() { this.pixels = false; this.calls.push("clear"); },
    drawImage() { this.pixels = true; this.calls.push("draw"); },
    fillRect() { this.pixels = true; this.calls.push(`fill:${this.globalCompositeOperation}`); },
    getImageData() { return { data: new Uint8ClampedArray(100 * 80 * 4) }; },
  };
  return context;
}

const addCtx = canvasContext("add");
const exclusionCtx = canvasContext("exclude");
const exclusionEraseCtx = canvasContext("excludeErase");
const historyAddCtx = canvasContext("historyAdd");
const historyExclusionCtx = canvasContext("historyExclude");
const historyExclusionEraseCtx = canvasContext("historyExcludeErase");
exclusionCtx.pixels = true;
exclusionEraseCtx.pixels = true;
const elements = new Map();
function element(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    value: selector === "#bucketTolerance" ? "12" : "6", textContent: "", disabled: false,
    children: [], dataset: {}, classList: { toggle() {}, remove() {} }, setAttribute() {}, addEventListener() {},
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
  });
  return elements.get(selector);
}

const events = [];
const state = {
  currentId: "image", currentImage: { width: 100, height: 80 }, imageGeneration: 2, catalogEpoch: 3,
  candidates: [
    { id: "apply", role: "apply", enabled: true, className: "target", color: "#fff" },
    { id: "exclude", role: "exclude", enabled: true, forced: true, className: "keep", color: "#000" },
  ],
  removedCandidateIds: new Set(), blinkCandidateIds: new Set(), blinkModes: new Map(), blinkPhase: false, blinkTimer: null,
  manualMaskPresent: true, manualEnabled: true, manualExclusionEnabled: true, manualExclusionEraseEnabled: true, manualExclusionForced: false,
  candidateUpdateChains: new Map(), candidateUpdateVersions: new Map(), candidateDeleting: new Set(), candidateBatchPending: new Set(),
  maskStatus: new Map(), images: [{ id: "image", assetVersion: "a", candidateRevision: 4, candidateCount: 0, enabledCandidateCount: 0 }],
  history: [], historyIndex: 0, historyRemovedCandidateIds: new Set(), historyCandidateIds: new Set(["apply", "exclude"]), historyBaseDirty: false,
  boundaryDrafts: [{ id: "draft", type: "rectangle", roi: { left: 1, top: 2, right: 10, bottom: 12 } }], boundaryActiveId: "draft", boundaryPending: false,
  importing: false, pendingImageId: null, fillPending: false, tool: "brush", view: { x: 0, y: 0, scale: 1 },
};

const context = {
  state, Math, Number, String, Boolean, Array, Map, Set, Promise, JSON, Uint8ClampedArray, encodeURIComponent,
  addCtx, exclusionCtx, exclusionEraseCtx, addCanvas: addCtx.canvas, exclusionCanvas: exclusionCtx.canvas, exclusionEraseCanvas: exclusionEraseCtx.canvas,
  historyAddCanvas: { ...historyAddCtx.canvas, getContext: () => historyAddCtx },
  historyExclusionCanvas: { ...historyExclusionCtx.canvas, getContext: () => historyExclusionCtx },
  historyExclusionEraseCanvas: { ...historyExclusionEraseCtx.canvas, getContext: () => historyExclusionEraseCtx },
  combinedCanvas: { toDataURL: () => "data:image/png;base64,mask" }, originalCanvas: { width: 100, height: 80 }, originalCtx: addCtx,
  canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
  $: element, document: { querySelectorAll: () => [], createElement: () => element(`node-${elements.size}`) },
  setInterval: () => 1, clearInterval() {},
  isBusy: () => false, isCurrentGeneration: (generation) => generation === state.imageGeneration,
  catalogRecordMatches: () => true, currentRecord: () => state.images.find((record) => record.id === state.currentId),
  imageAssetVersion: (record) => record?.assetVersion || "", canvasHasPixels: (ctx) => ctx.pixels,
  t: (key) => key, confirmationRequired: () => false, confirmAction: async () => true,
  markMaskDirty: () => events.push("dirty"), markDraftDirty: (...layers) => events.push(`draft:${layers.join(",")}`),
  flushMaskComposition: () => events.push("flush"), requestMosaicPreview: () => events.push("preview"), scheduleManualWorkspaceSave: () => events.push("save"),
  setReviewed: () => events.push("review"), updateHistoryButtons() {}, updateCandidateStatus() {}, refreshCurrentReviewAndMask() {}, refreshMaskStatus() {},
  renderCandidates: () => events.push("candidates"), render: () => events.push("render"), renderCatalogViews: () => events.push("catalog"), updateActionButtons() {},
  updateCandidateBatchButtons() {},
  syncCurrentCandidateRecord() {}, syncCandidateRecord() {}, retainCurrentCandidateBundle() {}, refreshCandidateRecord: async () => {}, reconcileCurrentCandidates: async () => true,
  releaseCandidateBitmap() {}, releaseCandidateBundles() {}, invalidateCandidateBundles: () => events.push("invalidate"), markImagesUnreviewed: () => events.push("unreview"),
  updateBoundaryActions() {}, setStatusKey: () => events.push("status"), showUserError: (error) => events.push(`error:${error}`),
  canDetectBoundary: () => true,
  boundaryRequests: () => [{ draft: state.boundaryDrafts[0], draftIds: ["draft"] }], pointForRoi: (roi) => ({ x: roi.left + 1, y: roi.top + 1 }),
  api: async () => ({ candidates: [{ id: "boundary", enabled: true }], candidateRevision: 8 }),
};

const masksPath = path.join(__dirname, "..", "static", "js", "editor-masks.js");
const source = fs.readFileSync(masksPath, "utf8");
vm.runInNewContext(`${source}\nglobalThis.masksTest = { candidateDisplayMode, candidateDisplayIdsForRole, setCandidateDisplayMode, toggleCandidateDisplay, toggleCandidateEffective, clearCandidateBlink, clearCandidateMutationState, nextCandidateMutationVersion, paintStrokeOnContexts, paintFillSpans, applyFillSpans, enableManualLayerForTool, beginManualStroke, appendManualStrokePoint, completeManualStroke, cancelManualStroke, replayManualStroke, recordHistoryOperation, restoreSnapshot, buildCombinedMask, addBoundaryCandidate };\nrenderCandidates = globalThis.renderCandidates; render = globalThis.render;`, context, { filename: masksPath });
const test = context.masksTest;

assert.deepEqual([...test.candidateDisplayIdsForRole("apply")], ["apply", "manual:apply"]);
assert.deepEqual([...test.candidateDisplayIdsForRole("exclude")], ["exclude", "manual:exclude", "manual:excludeErase"]);
test.setCandidateDisplayMode(["apply", "manual:apply"], "normal");
assert.equal(test.candidateDisplayMode("apply"), "normal");
test.toggleCandidateEffective("apply");
assert.equal(test.candidateDisplayMode("apply"), "effective", "effective display replaces the normal candidate display");
test.toggleCandidateEffective("apply");
assert.equal(test.candidateDisplayMode("apply"), "off");
test.clearCandidateBlink();
assert.equal(state.blinkCandidateIds.size, 0);

test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "brush", 4);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "eraser", 4);
test.paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, { x: 1, y: 1 }, { x: 3, y: 3 }, "exclude_eraser", 4);
assert.ok(addCtx.calls.some((call) => call === "stroke:source-over"));
assert.ok(exclusionEraseCtx.calls.some((call) => call === "stroke:destination-out"));
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "bucket");
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "exclude_bucket");
test.paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, [2, 3, 7], "exclude_eraser");
assert.ok(events.includes("draft:add,exclusion"));
assert.ok(events.includes("draft:exclusion,exclusionErase"));
assert.ok(events.includes("draft:exclusionErase"));

state.tool = "brush";
test.beginManualStroke({ x: 4, y: 4 });
test.appendManualStrokePoint({ x: 8, y: 8 });
test.completeManualStroke();
assert.equal(state.history.length, 1, "a completed brush gesture is retained for undo");
assert.equal(state.manualMaskPresent, true);
test.recordHistoryOperation({ kind: "removeCandidates", ids: ["apply"] });
assert.equal(state.historyIndex, 2);
test.restoreSnapshot(1);
assert.equal(state.removedCandidateIds.has("apply"), false, "undo rebuilds the candidate deletion state");
test.restoreSnapshot(2);
assert.equal(state.removedCandidateIds.has("apply"), true, "redo replays the candidate deletion");
assert.equal(test.buildCombinedMask(), "data:image/png;base64,mask");

test.enableManualLayerForTool("exclude_eraser");
assert.equal(state.manualExclusionEraseEnabled, true);

(async () => {
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryDrafts.length, 0, "successful boundary detection consumes the submitted draft");
  assert.equal(state.images[0].candidateRevision, 8);
  assert.equal(state.images[0].candidateCount, 1);
  assert.ok(state.history.some((entry) => entry.kind === "addCandidates" && entry.ids.includes("boundary")));

  state.boundaryDrafts = [{ id: "failed", type: "rectangle", roi: { left: 3, top: 3, right: 9, bottom: 9 } }];
  context.api = async () => { throw new Error("boundary unavailable"); };
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryDrafts.length, 1, "failed boundary detection preserves the draft for retry");
  assert.ok(events.some((event) => event.startsWith("error:")));
  console.log("test_editor_masks_behavior: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
