const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const staticRoot = path.join(__dirname, "..", "static");
const index = fs.readFileSync(path.join(staticRoot, "index.html"), "utf8");
const appPaths = [...index.matchAll(/<script src="\/js\/([a-z-]+\.js)"><\/script>/g)].map((match) => path.join(staticRoot, "js", match[1]));

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
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function binaryResponse(bytes, saveToken = "runtime-render-token", beforePipe = null) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "X-Mozarie-Save-Token" ? saveToken : null },
    body: { pipeTo: async (writable) => { await beforePipe?.(); await writable.write(Uint8Array.from(bytes)); await writable.close(); } },
    json: async () => ({}),
  };
}

function createRuntime({ commit, copy = null, deleteOriginal = false, renderBinary = null, renderToken = "runtime-render-token", entries = null, initialImages = null, removeCatalog = null }) {
  const preparedEntries = entries || [{ imageId: "image-1", relativePath: "nested/source.png", candidateRevision: 7, deleteOriginal }];
  let catalogImages = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  getElement("#applyDivisor").value = "100";
  getElement("#applySuffix");
  getElement("#deleteOriginal");
  getElement("#removeAfterSave");
  getElement("#removeOnlyMasked");
  getElement('input[name="saveMode"]:checked').value = "copy";
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
  let imageFetches = 0;
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
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    Image: class {},
    IntersectionObserver: class { observe() {} unobserve() {} },
    URL: { createObjectURL() { return "blob:runtime-test"; }, revokeObjectURL() {} },
    btoa(value) { return Buffer.from(value, "binary").toString("base64"); },
    window: browserWindow,
    navigator: {},
    fetch: async (requestPath, options = {}) => {
      if (requestPath === "/api/images") {
        imageFetches += 1;
        return jsonResponse({ images: catalogImages });
      }
      requests.push({ path: requestPath, options });
      if (requestPath === "/api/save/prepare") {
        return jsonResponse({ entries: preparedEntries });
      }
      if (requestPath === "/api/apply") return jsonResponse({ kind: "apply", state: "running" });
      if (requestPath === "/api/save/render") {
        const payload = JSON.parse(options.body || "{}");
        if (payload.copyToDefault) {
          const response = await (copy || (() => jsonResponse({ output: "G:/output/source_censored.png" })))({ options, requests });
          if (!response.ok) return response;
          return jsonResponse({ ...await response.json(), candidateRevision: payload.candidateRevision, saveToken: renderToken });
        }
        return renderBinary ? await renderBinary({ options, requests }) : binaryResponse([4, 5, 6], renderToken);
      }
      if (requestPath === "/api/save/commit") {
        const response = await commit({ options, requests });
        const body = await response.json();
        if (Array.isArray(body.images)) catalogImages = body.images;
        return response;
      }
      if (requestPath === "/api/catalog/remove") return (removeCatalog || (() => jsonResponse({ images: [], removedImageIds: [] })))({ options, requests });
      throw new Error(`Unexpected request: ${requestPath}`);
    },
  };

  let source = appPaths.map((appPath) => fs.readFileSync(appPath, "utf8")).join("\n");
  source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__browserSaveRuntime = { state, ensureSaveSources, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog };\n");
  vm.runInNewContext(source, context, { filename: "static/js/runtime.js" });
  const { state, ensureSaveSources, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog } = context.__browserSaveRuntime;
  state.images = initialImages || [{ id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  state.settings = { saving: { parallelism: 1, default_output_directory: "G:/output" } };
  state.translations = {
    "apply.complete": "complete {completed}",
    "apply.completeWithStale": "stale {completed}/{stale}",
    "apply.cancelled": "cancelled {completed}",
    "apply.progress": "progress {completed}/{total}",
    "gallery.detectAll": "detect all",
  };
  return { elements, ensureSaveSources, imageFetches: () => imageFetches, lockRequests, requests, runBrowserSave, saveTargets, chooseOutputDirectory, startApplyFromDialog, state, window: browserWindow };
}

async function runSuccessCase() {
    let copyCompletedWhenCommitted = false;
  const runtime = createRuntime({
    copy: () => { copyCompletedWhenCommitted = true; return jsonResponse({ output: "G:/output/nested/source_censored.png" }); },
    commit: () => {
      assert.equal(copyCompletedWhenCommitted, true, "commit runs after the copied output is saved");
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });
  await runtime.runBrowserSave(["image-1"], "_censored", false);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit"]);
  const commitPayload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(commitPayload.saveToken, "runtime-render-token");
  assert.equal(commitPayload.deleteOriginal, false);
  assert.equal(runtime.imageFetches(), 1, "one final catalog reconciliation runs after the batch");
  assert.equal(runtime.elements.get("#applyResult").textContent, "complete 1");
}

async function runDraftBarrierBeforeDefaultApplyCase() {
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.elements.get("#applySuffix").value = "_censored";
  runtime.state.applyTargetIds = ["image-1"];
  let releaseDraft;
  runtime.state.draftSaveChains.set("image-1", new Promise((resolve) => { releaseDraft = resolve; }));
  const start = runtime.startApplyFromDialog({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(runtime.requests.some((request) => request.path === "/api/apply"), false, "the server save waits for the draft encoder");
  releaseDraft();
  await start;
  const apply = runtime.requests.find((request) => request.path === "/api/apply");
  assert.ok(apply, "the server save starts after the draft encoder settles");
}

async function runStaleCommitCase() {
    const runtime = createRuntime({ commit: () => jsonResponse({ cleared: false, stale: true, images: [] }) });
  await runtime.runBrowserSave(["image-1"], "_censored", false);

  assert.equal(runtime.elements.get("#applyResult").textContent, "stale 1/1");
}

async function runRemoveAfterSaveCase() {
    const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), { imageIds: [image.id] });
      return jsonResponse({ images: [], removedImageIds: [image.id] });
    },
  });
  await runtime.runBrowserSave([image.id], "_censored", false, "copy", true);
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, []);
}

async function runRemoveAfterSaveAlreadyAbsentCase() {
  const image = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const runtime = createRuntime({
    initialImages: [image],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: true, images: [] }),
    removeCatalog: () => jsonResponse({ images: [], removedImageIds: [] }),
  });
  runtime.state.currentId = image.id;
  runtime.state.drafts.set(image.id, { add: "draft", exclusion: "" });

  await runtime.runBrowserSave([image.id], "_censored", true, "copy", true);

  assert.equal(runtime.state.drafts.has(image.id), false, "already-removed source entries still clear browser drafts");
  assert.equal(runtime.state.currentId, null, "already-removed current entries leave no stale selection");
}

async function runRemoveAfterSavePartialAndStaleCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  let commits = 0;
  const runtime = createRuntime({
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
  await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", false, "copy", true), /second commit failed/);
  assert.equal(runtime.requests.at(-1).path, "/api/catalog/remove");
  assert.deepEqual(runtime.state.images, [second]);

  const stale = createRuntime({
    initialImages: [first],
    commit: () => jsonResponse({ cleared: false, stale: true, images: [first] }),
  });
  await stale.runBrowserSave([first.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves must remain in the catalog");
}

async function runCopyFailureCase() {
  let removed = false;
  const runtime = createRuntime({ deleteOriginal: true, copy: () => jsonResponse({ error: "disk full" }, 500), commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", {
    fileHandle: {
      name: "source.png",
      async getFile() { return { name: "source.png", size: 1, lastModified: 1 }; },
      async remove() { removed = true; },
    },
    name: "source.png",
    size: 1,
    lastModified: 1,
  });
  await assert.rejects(runtime.runBrowserSave(["image-1"], "_censored", true), /disk full/);
  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render"]);
  assert.equal(removed, false, "a failed durable copy does not delete the source handle");
}

async function runCommitFailureCase() {
  for (const status of [500, 400]) {
    const runtime = createRuntime({ commit: () => jsonResponse({ error: "commit failed" }, status) });
    await assert.rejects(runtime.runBrowserSave(["image-1"], "_censored", false), /commit failed/);
    assert.equal(runtime.requests.filter((request) => request.path === "/api/save/commit").length, 1, `${status} is not retried`);
    assert.equal(runtime.imageFetches(), 1, "a failed batch still performs one final reconciliation");
  }
}

async function runRetryableCommitCase() {
  let commits = 0;
  const runtime = createRuntime({
    commit: () => {
      commits += 1;
      return commits === 1
        ? jsonResponse({ error: "temporarily unavailable" }, 503)
        : jsonResponse({ cleared: true, stale: false, images: [] });
    },
  });

  await runtime.runBrowserSave(["image-1"], "_censored", false);
  const requests = runtime.requests.filter((request) => request.path === "/api/save/commit");
  assert.equal(requests.length, 2, "503 is retried once");
  assert.equal(requests[0].options.body, requests[1].options.body, "retry keeps the same save token and payload");
  assert.equal(JSON.parse(requests[0].options.body).saveToken, "runtime-render-token");
}

async function runCancelCase() {
  let runtime;
    runtime = createRuntime({
    copy: () => { runtime.state.browserSave.cancelled = true; return jsonResponse({ output: "G:/output/source_censored.png" }); },
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
    removeCatalog: ({ options }) => {
      assert.deepEqual(JSON.parse(options.body), { imageIds: ["image-1"] });
      return jsonResponse({ images: [], removedImageIds: ["image-1"] });
    },
  });
  await runtime.runBrowserSave(["image-1"], "_censored", false, "copy", true);

  assert.deepEqual(runtime.requests.map((request) => request.path), ["/api/save/prepare", "/api/save/render", "/api/save/commit", "/api/catalog/remove"]);
  assert.equal(runtime.elements.get("#applyResult").textContent, "cancelled 1");
}

async function runDeleteOriginalCase() {
    const runtime = createRuntime({
    deleteOriginal: true,
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  await runtime.runBrowserSave(["image-1"], "_censored", true);

  const payload = JSON.parse(runtime.requests.at(-1).options.body);
  assert.equal(payload.deleteOriginal, true);
  assert.equal(payload.saveToken, "runtime-render-token");
  assert.equal(payload.sourceAction, "deleted");
}

async function runHandleOverwriteCase() {
    let written = null;
  const sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      return { async write(bytes) { written = [...new Uint8Array(bytes)]; }, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({ commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.images = [{ id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
  await runtime.runBrowserSave(["image-1"], "_censored", false, "overwrite");
  assert.deepEqual(written, [4, 5, 6]);
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "overwrite");
}

async function runHandleOverwriteChangedDuringRenderCase() {
  let writes = 0;
  let sourceFile = { name: "source.png", size: 12, lastModified: 34 };
  const sourceHandle = {
    async getFile() { return sourceFile; },
    async createWritable() {
      writes += 1;
      return { async write() {}, async close() {}, async abort() {} };
    },
  };
  const runtime = createRuntime({
    renderBinary: () => binaryResponse([4, 5, 6], "runtime-render-token", () => {
      sourceFile = { ...sourceFile, size: 13, lastModified: 35 };
    }),
    commit: () => jsonResponse({ cleared: true, stale: false, images: [] }),
  });
  runtime.state.images = [{ id: "image-1", sourceKind: "session", relativePath: "source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 }];
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });

  await runtime.runBrowserSave(["image-1"], "_censored", false, "overwrite");
  assert.equal(writes, 1, "streaming starts only after the user-granted source check");
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
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
  await runtime.ensureSaveSources([image.id], "overwrite", false);
  await runtime.runBrowserSave([image.id], "_censored", false, "overwrite");
  assert.equal(writes, 2);
  assert.deepEqual({ name: access.name, size: access.size, lastModified: access.lastModified }, sourceFile);
}

async function runHandleDeleteAfterCopyCase() {
    let removed = false;
  const sourceHandle = { name: "source.png", async getFile() { return { name: "source.png", size: 1, lastModified: 1 }; }, async remove() { removed = true; } };
  const runtime = createRuntime({ deleteOriginal: true, commit: () => jsonResponse({ cleared: true, stale: false, images: [] }) });
  runtime.state.sourceAccess.set("image-1", { fileHandle: sourceHandle, name: sourceHandle.name, size: 1, lastModified: 1 });
  await runtime.runBrowserSave(["image-1"], "_censored", true);
  assert.equal(removed, true, "the source handle is removed only after the copy has been written");
  assert.equal(JSON.parse(runtime.requests.at(-1).options.body).sourceAction, "deleted");
}

async function runQueuedHandleChangeCases() {
  const first = { id: "image-1", sourceKind: "session", relativePath: "first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", sourceKind: "session", relativePath: "second.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  for (const mode of ["overwrite", "copy"]) {
    let secondFile = { name: "second.png", size: 12, lastModified: 34 };
    let secondAction = false;
    const firstHandle = {
      async getFile() { return { name: "first.png", size: 12, lastModified: 34 }; },
      async createWritable() { return { async write() {}, async close() {}, async abort() {} }; },
      async remove() {},
    };
    const secondHandle = {
      async getFile() { return secondFile; },
      async createWritable() { secondAction = true; return { async write() {}, async close() {}, async abort() {} }; },
      async remove() { secondAction = true; },
    };
    const runtime = createRuntime({
      initialImages: [first, second],
      entries: [
        { imageId: first.id, relativePath: first.relativePath, candidateRevision: 1, deleteOriginal: mode === "copy" },
        { imageId: second.id, relativePath: second.relativePath, candidateRevision: 1, deleteOriginal: mode === "copy" },
      ],
      deleteOriginal: mode === "copy",
      commit: ({ requests }) => {
        if (requests.filter((request) => request.path === "/api/save/commit").length === 1) {
          secondFile = { ...secondFile, size: 13, lastModified: 35 };
        }
        return jsonResponse({ cleared: true, stale: false, images: [] });
      },
    });
    runtime.state.sourceAccess.set(first.id, { fileHandle: firstHandle, name: "first.png", size: 12, lastModified: 34 });
    runtime.state.sourceAccess.set(second.id, { fileHandle: secondHandle, name: secondFile.name, size: secondFile.size, lastModified: secondFile.lastModified });
    await runtime.ensureSaveSources([first.id, second.id], mode, mode === "copy");
    await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", mode === "copy", mode), /sourceChanged|変更/);
    assert.equal(secondAction, false, `${mode} does not modify a queued source that changed after preflight`);
  }
}

async function runCatalogEpochGuardCase() {
  const original = { id: "image-1", relativePath: "nested/source.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const local = { id: "local-change", relativePath: "local.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let runtime;
  let removals = 0;
  runtime = createRuntime({
    initialImages: [original],
    commit: () => {
      runtime.state.catalogEpoch += 1;
      runtime.state.images = [local];
      return jsonResponse({ cleared: true, stale: false, images: [] });
    },
    removeCatalog: () => { removals += 1; return jsonResponse({ images: [] }); },
  });
  await runtime.runBrowserSave([original.id], "_censored", false, "copy", true);
  assert.deepEqual(runtime.state.images, [local], "a newer catalog epoch rejects the final save snapshot");
  assert.equal(removals, 0, "a superseded save does not remove entries from the newer catalog");
  assert.equal(runtime.imageFetches(), 1);
}

async function runPartialCommitFailureReconcileCase() {
  const first = { id: "image-1", relativePath: "nested/first.png", width: 32, height: 32, candidateCount: 1, enabledCandidateCount: 1 };
  const second = { id: "image-2", relativePath: "nested/second.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  const exclusionOnly = { id: "image-3", relativePath: "nested/exclusion-only.png", width: 32, height: 32, candidateCount: 0, enabledCandidateCount: 0 };
  let commitCount = 0;
  const runtime = createRuntime({
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
    [first.id, { add: "data:image/png;base64,test", exclusion: "", hasEffectiveMask: true }],
    [second.id, { add: "data:image/png;base64,test", exclusion: "", manualEnabled: true, hasEffectiveMask: true }],
    [exclusionOnly.id, { add: "", exclusion: "data:image/png;base64,test", hasEffectiveMask: false }],
  ]);
  runtime.state.galleryFilter = "masked";
  runtime.state.maskStatus.set(first.id, true);
  runtime.state.maskStatus.set(second.id, false);
  runtime.state.maskStatus.set(exclusionOnly.id, true);

  await assert.rejects(runtime.runBrowserSave([first.id, second.id], "_censored", true), /second commit failed/);

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
    initialImages: [saved, retained],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved, retained] }),
    removeCatalog: ({ options }) => {
      removalPayload = JSON.parse(options.body);
      return jsonResponse({ images: [retained], removedImageIds: [saved.id] });
    },
  });
  await enabled.runBrowserSave([saved.id], "_censored", false, "copy", true);
  assert.deepEqual(removalPayload, { imageIds: [saved.id] }, "only completed and committed images are removed after save");
  assert.deepEqual(enabled.state.images.map((image) => image.id), [retained.id]);

  const disabled = createRuntime({
    initialImages: [saved],
    commit: () => jsonResponse({ cleared: true, stale: false, deleted: false, images: [saved] }),
  });
  await disabled.runBrowserSave([saved.id], "_censored", false, "copy", false);
  assert.equal(disabled.requests.some((request) => request.path === "/api/catalog/remove"), false, "unchecked removal leaves the catalog unchanged");

  const stale = createRuntime({
    initialImages: [saved],
    commit: () => jsonResponse({ cleared: false, stale: true, deleted: false, images: [saved] }),
  });
  await stale.runBrowserSave([saved.id], "_censored", false, "copy", true);
  assert.equal(stale.requests.some((request) => request.path === "/api/catalog/remove"), false, "stale saves remain in the catalog");
}

(async () => {
  await runSuccessCase();
  await runDraftBarrierBeforeDefaultApplyCase();
  await runStaleCommitCase();
  await runRemoveAfterSaveCase();
  await runRemoveAfterSaveAlreadyAbsentCase();
  await runRemoveAfterSavePartialAndStaleCase();
  await runCopyFailureCase();
  await runCommitFailureCase();
  await runRetryableCommitCase();
  await runCancelCase();
  await runDeleteOriginalCase();
  await runHandleOverwriteCase();
  await runHandleOverwriteChangedDuringRenderCase();
  await runRepeatedHandleOverwriteCase();
  await runHandleDeleteAfterCopyCase();
  await runQueuedHandleChangeCases();
  await runCatalogEpochGuardCase();
  await runPartialCommitFailureReconcileCase();
  await runRemoveAfterSaveCases();
  console.log("test_browser_save_runtime: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
