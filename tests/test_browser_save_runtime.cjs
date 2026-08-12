const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = path.join(__dirname, "..", "static", "app.js");

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
        this.options.closed?.(this);
      },
      abort: async () => { this.options.aborted?.(this); },
    };
  }
}

class FakeDirectoryHandle {
  constructor(options = {}) {
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
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function binaryResponse(bytes, saveToken = "runtime-render-token") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "X-Lets-Censoring-Save-Token" ? saveToken : null },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    json: async () => ({}),
  };
}

function createRuntime({ commit, directory, deleteOriginal = false, renderToken = "runtime-render-token", entries = null, initialImages = null }) {
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
      if (selector === 'meta[name="lets-censoring-token"]') return { content: "runtime-test-token" };
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
    window: { devicePixelRatio: 1, addEventListener() {} },
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
      if (requestPath === "/api/save/commit") return commit({ options, requests });
      throw new Error(`Unexpected request: ${requestPath}`);
    },
  };

  let source = fs.readFileSync(appPath, "utf8");
  source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__browserSaveRuntime = { state, ensureSaveSources, runBrowserSave, saveTargets };\n");
  vm.runInNewContext(source, context, { filename: "static/app.js" });
  const { state, ensureSaveSources, runBrowserSave, saveTargets } = context.__browserSaveRuntime;
  state.images = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  state.translations = {
    "apply.complete": "complete {completed}",
    "apply.completeWithStale": "stale {completed}/{stale}",
    "apply.cancelled": "cancelled {completed}",
    "apply.progress": "progress {completed}/{total}",
    "gallery.detectAll": "detect all",
  };
  return { directory, elements, ensureSaveSources, lockRequests, requests, runBrowserSave, saveTargets, state };
}

async function runSuccessCase() {
  const directory = new FakeDirectoryHandle();
  let outputClosedWhenCommitted = false;
  const runtime = createRuntime({
    directory,
    commit: () => {
      outputClosedWhenCommitted = directory.directories.get("nested").files.get("source_censored.png").closed;
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.lockRequests)), [{ name: "lets-censoring-output", options: { mode: "exclusive" } }]);
  const nested = directory.directories.get("nested");
  const output = nested.files.get("source_censored.png");
  assert.equal(output.closed, true);
  assert.deepEqual([...output.written], [4, 5, 6]);
  assert.equal(outputClosedWhenCommitted, true, "commit runs after the browser output stream closes");
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
  assert.equal(directory.directories.get("nested").files.get("source_censored.png").closed, true);
}

async function runCreateWritableFailureCase() {
  const directory = new FakeDirectoryHandle({
    createWritable() { throw new Error("write failed"); },
  });
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  await assert.rejects(runtime.runBrowserSave(directory, ["image-1"], "_censored", false), /write failed/);

  const nested = directory.directories.get("nested");
  assert.deepEqual(nested.removed, ["source_censored.png"]);
  assert.equal(nested.files.has("source_censored.png"), false, "failed reservations are removed before they become a visible output");
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render"]);
}

async function runCommitFailureCase() {
  const directory = new FakeDirectoryHandle();
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ error: "commit failed" }, 500) });
  await assert.rejects(runtime.runBrowserSave(directory, ["image-1"], "_censored", false), /commit failed/);

  const output = directory.directories.get("nested").files.get("source_censored.png");
  assert.equal(output.closed, true);
  assert.equal(runtime.state.images.length, 1);
  const paths = runtime.requests.map((request) => request.path);
  assert.deepEqual(paths.slice(0, 2), ["/api/save/prepare", "/api/save/render"]);
  assert.equal(paths.filter((path) => path === "/api/save/commit").length, 12);
}

async function runCancelCase() {
  let runtime;
  const directory = new FakeDirectoryHandle({
    closed() { runtime.state.browserSave.cancelled = true; },
  });
  runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);

  const nested = directory.directories.get("nested");
  assert.deepEqual(nested.removed, []);
  assert.equal(nested.files.get("source_censored.png").closed, true, "cancel keeps the completed browser output");
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
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
  const directory = new FakeDirectoryHandle({
    reserve(name, handle) {
      if (name !== "source_censored.png") return;
      handle.written = new Uint8Array([9]);
      handle.closed = true;
      handle.lastModified = Date.now() - 10_000;
    },
  });
  const runtime = createRuntime({ directory, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  await runtime.runBrowserSave(directory, ["image-1"], "_censored", false);

  const nested = directory.directories.get("nested");
  assert.deepEqual([...nested.files.get("source_censored.png").written], [9]);
  assert.equal(nested.files.get("source_censored_2.png").closed, true);
  assert.deepEqual(nested.removed, [], "a foreign collision is never deleted");
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

(async () => {
  await runSuccessCase();
  await runStaleCommitCase();
  await runCreateWritableFailureCase();
  await runCommitFailureCase();
  await runCancelCase();
  await runDeleteOriginalCase();
  await runHandleOverwriteCase();
  await runRepeatedHandleOverwriteCase();
  await runHandleDeleteAfterCopyCase();
  await runForeignCollisionCase();
  await runPartialCommitFailureReconcileCase();
  console.log("test_browser_save_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
