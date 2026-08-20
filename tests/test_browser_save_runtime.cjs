const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "..", "static");
const manifest = fs.readFileSync(path.join(staticRoot, "js", "manifest.js"), "utf8");
const appPaths = [...manifest.matchAll(/"([a-z-]+\.js)"/g)].map((match) => path.join(staticRoot, "js", match[1]));

function element() {
  return {
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    classList: { toggle() {} },
    setAttribute() {},
    append() {},
    addEventListener() {},
  };
}

class FakeFileHandle {
  constructor(name, directory, options) {
    this.name = name;
    this.directory = directory;
    this.options = options;
    this.closed = false;
    this.written = null;
    this.lastModified = Date.now();
  }

  async getFile() {
    return { size: this.written?.byteLength || 0, lastModified: this.lastModified };
  }

  async createWritable(options) {
    this.options.createWritable?.(this, options);
    return {
      write: async (bytes) => { this.written = new Uint8Array(bytes); },
      close: async () => {
        this.closed = true;
        this.lastModified = Date.now();
        this.directory.files.set(this.name, this);
        await this.options.closed?.(this);
      },
      abort: async () => { this.options.aborted?.(this); },
    };
  }
}

class FakeDirectoryHandle {
  constructor(options = {}) {
    this.name = options.name || "output";
    this.options = options;
    this.files = new Map();
    this.directories = new Map();
    this.removed = [];
  }

  async getDirectoryHandle(name, { create } = {}) {
    if (!this.directories.has(name) && !create) {
      const error = new Error("missing directory");
      error.name = "NotFoundError";
      throw error;
    }
    if (!this.directories.has(name)) this.directories.set(name, new FakeDirectoryHandle(this.options));
    return this.directories.get(name);
  }

  async getFileHandle(name, { create } = {}) {
    if (this.files.has(name)) return this.files.get(name);
    if (!create) {
      const error = new Error("missing file");
      error.name = "NotFoundError";
      throw error;
    }
    const handle = new FakeFileHandle(name, this, this.options);
    this.options.reserve?.(name, handle);
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name) {
    this.removed.push(name);
    this.files.delete(name);
  }

  async queryPermission() { return "granted"; }
  async requestPermission() { return "granted"; }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function binaryResponse(bytes, saveToken = "runtime-render-token") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "X-Mozarie-Save-Token" ? saveToken : null },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    json: async () => ({}),
  };
}

function createRuntime({ commit, copy = null, directory, deleteOriginal = false, renderToken = "runtime-render-token", entries = null, initialImages = null, removeCatalog = null }) {
  const outputDirectory = directory instanceof FakeDirectoryHandle ? directory : new FakeDirectoryHandle({
    closed: async () => {
      const response = copy?.();
      if (response && !response.ok) throw new Error("write failed");
    },
  });
  const preparedEntries = entries || [{ imageId: "image-1", relativePath: "nested/source.png", candidateRevision: 7, deleteOriginal }];
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  getElement("#applyDivisor").value = "100";
  const canvas = getElement("#editorCanvas");
  canvas.getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {} });
  getElement("#canvasStage").clientWidth = 600;
  getElement("#canvasStage").clientHeight = 400;
  const galleryItem = () => {
    const item = element();
    const preview = element();
    const name = element();
    const meta = element();
    const badge = element();
    item.querySelector = (selector) => ({ img: preview, ".gallery-name": name, ".gallery-meta": meta, ".gallery-review-badge": badge }[selector]);
    item.remove = () => {};
    return item;
  };
  elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });

  const requests = [];
  const lockRequests = [];
  const document = {
    querySelector(selector) {
      if (selector === 'meta[name="mozarie-token"]') return { content: "runtime-test-token" };
      return getElement(selector);
    },
    querySelectorAll() { return []; },
    createElement(tag) {
      if (tag !== "canvas") return element();
      return {
        width: 1,
        height: 1,
        getContext: () => ({
          clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
      };
    },
  };
  const browserWindow = { devicePixelRatio: 1, addEventListener() {} };
  const context = {
    console,
    document,
    Date,
    Math,
    Promise,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Image: class {},
    URL: { createObjectURL() { return "blob:runtime-test"; }, revokeObjectURL() {} },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
    window: browserWindow,
    navigator: {
      locks: {
        async request(name, options, callback) {
          lockRequests.push({ name, options });
          return callback();
        },
      },
    },
    fetch: async (requestPath, options = {}) => {
      requests.push({ path: requestPath, options });
      if (requestPath === "/api/save/prepare") {
        return jsonResponse({ entries: preparedEntries });
      }
      if (requestPath === "/api/save/render") return binaryResponse([4, 5, 6], renderToken);
      if (requestPath === "/api/save/copy") return (copy || (() => jsonResponse({ output: "G:/output/source_censored.png" })))({ options, requests });
      if (requestPath === "/api/save/commit") return commit({ options, requests });
      if (requestPath === "/api/catalog/remove") return (removeCatalog || (() => jsonResponse({ images: [], removedImageIds: [] })))({ options, requests });
      throw new Error(`Unexpected request: ${requestPath}`);
    },
  };

  let source = appPaths.map((appPath) => fs.readFileSync(appPath, "utf8")).join("\n");
  source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__browserSaveRuntime = { state, ensureSaveSources, runBrowserSave, saveTargets, outputDirectoryForSave, chooseOutputDirectory };\n");
  vm.runInNewContext(source, context, { filename: "static/js/runtime.js" });
  const { state, ensureSaveSources, runBrowserSave, saveTargets, outputDirectoryForSave, chooseOutputDirectory } = context.__browserSaveRuntime;
  state.images = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  state.translations = {
    "apply.complete": "complete {completed}",
    "apply.completeWithStale": "stale {completed}/{stale}",
    "apply.cancelled": "cancelled {completed}",
    "apply.progress": "progress {completed}/{total}",
    "gallery.detectAll": "detect all",
  };
  return { directory: outputDirectory, elements, ensureSaveSources, lockRequests, requests, runBrowserSave: (target, ...args) => runBrowserSave(target instanceof FakeDirectoryHandle ? target : outputDirectory, ...args), saveTargets, outputDirectoryForSave, chooseOutputDirectory, state, window: browserWindow };
}

async function runSuccessCase() {
  const directory = "G:/output";
  let copyCompletedWhenCommitted = false;
  const runtime = createRuntime({
    directory,
    copy: () => { copyCompletedWhenCommitted = true; return jsonResponse({ output: "G:/output/nested/source_censored.png" }); },
    commit: () => {
      assert.equal(copyCompletedWhenCommitted, true, "commit runs after the copied output is saved");
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.lockRequests)), [{ name: "mozarie-output", options: { mode: "exclusive" } }]);
  const nested = runtime.directory.directories.get("nested");
  assert.deepEqual([...nested.files.get("source_censored.png").written], [4, 5, 6]);
  const commitPayload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(commitPayload.saveToken, "runtime-render-token");
  assert.equal(commitPayload.deleteOriginal, false);
  assert.equal(runtime.elements.get("#applyResult").textContent, "complete 1");
}

async function runStaleCommitCase() {
  const directory = new FakeDirectoryHandle();
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: false, stale: true, images: [] }) });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);

  assert.equal(runtime.elements.get("#applyResult").textContent, "stale 1/1");
}

async function runRemoveAfterSaveCase() {
  const directory = new FakeDirectoryHandle();
  const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    directory,
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), { imageIds: [image.id] });
      return jsonResponse({ images: [], removedImageIds: [image.id] });
    },
  });
  await runtime.runBrowserSave(directory, [image.id], "_censored", false, "copy", true);
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, []);
}

async function runRemoveAfterSaveAlreadyAbsentCase() {
  const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    directory: new FakeDirectoryHandle(),
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: true, images: [] }),
    removeCatalog: () => jsonResponse({ images: [], removedImageIds: [] }),
  });
  runtime.state.currentId = image.id;
  runtime.state.drafts.set(image.id, { add: "draft", exclusion: "" });

  await runtime.runBrowserSave(runtime.directory, [image.id], "_censored", true, "copy", true);

  assert.equal(runtime.state.drafts.has(image.id), false, "already-removed source entries still clear browser drafts");
  assert.equal(runtime.state.currentId, null, "already-removed current entries leave no stale selection");
}

async function runRemoveAfterSavePartialAndStaleCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let commits = 0;
  const runtime = createRuntime({
    directory: new FakeDirectoryHandle(),
    initialImages: [first, second],
    entries: [
      { imageId: first.id, relativePath: first.relativePath, candidateRevision: 1, deleteOriginal: false },
      { imageId: second.id, relativePath: second.relativePath, candidateRevision: 1, deleteOriginal: false },
    ],
    commit: () => {
      commits += 1;
      return commits === 1
        ? jsonResponse({ cleared: true, stale: false, images: [second] })
        : jsonResponse({ error: "second commit failed" }, 500);
    },
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), { imageIds: [first.id] });
      return jsonResponse({ images: [second], removedImageIds: [first.id] });
    },
  });
  await assert.rejects(runtime.runBrowserSave(runtime.directory, [first.id, second.id], "_censored", false, "copy", true), /second commit failed/);
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, [second]);

  const stale = createRuntime({
    directory: new FakeDirectoryHandle(),
    initialImages: [first],
    commit: () => jsonResponse({ cleared: false, stale: true, images: [first] }),
  });
  await stale.runBrowserSave(stale.directory, [first.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves must remain in the catalog");
}

async function runCopyFailureCase() {
  const directory = "G:/output";
  const runtime = createRuntime({ directory, copy: () => jsonResponse({ error: "write failed" }, 500), commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  await assert.rejects(runtime.runBrowserSave(directory, ["image-1"], "_censored", false), /write failed/);
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render"]);
  assert.deepEqual(runtime.directory.directories.get("nested").removed, ["source_censored.png"]);
}

async function runOutputDirectoryReuseCase() {
  const runtime = createRuntime({ directory: new FakeDirectoryHandle({ name: "remembered" }), commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.outputDirectoryHandle = runtime.directory;
  assert.equal(await runtime.outputDirectoryForSave(), runtime.directory);
  assert.equal(runtime.requests.length, 0, "a remembered browser handle is reused without a server picker request");
}

async function runCommitFailureCase() {
  const directory = new FakeDirectoryHandle();
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ error: "commit failed" }, 500) });
  await assert.rejects(runtime.runBrowserSave(directory, ["image-1"], "_censored", false), /commit failed/);

  assert.equal(runtime.state.images.length, 1);
  const paths = runtime.requests.map((request) => request.path);
  assert.deepEqual(paths.slice(0, 2), ["/api/save/prepare", "/api/save/render"]);
  assert.equal(paths.filter((path) => path === "/api/save/commit").length, 12);
}

async function runCancelCase() {
  let runtime;
  const directory = "G:/output";
  runtime = createRuntime({
    directory,
    copy: () => { runtime.state.browserSave.cancelled = true; return jsonResponse({ output: "G:/output/source_censored.png" }); },
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), { imageIds: ["image-1"] });
      return jsonResponse({ images: [], removedImageIds: ["image-1"] });
    },
  });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false, "copy", true);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit", "/api/catalog/remove"]);
  assert.equal(runtime.elements.get("#applyResult").textContent, "cancelled 1");
}

async function runDeleteOriginalCase() {
  const directory = new FakeDirectoryHandle();
  const runtime = createRuntime({
    directory,
    deleteOriginal: true,
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", true);

  const payload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(payload.deleteOriginal, true);
  assert.equal(payload.saveToken, "runtime-render-token");
  assert.equal(payload.sourceAction, "deleted");
}

async function runHandleOverwriteCase() {
  const directory = new FakeDirectoryHandle();
  let written = null;
  const sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return { async write(bytes) { written = [...new Uint8Array(bytes)]; }, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
  await runtime.runBrowserSave(null, ["image-1"], "_censored", false, "overwrite");
  assert.deepEqual(written, [4, 5, 6]);
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "overwrite");
}

async function runRepeatedHandleOverwriteCase() {
  const image = { id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  let writes = 0;
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return {
        async write() {},
        async close() { writes += 1; sourceFile = { name: "source.png", size: 3, lastModified: 34 + writes }; },
        async abort() {},
      };
    },
  };
  const runtime = createRuntime({ initialImages: [image], commit: () => jsonResponse({ cleared: false, stale: false, images: [image] }) });
  const access = { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified };
  runtime.state.sourceAccess.set(image.id, access);

  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave(null, [image.id], "_censored", false, "overwrite");
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave(null, [image.id], "_censored", false, "overwrite");
  assert.equal(writes, 2);
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
}

async function runHandleDeleteAfterCopyCase() {
  const directory = new FakeDirectoryHandle();
  let removed = false;
  const sourceHandle = { name: "source.png", async remove() { removed = true; } };
  const runtime = createRuntime({ directory, deleteOriginal: true, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceHandle.name, size: 1, lastModified: 1 });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", true);
  assert.equal(removed, true, "the source handle is removed only after the copy has been written");
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "deleted");
}

async function runForeignCollisionCase() {
  const directory = "G:/output";
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);
  const nested = runtime.directory.directories.get("nested");
  assert.ok(nested.files.has("source_censored.png"));
}

async function runPartialCommitFailureReconcileCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  const exclusionOnly = { id: "image-3", relativePath: "nested/exclusion-only.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let commitCount = 0;
  const runtime = createRuntime({
    directory: new FakeDirectoryHandle(),
    deleteOriginal: true,
    entries: [
      { imageId: first.id, relativePath: first.relativePath, candidateRevision: 7, deleteOriginal: true },
      { imageId: second.id, relativePath: second.relativePath, candidateRevision: 8, deleteOriginal: true },
    ],
    initialImages: [first, second, exclusionOnly],
    commit: () => {
      commitCount += 1;
      if (commitCount === 1) return jsonResponse({ cleared: true, stale: false, images: [second, exclusionOnly] });
      return jsonResponse({ error: "second commit failed" }, 500);
    },
  });
  runtime.state.currentId = first.id;
  runtime.state.currentImage = { width: first.width, height: first.height };
  runtime.state.candidates = [{ id: "first-candidate", enabled: true }];
  runtime.state.candidateImages = new Map([["first-candidate", {}]]);
  runtime.state.drafts = new Map([
    [first.id, { add: "data:image/png;base64,test", exclusion: "", manualVisible: true }],
    [second.id, { add: "data:image/png;base64,test", exclusion: "", manualEnabled: true, manualVisible: true }],
    [exclusionOnly.id, { add: "", exclusion: "data:image/png;base64,test", visibleCandidateIds: [] }],
  ]);
  runtime.state.galleryFilter = "masked";
  runtime.state.maskStatus.set(first.id, true);
  runtime.state.maskStatus.set(second.id, false);
  runtime.state.maskStatus.set(exclusionOnly.id, true);

  await assert.rejects(runtime.runBrowserSave(runtime.directory, [first.id, second.id], "_censored", true), /second commit failed/);

  assert.deepEqual(Array.from(runtime.state.images, (image) => image.id), [second.id, exclusionOnly.id]);
  assert.equal(runtime.state.drafts.has(first.id), false);
  assert.equal(runtime.state.currentId, null);
  assert.equal(runtime.state.currentImage, null);
  assert.equal(runtime.state.candidates.length, 0);
  assert.equal(runtime.state.candidateImages.size, 0);
  assert.equal(runtime.state.maskStatus.get(second.id), true, "an add-only draft remains a save target after partial failure");
  assert.equal(runtime.state.maskStatus.get(exclusionOnly.id), false, "an exclusion-only draft is not a save target");
  assert.deepEqual(Array.from(runtime.saveTargets()), [second.id]);
  assert.equal(runtime.state.galleryNodes.has(first.id), false);
  assert.equal(runtime.state.galleryNodes.has(second.id), true, "the masked gallery renders the remaining add-only draft");
  assert.equal(runtime.state.galleryNodes.has(exclusionOnly.id), false, "the masked gallery excludes an exclusion-only draft");
}

async function runRemoveAfterSaveCases() {
  const saved = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const retained = { id: "image-2", relativePath: "nested/retained.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let removalPayload = null;
  const enabled = createRuntime({
    directory: new FakeDirectoryHandle(), initialImages: [saved, retained],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved, retained] }),
    removeCatalog: ({ options }) => {
      removalPayload = JSON.parse(options.body);
      return jsonResponse({ images: [retained], removedImageIds: [saved.id] });
    },
  });
  await enabled.runBrowserSave(enabled.directory, [saved.id], "_censored", false, "copy", true);
  assert.deepEqual(removalPayload, { imageIds: [saved.id] }, "only completed and committed images are removed after save");
  assert.deepEqual(enabled.state.images.map((image) => image.id), [retained.id]);

  const disabled = createRuntime({
    directory: new FakeDirectoryHandle(), initialImages: [saved],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved] }),
  });
  await disabled.runBrowserSave(disabled.directory, [saved.id], "_censored", false, "copy", false);
  assert.equal(disabled.requests.some((request) => request.path === "/api/catalog/remove"), false, "unchecked removal leaves the catalog unchanged");

  const stale = createRuntime({
    directory: new FakeDirectoryHandle(), initialImages: [saved],
    commit: () => jsonResponse({ cleared: false, stale: true, deleted: false, images: [saved] }),
  });
  await stale.runBrowserSave(stale.directory, [saved.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves remain in the catalog");
}

(async () => {
  await runSuccessCase();
  await runStaleCommitCase();
  await runRemoveAfterSaveCase();
  await runRemoveAfterSaveAlreadyAbsentCase();
  await runRemoveAfterSavePartialAndStaleCase();
  await runCopyFailureCase();
  await runCommitFailureCase();
  await runCancelCase();
  await runDeleteOriginalCase();
  await runHandleOverwriteCase();
  await runRepeatedHandleOverwriteCase();
  await runHandleDeleteAfterCopyCase();
  await runForeignCollisionCase();
  await runPartialCommitFailureReconcileCase();
  await runOutputDirectoryReuseCase();
  await runRemoveAfterSaveCases();
  console.log("test_browser_save_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
