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
    children: [], dataset: {}, listeners: new Map(), classList: { toggle() {}, remove() {} }, setAttribute() {},
    addEventListener(name, callback) { this.listeners.set(name, callback); },
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

let latestFillWorker = null;
class FillWorker {
  constructor(url) { this.url = url; latestFillWorker = this; }
  postMessage(payload, transfers) { this.payload = payload; this.transfers = transfers; }
  terminate() { this.terminated = true; }
}

const context = {
  state, Math, Number, String, Boolean, Array, Map, Set, Promise, JSON, Uint8ClampedArray, encodeURIComponent, Worker: FillWorker,
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
  imageAssetVersion: (record) => record?.assetVersion || "", imageHasMask: () => true, canvasHasPixels: (ctx) => ctx.pixels,
  t: (key) => key, confirmationRequired: () => false, confirmAction: async () => true,
  markMaskDirty: () => events.push("dirty"), markDraftDirty: (...layers) => events.push(`draft:${layers.join(",")}`),
  flushMaskComposition: () => events.push("flush"), requestMosaicPreview: () => events.push("preview"), scheduleManualWorkspaceSave: () => events.push("save"), saveDraft: () => events.push("draft-save"),
  setReviewed: () => events.push("review"), updateHistoryButtons() {}, updateCandidateStatus() {}, refreshCurrentReviewAndMask() {}, refreshMaskStatus() {},
  renderCandidates: () => events.push("candidates"), render: () => events.push("render"), renderCatalogViews: () => events.push("catalog"), updateActionButtons() {},
  updateCandidateBatchButtons() {},
  syncCurrentCandidateRecord() {}, syncCandidateRecord() {}, retainCurrentCandidateBundle() {}, refreshCandidateRecord: async () => {}, reconcileCurrentCandidates: async () => true,
  releaseCandidateBitmap() {}, releaseCandidateBundles() {}, invalidateCandidateBundles: () => events.push("invalidate"), markImagesUnreviewed: () => events.push("unreview"),
  clearBoundaryInteraction: () => events.push("boundary-clear"), updateBoundaryActions() {}, setStatusKey: () => events.push("status"), showUserError: (error) => events.push(`error:${error}`),
  canDetectBoundary: () => true,
  boundaryRequests: () => [{ draft: state.boundaryDrafts[0], draftIds: ["draft"] }], pointForRoi: (roi) => ({ x: roi.left + 1, y: roi.top + 1 }),
  api: async () => ({ candidates: [{ id: "boundary", enabled: true }], candidateRevision: 8 }),
};

const masksPath = path.join(__dirname, "..", "static", "js", "editor-masks.js");
const source = fs.readFileSync(masksPath, "utf8");
vm.runInNewContext(`${source}\nglobalThis.masksTest = { renderCandidateRows: renderCandidates, candidateDisplayMode, candidateDisplayIdsForRole, setCandidateDisplayMode, toggleCandidateDisplay, toggleCandidateEffective, clearCandidateBlink, clearCandidateMutationState, nextCandidateMutationVersion, enqueueCandidateMutation, waitForCandidateMutations, updateCandidate, deleteCandidate, deleteManualMask, deleteManualExclusion, deleteManualExclusionErase, shouldBlinkNewManual, batchCandidateOperation, paintStrokeOnContexts, paintFillSpans, applyFillSpans, enableManualLayerForTool, beginManualStroke, appendManualStrokePoint, completeManualStroke, cancelManualStroke, replayManualStroke, recordHistoryOperation, resetHistoryToCurrentManualMask, restoreSnapshot, buildCombinedMask, addBoundaryCandidate, cancelBoundary, completedPolygonVertexAt, fillAt };\nrenderCandidates = globalThis.renderCandidates; render = globalThis.render;`, context, { filename: masksPath });
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

  // Candidate mutations are optimistic, ordered per image, and must restore the
  // visible aggregate when the server cannot accept the change.
  const resetCandidateState = () => {
    state.currentId = "image"; state.imageGeneration = 2; state.importing = false;
    state.candidates = [
      { id: "apply", role: "apply", enabled: true, confidence: 0.8, className: "target", color: "#fff" },
      { id: "exclude", role: "exclude", enabled: true, forced: true, className: "keep", color: "#000" },
    ];
    state.removedCandidateIds = new Set(); state.candidateUpdateChains = new Map(); state.candidateUpdateVersions = new Map();
    state.candidateDeleting = new Set(); state.candidateBatchPending = new Set(); state.maskStatus = new Map([["image", true]]);
    state.manualMaskPresent = true; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
    addCtx.pixels = true; exclusionCtx.pixels = true; exclusionEraseCtx.pixels = true;
    state.images = [{ id: "image", assetVersion: "a", candidateRevision: 4, candidateCount: 2, enabledCandidateCount: 1 }];
    state.history = []; state.historyIndex = 0; state.historyRemovedCandidateIds = new Set(); state.historyCandidateIds = new Set(["apply", "exclude"]);
    context.confirmationRequired = () => false; context.confirmAction = async () => true;
    context.isBusy = () => false; context.reconcileCurrentCandidates = async () => false;
  };

  resetCandidateState();
  test.renderCandidateRows();
  const candidateCalls = [];
  let retainedRevision = null;
  context.retainCurrentCandidateBundle = (_imageId, revision) => { retainedRevision = revision; };
  context.api = async (path, options) => {
    candidateCalls.push({ path, body: JSON.parse(options.body) });
    return { candidateRevision: 9 };
  };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.deepEqual(candidateCalls, [{ path: "/api/candidate/image/apply", body: { enabled: false, color: "#fff" } }], "a candidate toggle persists its requested enabled state");
  assert.equal(retainedRevision, 9, "a successful mutation retains the returned candidate revision");

  resetCandidateState();
  let staleRefreshes = 0;
  context.refreshCandidateRecord = async () => { staleRefreshes += 1; };
  context.api = async () => { state.currentId = "other"; return { candidateRevision: 10 }; };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(staleRefreshes, 1, "a completed mutation for an image left behind refreshes only its catalog record");

  resetCandidateState();
  let rollback = null;
  context.syncCandidateRecord = (imageId, candidates) => { rollback = { imageId, enabled: candidates[0].enabled }; };
  context.api = async () => { throw new Error("candidate unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, false);
  assert.deepEqual(rollback, { imageId: "image", enabled: true }, "a rejected mutation restores the optimistic candidate state");
  assert.equal(state.maskStatus.get("image"), false, "a rejected mutation restores the prior mask aggregate");

  resetCandidateState();
  context.confirmationRequired = (key) => key === "candidateDelete";
  await test.deleteCandidate(state.candidates[0]);
  assert.equal(state.removedCandidateIds.has("apply"), true, "a confirmed candidate removal is stored in undo history");
  await test.deleteManualMask(); await test.deleteManualExclusion(); await test.deleteManualExclusionErase();
  assert.deepEqual([state.manualMaskPresent, addCtx.pixels, exclusionCtx.pixels, exclusionEraseCtx.pixels], [false, false, false, false], "manual add and exclusion layers are cleared independently");

  resetCandidateState();
  const batchCalls = [];
  context.api = async (path, options) => {
    batchCalls.push({ path, body: JSON.parse(options.body) });
    return { candidateRevision: 11 };
  };
  await test.batchCandidateOperation("apply:toggle");
  await test.batchCandidateOperation("exclude:toggle");
  assert.deepEqual(batchCalls.map(({ path, body }) => ({ path, operation: body.operation })), [
    { path: "/api/candidates/batch", operation: "disable" },
    { path: "/api/candidates/batch", operation: "disable" },
  ], "batch toggles derive a disable operation only when every affected layer is enabled");
  assert.deepEqual([state.candidates[0].enabled, state.candidates[1].enabled, state.manualEnabled, state.manualExclusionEnabled, state.manualExclusionEraseEnabled], [false, false, false, false, false], "batch toggles keep automatic and manual layers in sync");

  resetCandidateState();
  context.confirmationRequired = (key) => key === "candidateRoleDelete";
  await test.batchCandidateOperation("exclude:delete");
  assert.equal(state.removedCandidateIds.has("exclude"), true, "a confirmed role deletion is local and undoable");
  resetCandidateState();
  context.api = async () => { throw new Error("batch unavailable"); };
  await test.batchCandidateOperation("apply:enable");
  assert.equal(state.candidateBatchPending.size, 0, "a failed batch mutation always clears its pending state");

  resetCandidateState();
  const boundaryBodies = [];
  state.boundaryDrafts = [
    { id: "polygon", type: "polygon", points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }] },
    { id: "point", type: "point", roi: { left: 2, top: 2, right: 6, bottom: 6 }, point: { x: 3, y: 3 } },
  ];
  context.boundaryRequests = () => [
    { draft: state.boundaryDrafts[0], draftIds: ["polygon"] },
    { draft: state.boundaryDrafts[1], draftIds: ["point"] },
  ];
  context.api = async (_path, options) => {
    boundaryBodies.push(JSON.parse(options.body));
    return boundaryBodies.length === 1 ? { candidates: [{ id: "polygon-result", enabled: true, role: "apply" }], candidateRevision: 12 } : { candidates: [], candidateRevision: 13 };
  };
  await test.addBoundaryCandidate();
  assert.deepEqual(boundaryBodies[0], { imageId: "image", points: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }] }, "polygon boundary detection sends immutable point coordinates");
  assert.deepEqual(boundaryBodies[1], { imageId: "image", roi: { left: 2, top: 2, right: 6, bottom: 6 }, point: { x: 3, y: 3 } }, "point boundary detection sends its explicit prompt");
  assert.equal(state.boundaryDrafts.length, 1, "an invalid boundary response keeps only the failed draft for retry");

  resetCandidateState();
  state.currentImage = null; test.resetHistoryToCurrentManualMask();
  assert.equal(state.history.length, 0, "history reset is a no-op without an active image");
  state.currentImage = { width: 100, height: 80 }; test.resetHistoryToCurrentManualMask();
  test.replayManualStroke({ kind: "restoreCandidates", ids: ["apply"] });
  test.replayManualStroke({ kind: "addCandidates", ids: ["exclude"] });
  test.replayManualStroke({ kind: "clearManual", role: "excludeErase" });
  test.replayManualStroke({ tool: "brush", size: 3, points: [] });
  for (const operation of [
    { kind: "removeCandidates", ids: ["apply"] },
    { kind: "restoreCandidates", ids: ["apply"] },
    { kind: "addCandidates", ids: ["new"] },
  ]) {
    for (let index = 0; index < 5; index += 1) test.recordHistoryOperation(operation);
  }
  assert.equal(state.history.length, 12, "history trimming retains the newest twelve operations");
  assert.equal(state.historyBaseDirty, true, "trimmed operations become part of the immutable history base");
  state.importing = true; test.restoreSnapshot(0); assert.equal(state.historyIndex, 12, "history restoration is blocked while importing");
  state.importing = false; test.restoreSnapshot(0); assert.equal(state.historyIndex, 0, "history restoration rebuilds the active image state");

  // Exercise the actual controls rendered for manual and detected masks.  The
  // controls are deliberately tested through their click listeners because the
  // UI keeps its optimistic state locally before each persistence request.
  const resetLists = () => {
    element("#candidateList").children = [];
    element("#exclusionList").children = [];
  };
  const row = (list, className) => list.children.find((item) => item.className?.includes(className));
  const control = (candidateRow, className) => candidateRow.children.find((item) => item.className === className);
  const click = async (button) => button.listeners.get("click")();

  resetCandidateState(); resetLists();
  context.api = async () => ({ candidateRevision: 14 });
  test.renderCandidateRows();
  const applyList = element("#candidateList");
  const excludeList = element("#exclusionList");
  await click(control(row(applyList, "candidate-row-manual-apply"), "candidate-toggle"));
  assert.equal(state.manualEnabled, false, "manual apply can be disabled from its row");
  await click(control(row(excludeList, "candidate-row-manual-exclude"), "candidate-forced"));
  assert.equal(state.manualExclusionForced, true, "manual exclusion force can be toggled from its row");
  await click(control(row(excludeList, "candidate-row-manual-exclude-erase"), "candidate-toggle"));
  assert.equal(state.manualExclusionEraseEnabled, false, "manual exclusion erase can be disabled from its row");
  await click(control(row(applyList, "candidate-row-apply"), "candidate-toggle"));
  assert.equal(state.candidates[0].enabled, false, "detected apply candidates persist their local toggle");
  await click(control(row(excludeList, "candidate-row-exclude"), "candidate-forced"));
  assert.equal(state.candidates[1].forced, false, "detected exclusion candidates persist their force toggle");

  test.toggleCandidateDisplay("apply");
  assert.equal(test.candidateDisplayMode("apply"), "normal", "showing every apply mask uses normal display mode");
  test.toggleCandidateDisplay("apply");
  assert.equal(test.candidateDisplayMode("apply"), "off", "a second show action hides every apply mask");
  state.candidateUpdateVersions.set("image:apply", 1); state.candidateDeleting.add("image:apply"); state.candidateBatchPending.add("image");
  test.clearCandidateMutationState("image");
  assert.equal(state.candidateUpdateVersions.size, 0, "clearing an image removes its mutation versions");
  await test.enqueueCandidateMutation("image", async () => {});
  await test.waitForCandidateMutations();
  assert.equal(state.candidateUpdateChains.size, 0, "waiting for mutations leaves no outstanding image chain");

  // A response that has already been reconciled must keep the server result;
  // a failed reconciliation must still restore the locally visible candidate.
  resetCandidateState(); context.api = async () => { throw new Error("offline"); };
  context.reconcileCurrentCandidates = async () => true;
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, false, "a reconciled failed mutation keeps the reconciled candidate state");
  resetCandidateState(); context.reconcileCurrentCandidates = async () => { throw new Error("reconcile unavailable"); };
  state.candidates[0].enabled = false;
  await test.updateCandidate(state.candidates[0], true, true);
  assert.equal(state.candidates[0].enabled, true, "an unreconciled failed mutation restores the prior candidate state");

  // Batch operations must refresh only the catalogue record when navigation
  // moves to another image while the request is in flight.
  resetCandidateState(); let staleBatchRefreshes = 0;
  context.refreshCandidateRecord = async () => { staleBatchRefreshes += 1; };
  context.api = async () => { state.currentId = "other"; return { candidateRevision: 15 }; };
  await test.batchCandidateOperation("apply:enable");
  assert.equal(staleBatchRefreshes, 1, "a stale batch response refreshes its original image record");

  // Boundary post-processing errors are user-visible but always release the
  // pending state.  This is distinct from an individual request failure.
  resetCandidateState();
  state.boundaryDrafts = [{ id: "catch", type: "rectangle", roi: { left: 1, top: 1, right: 5, bottom: 5 } }];
  context.boundaryRequests = () => [{ draft: state.boundaryDrafts[0], draftIds: ["catch"] }];
  context.api = async () => ({ candidates: [{ id: "catch-result", enabled: true, role: "apply" }], candidateRevision: 16 });
  context.reconcileCurrentCandidates = async () => { throw new Error("post-process unavailable"); };
  await test.addBoundaryCandidate();
  assert.equal(state.boundaryPending, false, "boundary failure after a response clears the pending state");

  // The bucket tool runs through the worker result path, which records an
  // undoable fill and schedules the same persistence path as a brush stroke.
  resetCandidateState(); state.currentImage = { width: 100, height: 80 }; state.manualExclusionForced = false;
  test.fillAt({ x: -10, y: 400 }, "bucket");
  assert.equal(latestFillWorker.url, "/js/flood-fill-worker.js", "bucket fill uses the flood-fill worker");
  assert.deepEqual([latestFillWorker.payload.x, latestFillWorker.payload.y], [0, 79], "bucket fill clamps the requested pixel to image bounds");
  latestFillWorker.onmessage({ data: { spans: [2, 3, 7] } });
  assert.equal(state.fillPending, false, "worker completion clears the pending fill flag");
  assert.equal(state.history.at(-1).tool, "bucket", "worker completion adds an undoable bucket operation");
  test.fillAt({ x: 4, y: 4 }, "bucket");
  latestFillWorker.onerror();
  assert.equal(state.fillPending, false, "worker errors clear the pending fill flag without retaining a worker");

  state.activeStroke = { tool: "brush", points: [{ x: 1, y: 1 }] };
  test.cancelManualStroke();
  assert.equal(state.activeStroke, null, "cancelling an in-progress stroke restores the history-backed mask");
  test.cancelBoundary();
  assert.ok(events.includes("boundary-clear"), "cancelling boundary editing clears the active boundary interaction");
  state.boundaryDrafts = [];
  assert.equal(test.completedPolygonVertexAt({ x: 1, y: 1 }), null, "a point outside completed polygons has no editable vertex");

  // The empty-state rows are meaningful UI states, not just rendering fallbacks.
  resetLists(); state.candidates = []; state.manualMaskPresent = false; exclusionCtx.pixels = false; exclusionEraseCtx.pixels = false;
  test.renderCandidateRows();
  assert.equal(element("#candidateList").children[0].textContent, "candidates.none", "an empty apply list explains that no masks are available");
  resetLists(); state.manualMaskPresent = true;
  test.renderCandidateRows();
  assert.equal(element("#exclusionList").children[0].textContent, "candidates.none", "an empty exclusion list remains explicit when only apply masks exist");
  console.log("test_editor_masks_behavior: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
