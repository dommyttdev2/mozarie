const assert = require("node:assert/strict"); const fs = require("node:fs"); const path = require("node:path"); const vm = require("node:vm");
const record = { id: "image", assetVersion: "v1", candidateRevision: 4 }; const state = { images: [record], currentId: "image", pendingImageId: null, candidateImages: new Map(), catalogEpoch: 1, catalogLoadControllers: new Set(), candidateInflight: new Map(), imageInflight: new Map(), prefetchQueue: [], prefetchTimer: null, prefetchActive: 0 };
let apiResult; let bitmapLoader;
const context = { state, Map, Set, Math, Promise, AbortController, DOMException, setTimeout, clearTimeout, document: { querySelector() { return null; } }, encodeURIComponent, api: async () => apiResult, isCurrentGeneration: () => true, catalogRecordMatches: (current, epoch, { version, revision } = {}) => epoch === state.catalogEpoch && current === record && record.assetVersion === version && (revision == null || record.candidateRevision === revision) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "resources.js"), "utf8"), context); vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, "..", "static", "js", "editor-canvas.js"), "utf8")}\nglobalThis.loadCandidateBundle = loadCandidateBundle;`, context); context.fetchBitmap = (...args) => bitmapLoader(...args);

(async () => {
  let decodes = 0; apiResult = { candidates: [{ id: "stale" }], candidateRevision: 5 }; bitmapLoader = async () => { decodes += 1; return { close() {} }; };
  record.candidateRevision = 4; const changed = context.loadCandidateBundle("image", 1); record.candidateRevision = 5;
  await changed; assert.equal(decodes, 1, "metadata is authoritative when candidate revision changes"); assert.equal(state.catalogLoadControllers.size, 0, "request unregisters its controller"); state.candidateBundleCache.clear();
  let closed = 0; record.candidateRevision = 4; apiResult = { candidates: [{ id: "kept" }, { id: "broken" }], candidateRevision: 5 };
  bitmapLoader = async (source) => { if (source.includes("broken")) throw new Error("decode failed"); return { width: 1, height: 1, close() { closed += 1; } }; };
  await assert.rejects(context.loadCandidateBundle("image", 1), /decode failed/); assert.equal(closed, 1, "a failed mask decode closes accumulated decoded masks exactly once"); assert.equal(state.catalogLoadControllers.size, 0, "failed request unregisters its controller"); console.log("test_candidate_bundle: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
