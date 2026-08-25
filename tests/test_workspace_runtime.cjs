const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "workspace.js"), "utf8");
const calls = [];
let rejectFirst = false;
const state = {
  images: [{ id: "one" }], drafts: new Map(), workspacePersistence: true, workspaceApiAvailable: true,
  workspaceDraftChains: new Map(), workspaceDraftTimers: new Map(), workspaceMutationErrors: new Map(), draftSaveChains: new Map(),
  currentId: null, maskDirty: false,
};
const context = {
  state, Map, Set, Promise, Object, Number, encodeURIComponent, window: {}, indexedDB: undefined,
  clearTimeout, setTimeout,
  setStatus() {}, saveDraft() {},
  api(url, options = {}) {
    calls.push([url, options.method]);
    if (rejectFirst) { rejectFirst = false; return Promise.reject(new Error("write failed")); }
    return Promise.resolve({});
  },
};
vm.runInNewContext(`${source}\nglobalThis.workspaceTest={queueWorkspaceDraft,flushAllWorkspaceMutations,queueWorkspaceMutation,workspaceDraftPayload};`, context);

(async () => {
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true });
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  assert.deepEqual(calls.map(([, method]) => method), ["DELETE", "POST"], "draft snapshots choose DELETE or POST at enqueue time");

  calls.length = 0; state.drafts.set("one", { add: "data:image/png;base64,a", hasEffectiveMask: true }); rejectFirst = true;
  const failed = context.workspaceTest.queueWorkspaceDraft("one", true);
  state.drafts.delete("one");
  await context.workspaceTest.queueWorkspaceDraft("one", true);
  await assert.rejects(failed, /write failed/);
  await assert.rejects(context.workspaceTest.flushAllWorkspaceMutations(), /write failed/, "a recovered later DELETE does not hide the earlier write failure");
  assert.deepEqual(calls.map(([, method]) => method), ["POST", "DELETE"], "a later DELETE still runs after a rejected POST");

  let releaseDraft;
  state.currentId = "one"; state.maskDirty = true; state.workspaceDraftChains.clear(); state.workspaceMutationErrors.clear();
  context.saveDraft = () => new Promise((resolve) => { releaseDraft = () => { state.maskDirty = false; resolve(); }; });
  const transition = context.workspaceTest.flushAllWorkspaceMutations().then(() => context.api("/api/catalog/clear", { method: "POST" }));
  await Promise.resolve();
  assert.equal(calls.some(([url]) => url === "/api/catalog/clear"), false, "a dirty draft blocks its catalog transition until encoded");
  releaseDraft(); await transition;
  assert.equal(calls.some(([url]) => url === "/api/catalog/clear"), true, "the transition starts after the dirty draft resolves");

  state.currentId = "one"; state.maskDirty = true;
  context.saveDraft = () => Promise.reject(new Error("encode failed"));
  let switched = false;
  await assert.rejects(context.workspaceTest.flushAllWorkspaceMutations().then(() => { switched = true; }), /encode failed/);
  assert.equal(switched, false, "a rejected draft encoder prevents the transition");
  console.log("test_workspace_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
