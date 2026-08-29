const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "static", "js");

async function testDetectionWaitsForDraft() {
  const events = [];
  const validation = { id: "detectionTargetValidation", textContent: "", hidden: true };
  const state = { detectionStarting: false, importing: false, detectionTargetIds: [], detectCancelRequested: false, job: null };
  const context = {
    state, Math, Promise,
    $: () => validation,
    isBusy: () => false,
    saveDraft: async () => { events.push("draft"); },
    api: async () => { events.push("detect"); return { ok: true }; },
    updateActionButtons() {}, showProcessing() {}, updateProgress() {}, setStatusKey() {}, setStatus() {},
    t: (key) => key,
  };
  vm.runInNewContext(
    `${fs.readFileSync(path.join(root, "detection.js"), "utf8")}\nglobalThis.runDetectionForTest=runDetection;`,
    context,
  );
  await context.runDetectionForTest(["image"], 0.5, 1, ["penis"]);
  assert.deepEqual(events, ["draft", "detect"], "manual layers are captured before detection starts");
}

async function testCompletionInvalidatesAndReloadsCandidates() {
  const oldRecord = { id: "image", candidateRevision: 1 };
  const newRecord = { id: "image", candidateRevision: 2 };
  const events = [];
  const state = {
    images: [oldRecord], currentId: "image", imageGeneration: 0, catalogEpoch: 4,
    maskStatus: new Map(), detectionTargetIds: ["image"], drafts: new Map(),
    handledDetectionStartedAt: null, detectCancelRequested: false,
  };
  const context = {
    state, Array, Number, Promise, Map,
    modalInvokers: new Map(),
    $: () => ({}),
    api: async () => ({ images: [newRecord] }),
    isCurrentGeneration: () => true, isCurrentCatalogEpoch: () => true,
    pruneSourceAccess() {},
    releaseCandidateBundles: (id) => events.push(["release", id]),
    markImagesUnreviewed() {}, closeProcessing() {}, renderCatalogViews() {},
    selectImage: async (...args) => events.push(["select", ...args]),
  };
  vm.runInNewContext(
    `${fs.readFileSync(path.join(root, "save.js"), "utf8")}\nglobalThis.finishDetectionForTest=finishDetectionJob;`,
    context,
  );
  await context.finishDetectionForTest({
    kind: "detect", state: "complete", startedAt: 10, imageIds: ["image"], completedImageIds: ["image"],
  });
  assert.equal(state.images[0], newRecord, "the reconciled catalog revision becomes authoritative");
  assert.deepEqual(events[0], ["release", "image"], "the old candidate bitmap bundle is invalidated");
  assert.equal(events[1][0], "select");
  assert.equal(events[1][1], "image");
  assert.equal(events[1][2], true);
  assert.equal(
    events[1][3].saveCurrentDraft, false,
    "the current image reloads without writing old candidates under the new revision",
  );
}

Promise.resolve()
  .then(testDetectionWaitsForDraft)
  .then(testCompletionInvalidatesAndReloadsCandidates)
  .then(() => console.log("test_detection_refresh_runtime: passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
