const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const translationFixtures = Object.fromEntries(["en", "ja"].map((language) => [
  language,
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", `${language}.json`), "utf8")),
]));

function element(tagName = "") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(), disabled: false, textContent: "", className: "", hidden: false, value: "", style: {}, dataset: {}, attributes: {}, children: [],
    classList: {
      contains(name) { return classes.has(name); },
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    }, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, addEventListener(type, listener) { listeners.set(type, listener); }, setAttribute(name, value) { this.attributes[name] = value; }, showModal() { this.open = true; }, close() { this.open = false; listeners.get("close")?.({ currentTarget: this, target: this }); }, hidePopover() { this.hidePopoverCalls = (this.hidePopoverCalls || 0) + 1; }, focus(options) { document.activeElement = this; this.focusOptions = options; }, click() { this.clickCalls = (this.clickCalls || 0) + 1; this.focus(); const event = { currentTarget: this, target: this }; listeners.get("click")?.(event); this.onclick?.(event); }, dispatch(type, event = {}) { listeners.get(type)?.({ currentTarget: this, target: this, ...event }); }, scrollIntoView() {},
  };
}

function galleryItem() {
  const preview = element();
  const badge = element();
  const name = element();
  const meta = element();
  return {
    ...element(),
    meta,
    querySelector(selector) {
      return { img: preview, ".gallery-review-badge": badge, ".gallery-name": name, ".gallery-meta": meta }[selector];
    },
  };
}

function overviewItem() {
  const preview = element();
  const name = element();
  const itemPath = element();
  const state = element();
  return {
    ...element(),
    querySelector(selector) {
      return { img: preview, ".overview-item-name": name, ".overview-item-path": itemPath, ".overview-item-state": state }[selector];
    },
  };
}

const elements = new Map();
for (const id of [
  "editorCanvas", "canvasStage", "detectAllButton", "detectCurrentButton", "clearCurrentMasksButton", "clearAllMasksButton", "clearCatalogButton", "saveAllButton", "saveButton", "removeCurrentImageButton", "galleryAllTab", "galleryMaskedTab", "pickFolder", "pickImages", "pickFolderFiles", "pickerMenu", "importImagesInput", "importFolderInput", "mosaicPreviewButton", "folderPath", "brushTool", "eraserTool", "boundaryTool", "rectangleTool", "boundaryModeMenu", "polygonTool", "boundaryActions", "boundaryDetectButton", "boundaryCancelButton", "fitButton", "undoButton", "redoButton", "brushSize", "confidence", "confidenceValue", "detectDialog", "detectForm", "detectTargetCount", "detectConfidenceRange", "detectConfidenceNumber", "detectParallelism", "detectCancelButton", "detectStartButton", "detectMode", "detectModeStandard", "detectModeHighPrecision", "settingsModelStatus", "settingsDialog", "settingsCloseButton",
  "overviewButton", "previousImageButton", "nextImageButton", "nextUnreviewedButton", "reviewAndNextButton", "navigationShortcutsEnabled", "imagePosition", "reviewStatus", "closeOverviewButton", "overviewPane", "overviewGrid", "overviewCount", "overviewQuery", "overviewFolder", "confirmDialog", "settingsShortcuts",
  "status", "jobProgress", "jobProgressText", "gallery", "galleryEmptyState", "galleryFilteredEmptyState", "galleryDropOverlay", "candidateList", "candidateStatus", "divisor", "blockSizeValue", "batchMoreButton", "batchMoreMenu", "catalogContextMenu", "toggleReviewMenuItem", "removeImageMenuItem", "overviewEmptyState", "collapseGalleryButton", "collapseInspectorButton", "galleryPane", "galleryPaneContent", "candidatePane", "candidatePaneContent",
  "applyTargetCount", "applyBlockSize", "applyDivisor", "applyProgressPanel", "applyStartButton", "applyCloseButton", "applyPauseButton", "applyCancelButton", "applySettings", "applyResult", "applySuffix", "deleteOriginal", "deleteOriginalRow", "applyDialog", "applyCopyMode", "applyOverwriteMode", "applyOverwriteRow", "applyTemporarySourceNote", "applyOverwriteNote", "applyOutputDirectoryRow", "applyOutputDirectoryStatus", "chooseOutputDirectoryButton", "removeAfterSave", "settingsLanguage", "settingsOpenBrowser", "settingsPort", "settingsTargetModel", "settingsHandModel", "settingsSamModel", "settingsSamType", "settingsProvider", "settingsApplyColor", "settingsExcludeColor", "settingsOpacity", "settingsMosaicPreview", "settingsResult",
]) {
  const value = element();
  value.id = id;
  elements.set(`#${id}`, value);
}
elements.get("#applySuffix").value = "_censored";
elements.get("#applyDivisor").value = "100";
elements.get("#divisor").value = "100";
elements.get("#detectParallelism").value = "2";
const gallery = elements.get("#gallery");
gallery.children = [];
let galleryAppendCount = 0;
gallery.append = function append(child) {
  galleryAppendCount += 1;
  const existing = this.children.indexOf(child);
  if (existing >= 0) this.children.splice(existing, 1);
  child.remove = () => {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  };
  this.children.push(child);
};
Object.defineProperty(gallery, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
const overviewGrid = elements.get("#overviewGrid");
overviewGrid.children = [];
overviewGrid.append = function append(child) {
  const existing = this.children.indexOf(child);
  if (existing >= 0) this.children.splice(existing, 1);
  child.remove = () => {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  };
  this.children.push(child);
};
Object.defineProperty(overviewGrid, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});
elements.get("#editorCanvas").getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, fill() {}, stroke() {}, setLineDash() {} });
elements.get("#editorCanvas").getBoundingClientRect = () => ({ left: 0, top: 0 });
elements.get("#editorCanvas").setPointerCapture = () => {};
elements.get("#editorCanvas").hasPointerCapture = () => true;
elements.get("#editorCanvas").releasePointerCapture = () => {};
elements.get("#canvasStage").clientWidth = 600;
elements.get("#canvasStage").clientHeight = 400;
elements.get("#boundaryActions").offsetWidth = 142;
elements.get("#boundaryActions").offsetHeight = 38;
elements.set("#galleryItemTemplate", { content: { firstElementChild: { cloneNode: galleryItem } } });
elements.set("#overviewItemTemplate", { content: { firstElementChild: { cloneNode: overviewItem } } });
const candidateList = elements.get("#candidateList");
Object.defineProperty(candidateList, "textContent", {
  get() { return this._textContent || ""; },
  set(value) { this._textContent = value; this.children = []; },
});

const createdCanvases = [];
function canvasElement() {
  let target;
  const context = {
    clearRectCalls: 0, drawImageCalls: [], strokeCalls: 0, globalCompositeOperation: "source-over",
    clearRect() {
      this.clearRectCalls += 1;
      if (target._usePixelAlpha) target._alpha.fill(0);
    },
    drawImage(...args) {
      this.drawImageCalls.push(args);
      if (!target._usePixelAlpha) return;
      const sourceAlpha = args[0]?._alpha || new Uint8Array(target._alpha.length);
      for (let index = 0; index < target._alpha.length; index += 1) {
        if (this.globalCompositeOperation === "destination-out") {
          if (sourceAlpha[index]) target._alpha[index] = 0;
        } else if (sourceAlpha[index]) {
          target._alpha[index] = sourceAlpha[index];
        }
      }
    },
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { this.strokeCalls += 1; },
    getImageData() {
      if (!target._usePixelAlpha) return { data: new Uint8ClampedArray(combinedMaskPresent ? [255] : [0]) };
      return { data: new Uint8ClampedArray([...target._alpha].flatMap((alpha) => [0, 0, 0, alpha ? 255 : 0])) };
    },
  };
  target = {
    width: 1, height: 1, _alpha: new Uint8Array(2), _usePixelAlpha: false, _context: context, getContext: () => context,
    toDataURL: () => target._usePixelAlpha ? `data:image/png;base64,alpha:${[...target._alpha].join(".")}` : "data:image/png;base64,test",
  };
  createdCanvases.push(target);
  return target;
}

const studioGrid = element();
const document = {
  addEventListener() {},
  querySelector: (selector) => {
    if (selector === 'input[name="saveMode"]:checked') return { value: elements.get("#applyOverwriteMode").checked ? "overwrite" : "copy" };
    if (selector === 'input[name="detectMode"]') return elements.get("#detectModeRadio");
    if (selector.startsWith('input[name="detectMode"][value=')) return elements.get("#detectModeRadio");
    return selector === ".studio-grid" ? studioGrid : (elements.get(selector) || element());
  },
  querySelectorAll: (selector) => {
    if (selector === "button, input, select, textarea") return [...elements.values()].filter((item) => item.id);
    if (selector === "dialog") return [elements.get("#confirmDialog"), elements.get("#applyDialog"), elements.get("#detectDialog")];
    return [];
  },
  createElement: (tag) => tag === "canvas" ? canvasElement() : element(tag),
};
document.activeElement = null;
document.documentElement = { lang: "ja" };
elements.set("#detectModeRadio", { checked: true, value: "standard" });
let combinedMaskPresent = false;
let resolveFetch;
const pendingFetches = [];
function settlePendingFetch(pending, response) {
  const index = pendingFetches.indexOf(pending);
  assert.notEqual(index, -1, `unexpected fetch response for ${pending.path}`);
  pendingFetches.splice(index, 1);
  pending.resolve(response);
}
function resolvePendingFetch(pathPrefix, response) {
  const pending = pendingFetches.find((item) => item.path.startsWith(pathPrefix));
  assert.ok(pending, `expected pending fetch for ${pathPrefix}; found ${pendingFetches.map((item) => item.path).join(", ")}`);
  settlePendingFetch(pending, response);
}
let fetchCalls = 0;
const requests = [];
const storage = new Map();
let storageWrites = 0;
const windowListeners = new Map();
const context = {
  console, document, Date, Math, Promise, Uint8Array, ArrayBuffer, structuredClone, crypto: { randomUUID: () => "test-client-key" }, navigator: { locks: { async request(_name, _options, callback) { return callback(); } } }, window: { devicePixelRatio: 1, addEventListener(type, listener) { windowListeners.set(type, listener); } }, setInterval() {}, setTimeout(callback) { callback(); return 1; }, clearTimeout() {}, requestAnimationFrame(callback) { callback(); }, ResizeObserver: class { observe() {} },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storageWrites += 1; storage.set(key, value); },
    removeItem(key) { storageWrites += 1; storage.delete(key); },
  },
  Image: class {
    set src(value) {
      this._src = value;
      const match = /^data:image\/png;base64,alpha:([\d.]*)$/.exec(value);
      if (match) this._alpha = new Uint8Array(match[1] ? match[1].split(".").map(Number) : []);
      queueMicrotask(() => this.onload?.());
    }
  },
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch: (path, options) => {
    fetchCalls += 1; requests.push({ path, options });
    return new Promise((resolve) => {
      const pending = { path: `${path}#${fetchCalls}`, resolve };
      pendingFetches.push(pending);
      resolveFetch = (response) => {
        settlePendingFetch(pending, response);
      };
    });
  },
};

let source = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
assert.doesNotMatch(source, /setInterval\(\s*render\s*,/);
const markup = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
assert.match(markup, /id="boundaryActions"[^>]*hidden/);
assert.match(markup, /id="boundaryModeMenu"[^>]*hidden/);
assert.doesNotMatch(markup, /id="polygonActions"|id="polygonDetectButton"|id="polygonCancelButton"/);
assert.match(styles, /\.boundary-actions\[hidden\]\s*\{\s*display:\s*none/);
assert.match(styles, /\.settings-dialog\s*\{\s*width:\s*min\(620px/);
assert.doesNotMatch(markup, /必要なモデルを確認しました|モデルは含まれていません|依存関係|ログの場所/);
assert.match(markup, /<span data-i18n="editor\.blockSize">モザイク粗さ<\/span>/);
assert.match(markup, /class="settings-tabs" role="tablist" aria-label="設定" data-i18n-aria-label="settings\.tablist"/);
for (const key of [...markup.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1])) {
  assert.ok(translationFixtures.en[key], `English translation missing visible key: ${key}`);
}
for (const key of [...markup.matchAll(/data-i18n-(?:aria-label|title|placeholder)="([^"]+)"/g)].map((match) => match[1])) {
  assert.ok(translationFixtures.en[key], `English translation missing accessible key: ${key}`);
}
for (const tag of markup.match(/<[^>]+>/g) || []) {
  assert.ok(!/aria-label="[^\"]*[ぁ-んァ-ン一-龯]/.test(tag) || /data-i18n-aria-label=/.test(tag), `Japanese ARIA label lacks a translation key: ${tag}`);
  assert.ok(!/title="[^\"]*[ぁ-んァ-ン一-龯]/.test(tag) || /data-i18n-title=/.test(tag), `Japanese title lacks a translation key: ${tag}`);
}
  source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__mosaicTest = { state, t, loadTranslations, setSettingsForm, renderModelStatus, updateBoundaryActions, boundaryActionAnchor, cancelBoundary, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, clearBoundaryInteraction, lruRemember, releaseImageResource, releaseCandidateBundle, invalidateCandidateBundles, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, renderCandidates, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, importSingleFile, importFileHandles, importDirectoryHandle, directFilesFromDrop, loadCandidateBundle, selectImage, updateCandidate, deleteCandidate, deleteManualMask, saveDraft, restoreDraft, draftPayload, buildCombinedMask, restoreSnapshot, beginManualStroke, appendManualStrokePoint, completeManualStroke, resetHistoryToCurrentManualMask, rebuildManualMaskFromHistory, commitBrowserSaveWithRetry, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, persistNavigationShortcuts, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, ensureSaveSources, pickImageFiles, pickImageDirectory, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence, pickOutputDirectory, outputDirectoryFor, uniqueOutputFile, runBrowserSave, removeImageFromCatalog, removeCompletedImagesFromCatalog, setGalleryDropOverlay };\n");
  source = source.replace("globalThis.__mosaicTest = {", "globalThis.__mosaicTest = { saveSettings,");
vm.runInNewContext(source, context, { filename: "static/app.js" });
  const { state, t, loadTranslations, setSettingsForm, renderModelStatus, saveSettings, updateBoundaryActions, boundaryActionAnchor, cancelBoundary, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, clearBoundaryInteraction, lruRemember, releaseImageResource, releaseCandidateBundle, invalidateCandidateBundles, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, renderCandidates, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, importSingleFile, importFileHandles, importDirectoryHandle, directFilesFromDrop, loadCandidateBundle, selectImage, updateCandidate, deleteCandidate, deleteManualMask, saveDraft, restoreDraft, draftPayload, buildCombinedMask, restoreSnapshot, beginManualStroke, appendManualStrokePoint, completeManualStroke, resetHistoryToCurrentManualMask, rebuildManualMaskFromHistory, commitBrowserSaveWithRetry, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, persistNavigationShortcuts, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, ensureSaveSources, pickImageFiles, pickImageDirectory, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence, pickOutputDirectory, outputDirectoryFor, uniqueOutputFile, runBrowserSave, removeImageFromCatalog, removeCompletedImagesFromCatalog, setGalleryDropOverlay } = context.__mosaicTest;
  bindEvents();
  const lru = new Map();
  const firstImage = { src: "blob:first" };
  const secondImage = { src: "blob:second" };
  lruRemember(lru, "first", firstImage, 1, releaseImageResource);
  lruRemember(lru, "second", secondImage, 1, releaseImageResource);
  assert.equal(lru.size, 1);
  assert.equal(firstImage.src, "");
  const staleBundleImage = { src: "blob:mask" };
  state.candidateBundleCache = new Map([["first:1", { candidateImages: new Map([["mask", staleBundleImage]]) }]]);
  invalidateCandidateBundles("first");
  assert.equal(staleBundleImage.src, "");
  const workspaceGrid = document.querySelector(".studio-grid");
  elements.get("#collapseGalleryButton").click();
  assert.equal(workspaceGrid.classList.contains("gallery-collapsed"), true);
  assert.equal(elements.get("#galleryPaneContent").inert, true);
  assert.equal(elements.get("#galleryPaneContent").attributes["aria-hidden"], "true");
  assert.equal(elements.get("#collapseGalleryButton").attributes["aria-expanded"], "false");
  assert.equal(elements.get("#collapseGalleryButton").textContent, "›");
  elements.get("#collapseInspectorButton").click();
  assert.equal(workspaceGrid.classList.contains("inspector-collapsed"), true);
  assert.equal(elements.get("#candidatePaneContent").inert, true);
  assert.equal(elements.get("#candidatePaneContent").attributes["aria-hidden"], "true");
  assert.equal(elements.get("#collapseInspectorButton").attributes["aria-expanded"], "false");
  assert.equal(elements.get("#collapseInspectorButton").textContent, "‹");
  elements.get("#collapseGalleryButton").click();
  assert.equal(workspaceGrid.classList.contains("gallery-collapsed"), false);
  assert.equal(elements.get("#galleryPaneContent").inert, false);
  elements.get("#collapseInspectorButton").click();
  assert.equal(workspaceGrid.classList.contains("inspector-collapsed"), false);
  assert.equal(elements.get("#candidatePaneContent").inert, false);

  const applyImage = { id: "apply-image", sourceKind: "filesystem", relativePath: "apply.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [applyImage];
  state.applyTargetIds = [applyImage.id];
  state.outputDirectoryName = "保存先";
  elements.get("#applySuffix").value = "_keep";
  elements.get("#deleteOriginal").checked = true;
  elements.get("#applyOverwriteMode").checked = true;
  elements.get("#applyCopyMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, true);
  assert.equal(elements.get("#deleteOriginal").disabled, true);
  assert.equal(elements.get("#chooseOutputDirectoryButton").disabled, true);
  assert.equal(elements.get("#deleteOriginalRow").hidden, false);
  assert.equal(elements.get("#applyOutputDirectoryRow").hidden, false);
  assert.equal(elements.get("#applyOverwriteNote").hidden, false);
  elements.get("#applyOverwriteMode").checked = false;
  elements.get("#applyCopyMode").checked = true;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, false);
  assert.equal(elements.get("#deleteOriginal").disabled, false);
  assert.equal(elements.get("#chooseOutputDirectoryButton").disabled, false);
  assert.equal(elements.get("#applySuffix").value, "_keep");
  assert.equal(elements.get("#deleteOriginal").checked, true);
  assert.equal(elements.get("#applyOverwriteNote").hidden, true);

  function keyEvent(key, options = {}) {
  return { key, code: options.code || key, shiftKey: Boolean(options.shiftKey), ctrlKey: Boolean(options.ctrlKey), metaKey: Boolean(options.metaKey), altKey: Boolean(options.altKey), prevented: false, preventDefault() { this.prevented = true; } };
}

let testReachedEnd = false;
const completionWatchdog = setTimeout(() => {
  if (!testReachedEnd) {
    console.error(`test_app_js did not reach its final assertion; pending fetches: ${pendingFetches.map((item) => item.path).join(", ")}`);
    process.exitCode = 1;
  }
}, 250);

(async () => {
  const initialiseRun = initialise();
  resolveFetch({ ok: true, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  const initialImage = { id: "initial", relativePath: "initial.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  resolveFetch({ ok: true, json: async () => ({ images: [initialImage], root: "G:/images/initial" }) });
  await initialiseRun;
  assert.equal(requests.at(-1).path, "/api/images");
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [initialImage]);
  state.settings = {
    general: { language: "ja", open_browser: true, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "", hand_detection: "", sam_checkpoint: "", sam_model_type: "vit_b", provider: "cpu" },
    display: { apply_color: "#ff0000", exclude_color: "#00ffff", overlay_opacity: 0.5, mosaic_preview: true },
    detection: { threshold: 0.5, parallelism: 2, mode: "high_precision" },
  };
  const persistShortcuts = persistNavigationShortcuts(false);
  resolveFetch({ ok: true, json: async () => ({ settings: state.settings, status: { models: {} } }) });
  await persistShortcuts;
  assert.equal(elements.get("#navigationShortcutsEnabled").checked, false);
  assert.equal(elements.get("#settingsShortcuts").checked, false);
  assert.equal(state.settings.general.shortcuts_enabled, false);
  assert.equal(requests.at(-1).path, "/api/settings");
  assert.equal(state.reviewRoot, "g:\\images\\initial");
  assert.notEqual(elements.get("#status").className, "status error");

  const loadedImage = { id: "loaded", relativePath: "loaded.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  elements.get("#folderPath").value = "G:/images/loaded";
  state.currentId = "initial";
  state.currentImage = { width: 100, height: 80 };
  state.maskStatus.set("initial", true);
  elements.get("#folderPath").dispatch("keydown", { key: "Enter" });
  resolveFetch({ ok: true, json: async () => ({ images: [loadedImage] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/folder");
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [loadedImage]);
  assert.equal(state.reviewRoot, "g:\\images\\loaded");
  assert.equal(state.currentId, null);
  assert.equal(state.maskStatus.size, 0);

  elements.get("#pickImages").click();
  assert.equal(elements.get("#pickerMenu").hidePopoverCalls, 1);
  assert.equal(elements.get("#importImagesInput").clickCalls, 1);
  elements.get("#pickFolderFiles").click();
  assert.equal(elements.get("#pickerMenu").hidePopoverCalls, 2);
  assert.equal(elements.get("#importFolderInput").clickCalls, 1);

  fetchCalls = 0;
  requests.length = 0;
  state.translations["status.progressCount"] = "{completed} / {total}";
  state.translations["gallery.candidates"] = "{count} candidates";
  state.translations["review.reviewed"] = "Reviewed";
  state.translations["review.unreviewed"] = "Unreviewed";
  state.translations["review.reviewedBadge"] = "Reviewed badge";
  state.translations["review.unreviewedBadge"] = "Unreviewed badge";
  state.translations["gallery.detectAll"] = "Detect all";
  state.translations["detectDialog.target"] = "Target: {count}";
  state.translations["detectDialog.stop"] = "Stop detection";
  state.translations["detectDialog.stopping"] = "Stopping...";
  state.translations["status.detectCancelling"] = "Stopping after current image";
  state.translations["status.detectCancelled"] = "Stopped. {completed} complete.";
  state.translations["candidates.count"] = "{count} candidates";
  state.translations["candidates.countWithManual"] = "{count} candidates / manual";
  state.translations["candidates.manualOnly"] = "manual";
  state.translations["candidates.manual"] = "手書き";
  state.translations["candidates.manualToggle"] = "手書きモザイクを使用";
  state.translations["candidates.toggle"] = "{label}を使用";
  state.translations["candidates.delete"] = "{label}を削除";
  state.translations["candidates.deleteManual"] = "手書きを削除";
  state.translations["candidates.none"] = "候補はありません";
  state.translations["status.editReady"] = "Ready";
  state.translations["status.chooseFolder"] = "Choose folder";
  state.images = [
    { id: "remove", relativePath: "remove.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "keep", relativePath: "keep.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  state.currentId = "keep";
  state.currentImage = { width: 100, height: 80 };
  state.sourceAccess.set("remove", { fileHandle: { name: "remove.png" } });
  const removeRequest = removeImageFromCatalog("remove");
  assert.equal(elements.get("#confirmDialog").open, true, "image removal must always require confirmation");
  assert.equal(requests.length, 0, "image removal must not start before confirmation");
  elements.get("#confirmDialog").returnValue = "confirm";
  elements.get("#confirmDialog").close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/catalog/image/remove");
  resolveFetch({ ok: true, json: async () => ({ images: [state.images[1]] }) });
  await removeRequest;
  assert.deepEqual(JSON.parse(JSON.stringify(state.images.map((image) => image.id))), ["keep"]);
  assert.equal(state.sourceAccess.has("remove"), false);
  const batchA = { id: "batch-a", relativePath: "batch-a.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const batchB = { id: "batch-b", relativePath: "batch-b.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 };
  const batchC = { id: "batch-c", relativePath: "batch-c.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [batchA, batchB, batchC];
  state.currentId = "batch-b";
  state.currentImage = { width: 100, height: 80 };
  state.sourceAccess.set("batch-b", { fileHandle: { name: "batch-b.png" } });
  state.drafts.set("batch-b", { add: "draft", exclusion: "" });
  state.maskStatus.set("batch-b", true);
  state.reviewRoot = "g:\\images\\batch";
  setReviewed(batchB, true);
  const batchRemoval = removeCompletedImagesFromCatalog(["batch-b"], ["batch-a", "batch-b", "batch-c"], new Map([["batch-a", batchA], ["batch-b", batchB], ["batch-c", batchC]]));
  assert.equal(requests.at(-1).path, "/api/catalog/remove");
  resolveFetch({ ok: true, json: async () => ({ images: [batchA, batchC], removedImageIds: ["batch-b"] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/batch-c", "the next image is selected after the current image is removed");
  resolveFetch({ ok: true, json: async () => ({ candidates: [] }) });
  await batchRemoval;
  assert.deepEqual(JSON.parse(JSON.stringify(state.images.map((image) => image.id))), ["batch-a", "batch-c"]);
  assert.equal(state.currentId, "batch-c");
  assert.equal(state.sourceAccess.has("batch-b"), false);
  assert.equal(state.drafts.has("batch-b"), false);
  assert.equal(state.maskStatus.has("batch-b"), false);
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\batch:batch-b.png"), false);
  setGalleryDropOverlay(true);
  assert.equal(elements.get("#galleryDropOverlay").hidden, false);
  setGalleryDropOverlay(false);
  assert.equal(elements.get("#galleryDropOverlay").hidden, true);
  state.images = [loadedImage];
  state.job = null;
  state.detectCancelRequested = false;
  state.currentId = loadedImage.id;
  state.currentImage = { width: loadedImage.width, height: loadedImage.height };
  setDetectionConfidence(1.50);
  assert.equal(elements.get("#confidence").value, "1.00", "right-pane confidence should clamp to the supported maximum");
  updateActionButtons();
  const requestsBeforeCurrentDetection = requests.length;
  elements.get("#detectCurrentButton").click();
  assert.equal(Boolean(elements.get("#detectDialog").open), false, "current-image detection must not open settings");
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, requestsBeforeCurrentDetection + 1);
  assert.equal(requests.at(-1).path, "/api/detect");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body).imageIds, [loadedImage.id]);
  assert.equal(JSON.parse(requests.at(-1).options.body).confidence, 1.00);
  state.job = null;
  state.detectCancelRequested = false;
  state.currentId = null;
  state.currentImage = null;
  updateActionButtons();
  const requestsBeforeDetectionDialog = requests.length;
  elements.get("#detectAllButton").click();
  assert.equal(elements.get("#detectDialog").open, true, "detect all should open settings before starting");
  assert.equal(requests.length, requestsBeforeDetectionDialog, "opening settings must not call /api/detect");
  assert.equal(elements.get("#detectTargetCount").textContent, "Target: 1");
  elements.get("#detectConfidenceNumber").value = "0.67";
  const startDetection = startDetectionFromDialog({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await startDetection;
  assert.equal(requests.at(-1).path, "/api/detect");
  assert.equal(JSON.parse(requests.at(-1).options.body).confidence, 0.67);
  assert.equal(elements.get("#confidence").value, "0.67", "dialog confidence should synchronize to the right pane");
  updateActionButtons();
  assert.equal(elements.get("#detectAllButton").disabled, false, "stop must remain available while detecting");
  assert.equal(elements.get("#detectCurrentButton").disabled, true);
  assert.equal(elements.get("#saveAllButton").disabled, true);
  const cancelDetectionRequest = cancelDetection();
  assert.equal(elements.get("#detectAllButton").disabled, true, "stop button disables while cancellation is pending");
  assert.equal(elements.get("#detectAllButton").textContent, "Stopping...");
  resolveFetch({ ok: true, json: async () => ({ kind: "detect", state: "running" }) });
  await cancelDetectionRequest;
  assert.equal(requests.at(-1).path, "/api/job/cancel");
  state.job = null;
  state.detectCancelRequested = false;
  updateActionButtons();
  fetchCalls = 0;
  requests.length = 0;
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
  state.boundaryRoi = { left: 1, top: 1, right: 3, bottom: 3 };
  state.boundaryStart = { x: 1, y: 1 };
  state.boundaryDragging = true;
  state.polygonPoints = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }];
  state.polygonDragIndex = 2;
  clearBoundaryInteraction();
  assert.equal(state.boundaryRoi, null);
  assert.equal(state.boundaryDragging, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.polygonPoints)), []);
  assert.equal(state.polygonDragIndex, -1);
  assert.equal(elements.get("#boundaryActions").hidden, true);

  // Boundary actions only appear for a draft, track the image coordinate
  // anchor, and flip above the boundary when there is no room below.
  state.tool = "boundary";
  state.view = { x: 0, y: 0, scale: 1 };
  state.boundaryRoi = { left: 20, top: 340, right: 100, bottom: 390 };
  state.boundaryPromptPoint = { x: 60, y: 365 };
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").hidden, false);
  assert.equal(elements.get("#boundaryDetectButton").disabled, false);
  assert.equal(elements.get("#boundaryActions").style.top, "294px");
  assert.equal(elements.get("#boundaryActions").style.left, "8px");
  state.tool = "polygon";
  state.boundaryRoi = null;
  state.polygonPoints = [{ x: 10, y: 10 }];
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").hidden, false);
  assert.equal(elements.get("#boundaryDetectButton").disabled, true);
  cancelBoundary();
  assert.equal(elements.get("#boundaryActions").hidden, true);

  // Four-point boundary vertices must remain draggable after pointerdown.
  state.currentImage = { width: 100, height: 80 };
  state.tool = "polygon";
  state.view = { x: 0, y: 0, scale: 1 };
  state.polygonPoints = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }];
  const polygonCanvas = elements.get("#editorCanvas");
  polygonCanvas.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  assert.equal(state.polygonDragIndex, 0);
  assert.equal(state.drawing, true);
  polygonCanvas.dispatch("pointermove", { buttons: 1, pointerId: 7, clientX: 18, clientY: 22 });
  polygonCanvas.dispatch("pointerup", { button: 0, pointerId: 7, clientX: 18, clientY: 22 });
  assert.deepEqual(JSON.parse(JSON.stringify(state.polygonPoints[0])), { x: 18, y: 22 });
  assert.equal(state.polygonDragIndex, -1);
  state.tool = "brush";

  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 4, enabledCandidateCount: 2 },
  ];
  state.currentId = "first";
  state.imageGeneration = 1;
  state.reviewedPaths = new Set(["first.png"]);
  const staleBoundaryAppends = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  state.candidates = [];
  state.candidateImages = new Map();
  const pending = addBoundaryCandidate({ x: 8.5, y: 7.5 });
  state.currentId = "second";
  state.imageGeneration += 1;
  state.currentId = "first";
  state.imageGeneration += 1;
  resolveFetch({ ok: true, json: async () => ({ candidates: [{ id: "boundary", enabled: true, confidence: 0.9, color: "#fff", role: "apply" }], candidateRevision: 1 }) });
  await pending;
  assert.equal(state.images[0].candidateCount, 1);
  assert.equal(state.images[0].enabledCandidateCount, 1);
  assert.equal(state.images[1].candidateCount, 4);
  assert.equal(state.candidates.length, 0);
  assert.equal(state.candidateImages.size, 0);
  assert.equal(gallery.children.length, 2);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - staleBoundaryAppends, state.images.length);
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
  state.reviewRoot = "";
  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", true]]);
  combinedMaskPresent = true;
  const candidateCountBeforeBoundary = state.images[0].candidateCount;
  const galleryAppendsBeforeBoundary = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundarySuccess = addBoundaryCandidate({ x: 8, y: 7 });
  const existingBoundary = { id: "boundary-existing", enabled: true, confidence: 0.9, color: "#fff", role: "apply" };
  const boundarySuccessCandidate = { id: "boundary-success", enabled: true, confidence: 0.9, color: "#fff", role: "apply" };
  resolveFetch({ ok: true, json: async () => ({ candidates: [boundarySuccessCandidate], candidateRevision: 2 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [existingBoundary, boundarySuccessCandidate], candidateRevision: 2 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/api/mask/first/boundary-existing", { ok: true, blob: async () => ({}) });
  resolvePendingFetch("/api/mask/first/boundary-success", { ok: true, blob: async () => ({}) });
  await boundarySuccess;
  assert.equal(state.boundaryRoi, null);
  assert.equal(state.images[0].candidateCount, candidateCountBeforeBoundary + 1);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - galleryAppendsBeforeBoundary, state.images.length);
  assert.match(gallery.children[0].meta.textContent, /2 candidates/);
  combinedMaskPresent = false;

  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", false]]);
  const candidateCountBeforeMaskFailure = state.images[0].candidateCount;
  const maskFailureAppends = galleryAppendCount;
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundaryMaskFailure = addBoundaryCandidate({ x: 8, y: 7 });
  const boundaryMaskFailureCandidate = { id: "boundary-mask-failure", enabled: true, confidence: 0.9, color: "#fff", role: "apply" };
  resolveFetch({ ok: true, json: async () => ({ candidates: [boundaryMaskFailureCandidate], candidateRevision: 3 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [existingBoundary, boundarySuccessCandidate, boundaryMaskFailureCandidate], candidateRevision: 3 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/api/mask/first/boundary-mask-failure", { ok: false, status: 500, blob: async () => ({}) });
  resolvePendingFetch("/api/mask/first/boundary-existing", { ok: true, blob: async () => ({}) });
  resolvePendingFetch("/api/mask/first/boundary-success", { ok: true, blob: async () => ({}) });
  await boundaryMaskFailure;
  assert.equal(state.images[0].candidateCount, candidateCountBeforeMaskFailure + 1);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - maskFailureAppends, state.images.length);
  assert.equal(imageHasMask(state.images[0]), true);
  state.galleryFilter = "masked";
  renderGallery();
  assert.equal(gallery.children.some((item) => item.dataset.id === "first"), true);
  state.galleryFilter = "all";

  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  const boundaryFailure = addBoundaryCandidate({ x: 8, y: 7 });
  resolveFetch({ ok: false, json: async () => ({ error: "boundary failed" }) });
  await boundaryFailure;
  assert.deepEqual(JSON.parse(JSON.stringify(state.boundaryRoi)), { left: 1, top: 1, right: 20, bottom: 20 });

  // Files loaded from a real filesystem path keep both destructive save choices available.
  state.images = [{ id: "filesystem", sourceKind: "filesystem", relativePath: "source.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 }];
  state.applyTargetIds = ["filesystem"];
  state.applyRunning = false;
  elements.get("#applyCopyMode").checked = true;
  elements.get("#applyOverwriteMode").checked = false;
  syncApplyMode();
  assert.equal(applyTargetsSupport("overwrite"), true);
  assert.equal(elements.get("#applyOverwriteMode").disabled, false);
  assert.equal(elements.get("#deleteOriginal").disabled, false);
  assert.equal(elements.get("#deleteOriginalRow").hidden, false);

  // Session imports with a retained browser handle can be overwritten and deleted.
  state.images = [{ id: "session", sourceKind: "session", relativePath: "dropped.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 }];
  state.currentId = "session";
  state.applyTargetIds = ["session"];
  const sourceFile = { name: "dropped.png", size: 12, lastModified: 34 };
  const sourceHandle = {
    async queryPermission() { return "granted"; },
    async getFile() { return sourceFile; },
    async createWritable() { return { async write() {}, async close() {}, async abort() {} }; },
    async remove() {},
  };
  state.sourceAccess.set("session", { fileHandle: sourceHandle, parentHandle: null, name: sourceFile.name, size: sourceFile.size, lastModified: sourceFile.lastModified });
  state.applyRunning = false;
  state.job = null;
  elements.get("#applyOverwriteMode").checked = true;
  elements.get("#deleteOriginal").checked = true;
  syncApplyMode();
  assert.equal(sourceCanOverwrite(state.images[0]), true);
  assert.equal(sourceCanDelete(state.images[0]), true);
  assert.equal(elements.get("#applyOverwriteMode").disabled, false);
  elements.get("#applyCopyMode").checked = true;
  elements.get("#applyOverwriteMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#deleteOriginal").disabled, false);
  elements.get("#applyOverwriteMode").checked = true;
  elements.get("#applyCopyMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, true, "overwrite disables the suffix without hiding it");
  assert.equal(elements.get("#deleteOriginal").disabled, true, "overwrite disables original deletion");
  assert.equal(elements.get("#chooseOutputDirectoryButton").disabled, true, "overwrite disables the output picker");
  assert.equal(elements.get("#deleteOriginalRow").hidden, false, "overwrite keeps the original-delete row visible");
  assert.equal(elements.get("#applyOutputDirectoryRow").hidden, false, "overwrite keeps the destination row visible");
  assert.equal(elements.get("#applyOverwriteNote").hidden, false, "overwrite explains the disabled controls");
  elements.get("#applyCopyMode").checked = true;
  elements.get("#applyOverwriteMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, false, "copy restores suffix editing");
  assert.equal(elements.get("#applyOverwriteNote").hidden, true, "copy hides the overwrite explanation");
  assert.equal(elements.get("#deleteOriginal").checked, true, "copy preserves the original-delete choice");
  await ensureSaveSources(["session"], "overwrite", false);
  sourceFile.lastModified = 35;
  await assert.rejects(ensureSaveSources(["session"], "overwrite", false), /error\.sourceChanged/);
  sourceFile.lastModified = 34;
  state.sourceAccess.delete("session");
  syncApplyMode();
  assert.equal(elements.get("#applyOverwriteMode").disabled, true);
  assert.equal(elements.get("#deleteOriginal").disabled, true);
  assert.match(source, /async function initialise\(\)[\s\S]*?await api\("\/api\/images"\)/);

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
  assert.equal(elements.get("#pickFolder").disabled, true);
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
  assert.equal(elements.get("#jobProgress").hidden, true);
  assert.equal(elements.get("#jobProgressText").hidden, true);
  for (const terminalState of ["cancelled", "error", "idle"]) {
    updateProgress({ kind: "detect", state: terminalState, total: 80, completed: 80 });
    assert.equal(elements.get("#jobProgress").hidden, true, `${terminalState} must not show stale progress`);
    assert.equal(elements.get("#jobProgressText").hidden, true, `${terminalState} must not show stale progress`);
  }
  assert.equal(elements.get("#pickFolder").disabled, false);
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
  resolvePendingFetch("/api/mask/first/stale-one", { ok: false, status: 404 });
  resolvePendingFetch("/api/mask/first/stale-two", { ok: false, status: 404 });
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

  // A successful selection always replaces stale gallery aggregates with the
  // candidate bundle returned for that image.
  const countSyncedImage = { id: "count-sync", relativePath: "count-sync.png", width: 60, height: 40, candidateCount: 9, enabledCandidateCount: 7 };
  state.images = [countSyncedImage];
  state.currentId = null;
  state.currentImage = null;
  const countSyncedSelection = selectImage("count-sync");
  resolveFetch({ ok: true, json: async () => ({ candidates: [] }) });
  await countSyncedSelection;
  assert.equal(countSyncedImage.candidateCount, 0);
  assert.equal(countSyncedImage.enabledCandidateCount, 0);

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

  // Candidate deletion is queued behind an in-flight toggle. A stale toggle
  // failure cannot reload and resurrect the row selected for deletion.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  state.candidateDeleting.clear();
  state.images = [{ id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 2, enabledCandidateCount: 2 }];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 61;
  state.manualMaskPresent = false;
  const deletingCandidate = { id: "delete-after-update", className: "penis", confidence: 0.91, enabled: false, color: "#ffffff" };
  const remainingCandidate = { id: "remaining", className: "pussy", confidence: 0.88, enabled: true, color: "#ffffff" };
  state.candidates = [deletingCandidate, remainingCandidate];
  state.candidateImages = new Map([[deletingCandidate.id, {}], [remainingCandidate.id, {}]]);
  const mutationRequestStart = requests.length;
  const pendingUpdate = updateCandidate(deletingCandidate, true);
  const pendingDelete = deleteCandidate(deletingCandidate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, mutationRequestStart + 1);
  assert.equal(requests.at(-1).options.method, "POST");
  renderCandidates();
  const deletingRow = candidateList.children[0];
  const remainingRow = candidateList.children[1];
  assert.equal(deletingRow.children[0].disabled, true);
  assert.equal(deletingRow.children[3].disabled, true);
  assert.equal(remainingRow.children[0].disabled, false);
  assert.equal(remainingRow.children[3].disabled, false);
  resolveFetch({ ok: false, status: 500, json: async () => ({ error: "stale update failed" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).options.method, "DELETE");
  assert.equal(requests.at(-1).path, "/api/candidate/first/delete-after-update");
  resolveFetch({ ok: true, json: async () => ({ deleted: true }) });
  await Promise.all([pendingUpdate, pendingDelete]);
  const serializedMutations = requests.slice(mutationRequestStart);
  assert.deepEqual(serializedMutations.map((request) => request.options.method), ["POST", "DELETE"]);
  assert.equal(serializedMutations.some((request) => request.path === "/api/candidates/first"), false);
  assert.deepEqual(state.candidates.map((candidate) => candidate.id), ["remaining"]);
  assert.equal(state.candidateImages.has(deletingCandidate.id), false);
  assert.equal(state.images[0].candidateCount, 1);
  assert.equal(state.images[0].enabledCandidateCount, 1);

  // A deletion that finishes after navigation still updates the deleted
  // image's aggregate counts and cached mask state, not the new editor image.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  state.candidateDeleting.clear();
  const deleteTarget = { id: "delete-target", relativePath: "delete-target.png", width: 100, height: 80, candidateCount: 2, enabledCandidateCount: 1 };
  const deleteOther = { id: "delete-other", relativePath: "delete-other.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 };
  state.images = [deleteTarget, deleteOther];
  state.currentId = deleteTarget.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 62;
  const offscreenDeleted = { id: "offscreen-delete", className: "penis", confidence: 0.92, enabled: true, color: "#ffffff" };
  const offscreenRemaining = { id: "offscreen-remaining", className: "pussy", confidence: 0.61, enabled: false, color: "#ffffff" };
  state.candidates = [offscreenDeleted, offscreenRemaining];
  state.candidateImages = new Map([[offscreenDeleted.id, {}], [offscreenRemaining.id, {}]]);
  state.maskStatus.set(deleteTarget.id, true);
  combinedMaskPresent = false;
  const offscreenDelete = deleteCandidate(offscreenDeleted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).options.method, "DELETE");
  state.currentId = deleteOther.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration += 1;
  state.candidates = [{ id: "other-candidate", className: "penis", confidence: 0.8, enabled: true, color: "#ffffff" }];
  state.candidateImages = new Map([["other-candidate", {}]]);
  resolveFetch({ ok: true, json: async () => ({ deleted: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/delete-target");
  resolveFetch({ ok: true, json: async () => ({ candidates: [offscreenRemaining] }) });
  await offscreenDelete;
  assert.equal(deleteTarget.candidateCount, 1);
  assert.equal(deleteTarget.enabledCandidateCount, 0);
  assert.equal(state.maskStatus.get(deleteTarget.id), false);
  assert.equal(state.currentId, deleteOther.id);
  assert.deepEqual(state.candidates.map((candidate) => candidate.id), ["other-candidate"]);

  // A failed optimistic toggle is rolled back for its source image even when
  // that image is no longer displayed.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  const failedUpdateTarget = { id: "failed-update", relativePath: "failed-update.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 0 };
  const failedUpdateOther = { id: "failed-update-other", relativePath: "other.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [failedUpdateTarget, failedUpdateOther];
  state.currentId = failedUpdateTarget.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 64;
  const failedOffscreenCandidate = { id: "failed-offscreen", className: "penis", confidence: 0.75, enabled: false, color: "#ffffff" };
  state.candidates = [failedOffscreenCandidate];
  state.maskStatus.set(failedUpdateTarget.id, false);
  const failedOffscreenUpdate = updateCandidate(failedOffscreenCandidate, true, true);
  await new Promise((resolve) => setImmediate(resolve));
  state.currentId = failedUpdateOther.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration += 1;
  state.candidates = [];
  state.candidateImages.clear();
  resolveFetch({ ok: false, status: 500, json: async () => ({ error: "toggle failed" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/failed-update");
  resolveFetch({ ok: true, json: async () => ({ candidates: [{ ...failedOffscreenCandidate, enabled: true }] }) });
  await failedOffscreenUpdate;
  assert.equal(failedUpdateTarget.candidateCount, 1);
  assert.equal(failedUpdateTarget.enabledCandidateCount, 1);
  assert.equal(state.maskStatus.get(failedUpdateTarget.id), true);
  assert.equal(state.currentId, failedUpdateOther.id);

  // Mutations for different candidates on one image are serialized. If A
  // fails and B then succeeds after navigation, B's server aggregate wins and
  // the image remains a save target. The stored manual draft is untouched.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  const aggregateTarget = { id: "aggregate-target", relativePath: "aggregate.png", width: 100, height: 80, candidateCount: 2, enabledCandidateCount: 2 };
  const aggregateOther = { id: "aggregate-other", relativePath: "other.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [aggregateTarget, aggregateOther];
  state.currentId = aggregateTarget.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 65;
  const aggregateA = { id: "aggregate-a", className: "penis", confidence: 0.8, enabled: true, color: "#ffffff" };
  const aggregateB = { id: "aggregate-b", className: "pussy", confidence: 0.8, enabled: true, color: "#ffffff" };
  state.candidates = [aggregateA, aggregateB];
  state.candidateImages = new Map([[aggregateA.id, {}], [aggregateB.id, {}]]);
  state.maskStatus.set(aggregateTarget.id, true);
  const preservedDraft = {
    add: "data:image/png;base64,manual",
    exclusion: "data:image/png;base64,exclusion",
    manualEnabled: false,
    manualMaskPresent: true,
    visibleCandidateIds: [aggregateA.id, aggregateB.id],
    manualVisible: false,
  };
  state.drafts = new Map([[aggregateTarget.id, preservedDraft]]);
  const aggregateUpdateA = updateCandidate(aggregateA, false, false);
  const aggregateUpdateB = updateCandidate(aggregateB, false, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidate/aggregate-target/aggregate-a");
  state.currentId = aggregateOther.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration += 1;
  state.candidates = [];
  state.candidateImages.clear();
  resolveFetch({ ok: false, status: 500, json: async () => ({ error: "A failed" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/aggregate-target");
  resolveFetch({ ok: true, json: async () => ({ candidates: [
    { ...aggregateA, enabled: false },
    { ...aggregateB, enabled: false },
  ] }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidate/aggregate-target/aggregate-b");
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/aggregate-target");
  resolveFetch({ ok: true, json: async () => ({ candidates: [
    { ...aggregateA, enabled: false },
    { ...aggregateB, enabled: true },
  ] }) });
  await Promise.all([aggregateUpdateA, aggregateUpdateB]);
  assert.equal(aggregateTarget.candidateCount, 2);
  assert.equal(aggregateTarget.enabledCandidateCount, 1);
  assert.equal(state.maskStatus.get(aggregateTarget.id), true);
  assert.equal(saveTargets().includes(aggregateTarget.id), true);
  assert.equal(state.drafts.get(aggregateTarget.id), preservedDraft);
  assert.equal(state.drafts.get(aggregateTarget.id).manualEnabled, false);

  // Visibility is captured from actual destination-out composition. An enabled
  // candidate fully covered by exclusion stays out of saveTargets, while a
  // disabled but geometrically visible candidate remains in the visibility cache.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  const excludedTarget = { id: "excluded-target", relativePath: "excluded.png", width: 100, height: 80, candidateCount: 2, enabledCandidateCount: 1 };
  const excludedOther = { id: "excluded-other", relativePath: "other.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [excludedTarget, excludedOther];
  state.currentId = excludedTarget.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 66;
  const excludedB = { id: "excluded-b", className: "penis", confidence: 0.9, enabled: true, color: "#ffffff" };
  const visibleDisabledC = { id: "visible-disabled-c", className: "pussy", confidence: 0.8, enabled: false, color: "#ffffff" };
  const excludedBImage = { _alpha: new Uint8Array([1, 0]) };
  const visibleDisabledCImage = { _alpha: new Uint8Array([0, 1]) };
  state.candidates = [excludedB, visibleDisabledC];
  state.candidateImages = new Map([[excludedB.id, excludedBImage], [visibleDisabledC.id, visibleDisabledCImage]]);
  const addMask = createdCanvases[0];
  const exclusionMask = createdCanvases[1];
  const combinedMask = createdCanvases[2];
  for (const canvas of [addMask, exclusionMask, combinedMask]) {
    canvas._usePixelAlpha = true;
    canvas._alpha.fill(0);
  }
  addMask._alpha.set([0, 1]);
  exclusionMask._alpha.set([1, 0]);
  state.manualMaskPresent = true;
  state.manualEnabled = false;
  state.maskStatus.set(excludedTarget.id, false);
  const excludedUpdate = updateCandidate(excludedB, false, false);
  saveDraft();
  const excludedDraft = state.drafts.get(excludedTarget.id);
  assert.deepEqual(JSON.parse(JSON.stringify(excludedDraft.visibleCandidateIds)), [visibleDisabledC.id]);
  assert.equal(excludedDraft.manualVisible, true);
  assert.deepEqual([...combinedMask._alpha], [0, 0]);
  state.manualEnabled = true;
  buildCombinedMask();
  assert.deepEqual([...combinedMask._alpha], [0, 1]);
  state.manualEnabled = false;
  buildCombinedMask();
  assert.deepEqual([...combinedMask._alpha], [0, 0]);
  await new Promise((resolve) => setImmediate(resolve));
  state.currentId = excludedOther.id;
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration += 1;
  state.candidates = [];
  state.candidateImages.clear();
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/excluded-target");
  resolveFetch({ ok: true, json: async () => ({ candidates: [{ ...excludedB, enabled: true }, visibleDisabledC] }) });
  await excludedUpdate;
  assert.equal(excludedTarget.candidateCount, 2);
  assert.equal(excludedTarget.enabledCandidateCount, 1);
  assert.equal(state.maskStatus.get(excludedTarget.id), false);
  assert.equal(saveTargets().includes(excludedTarget.id), false);
  assert.equal(state.drafts.get(excludedTarget.id), excludedDraft);
  assert.equal(excludedDraft.manualEnabled, false);
  for (const canvas of [addMask, exclusionMask, combinedMask]) {
    canvas._usePixelAlpha = false;
    canvas._alpha.fill(0);
  }

  // Save entry points wait for candidate mutations instead of opening or
  // submitting against stale server state.
  state.candidateUpdateChains.clear();
  state.candidateUpdateVersions.clear();
  state.images = [{ id: "save-wait", relativePath: "save-wait.png", width: 100, height: 80, candidateCount: 2, enabledCandidateCount: 2 }];
  state.currentId = "save-wait";
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 66;
  state.job = null;
  state.importing = false;
  combinedMaskPresent = true;
  state.maskStatus.set("save-wait", true);
  const saveWaitDeleted = { id: "save-wait-deleted", className: "penis", confidence: 0.9, enabled: true, color: "#ffffff" };
  const saveWaitCandidate = { id: "save-wait-candidate", className: "pussy", confidence: 0.8, enabled: true, color: "#ffffff" };
  state.candidates = [saveWaitDeleted, saveWaitCandidate];
  state.candidateImages = new Map([[saveWaitDeleted.id, {}], [saveWaitCandidate.id, {}]]);
  elements.get("#applyDialog").close();
  const saveCurrentMutation = deleteCandidate(saveWaitDeleted);
  const pendingSaveCurrent = saveCurrent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#saveButton").disabled, true);
  assert.equal(elements.get("#saveAllButton").disabled, true);
  assert.equal(elements.get("#applyDialog").open, false);
  assert.equal(requests.at(-1).path, "/api/candidate/save-wait/save-wait-deleted");
  resolveFetch({ ok: true, json: async () => ({ deleted: true }) });
  await Promise.all([saveCurrentMutation, pendingSaveCurrent]);
  assert.equal(elements.get("#applyDialog").open, true);

  elements.get("#applyDialog").close();
  const saveAllMutation = updateCandidate(saveWaitCandidate, false, true);
  const pendingSaveAll = saveAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#applyDialog").open, false);
  resolveFetch({ ok: true, json: async () => ({ ok: true }) });
  await Promise.all([saveAllMutation, pendingSaveAll]);
  assert.equal(elements.get("#applyDialog").open, true);

  // Manual strokes are represented by one accessible virtual candidate. Its
  // toggle controls preview/save inclusion without clearing the stored mask.
  state.images = [{ id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 }];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.candidates = [];
  state.candidateImages.clear();
  state.manualMaskPresent = true;
  state.manualEnabled = true;
  state.history = [];
  state.historyIndex = -1;
  renderCandidates();
  assert.equal(candidateList.children.length, 1);
  const manualRow = candidateList.children[0];
  assert.equal(manualRow.tagName, "DIV");
  assert.equal(manualRow.className, "candidate-row candidate-row-manual candidate-row-manual-apply");
  assert.equal(manualRow.children.length, 4);
  assert.equal(manualRow.children[2].textContent, "手書き");
  assert.equal(manualRow.children[0].attributes["aria-label"], "手書きモザイクを使用");
  assert.equal(manualRow.children[3].attributes["aria-label"], "手書きを削除");
  assert.equal(manualRow.children[3].title, "手書きを削除");
  manualRow.children[0].checked = false;
  manualRow.children[0].dispatch("change");
  assert.equal(state.manualEnabled, false);
  saveDraft();
  const disabledManualDraft = draftPayload(["first"]).first;
  assert.equal(disabledManualDraft.add, "");
  assert.equal(disabledManualDraft.exclusion, "data:image/png;base64,test");
  const combinedContext = createdCanvases[2]._context;
  combinedContext.drawImageCalls = [];
  buildCombinedMask();
  assert.equal(combinedContext.drawImageCalls.some(([image]) => image === createdCanvases[0]), false);
  manualRow.children[0].checked = true;
  manualRow.children[0].dispatch("change");
  combinedContext.drawImageCalls = [];
  buildCombinedMask();
  assert.equal(combinedContext.drawImageCalls.some(([image]) => image === createdCanvases[0]), true);

  // Undo/Redo is deliberately limited to brush/eraser stroke completion. A
  // manual-toggle or clear starts a fresh baseline and cannot restore it.
  resetHistoryToCurrentManualMask();
  const addClearBeforeDelete = createdCanvases[0]._context.clearRectCalls;
  const exclusionClearBeforeDelete = createdCanvases[1]._context.clearRectCalls;
  manualRow.children[3].click();
  assert.equal(createdCanvases[0]._context.clearRectCalls, addClearBeforeDelete + 1);
  assert.equal(createdCanvases[1]._context.clearRectCalls, exclusionClearBeforeDelete);
  assert.equal(state.manualMaskPresent, false);
  assert.equal(candidateList.children[0].className, "candidate-empty");
  assert.equal(state.history.length, 0);
  assert.equal(elements.get("#undoButton").disabled, true);

  // A brush completion immediately enables Undo. History keeps semantic
  // strokes only, never full-canvas data URLs.
  const strokeAdd = createdCanvases[0];
  const strokeExclusion = createdCanvases[1];
  for (const target of [strokeAdd, strokeExclusion]) {
    target._usePixelAlpha = true;
    target._alpha.fill(0);
  }
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  resetHistoryToCurrentManualMask();
  beginManualStroke({ x: 4, y: 4 });
  appendManualStrokePoint({ x: 12, y: 4 });
  completeManualStroke();
  assert.equal(elements.get("#undoButton").disabled, false);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].tool, "brush");
  assert.ok(state.history[0].points.length >= 2);
  assert.doesNotMatch(JSON.stringify(state.history), /data:image|base64/i);
  restoreSnapshot(0);
  assert.equal(elements.get("#redoButton").disabled, false);
  restoreSnapshot(1);
  assert.equal(elements.get("#undoButton").disabled, false);

  // Once the 12-stroke history cap is crossed, the dropped oldest stroke is
  // baked into the single baseline canvas instead of disappearing on Undo.
  resetHistoryToCurrentManualMask();
  const historyBaselineStrokeCalls = createdCanvases[6]._context.strokeCalls;
  for (let index = 0; index < 13; index += 1) {
    beginManualStroke({ x: index, y: 10 });
    completeManualStroke();
  }
  assert.equal(state.history.length, 12);
  assert.equal(state.history[0].points[0].x, 1);
  assert.ok(createdCanvases[6]._context.strokeCalls > historyBaselineStrokeCalls);
  restoreSnapshot(11);
  assert.equal(state.historyIndex, 11);
  for (const target of [strokeAdd, strokeExclusion]) {
    target._usePixelAlpha = false;
    target._alpha.fill(0);
  }

  // A transient commit failure retries the same idempotency token. A definitive
  // 4xx response does not retry it.
  const retryPromise = commitBrowserSaveWithRetry({ imageId: "first", candidateRevision: 1, saveToken: "retry", sourceAction: "keep" });
  resolveFetch({ ok: false, status: 503, json: async () => ({ error: "temporary" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/save/commit");
  resolveFetch({ ok: true, status: 200, json: async () => ({ cleared: true }) });
  assert.equal((await retryPromise).cleared, true);

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

  // Copy-save with delete-original keeps a completed image's reviewed state
  // when the server preserves its ID but changes its relative path.
  const reviewedOldPath = { id: "migrated", relativePath: "old.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const reviewedNewPath = { ...reviewedOldPath, relativePath: "old_censored.png" };
  state.images = [reviewedOldPath];
  state.currentId = null;
  state.currentImage = null;
  state.reviewRoot = "g:\\images\\apply";
  state.reviewedPaths = new Set(["old.png"]);
  storage.set("mozarie.reviewed.v1:g:\\images\\apply:old.png", "true");
  state.applyFinishing = false;
  const reviewedPathMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["migrated"], completedImageIds: ["migrated"], startedAt: 302 });
  resolveFetch({ ok: true, json: async () => ({ images: [reviewedNewPath] }) });
  await reviewedPathMigration;
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\apply:old.png"), false);
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\apply:old_censored.png"), "true");
  assert.equal(isReviewed(reviewedNewPath), true);

  // A second tab can finish the same copy-delete job after the first one has
  // already removed the old key. The reviewed result must remain intact.
  const idempotentOldPath = { id: "idempotent", relativePath: "idempotent.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const idempotentNewPath = { ...idempotentOldPath, relativePath: "idempotent_censored.png" };
  const idempotentOldKey = "mozarie.reviewed.v1:g:\\images\\apply:idempotent.png";
  const idempotentNewKey = "mozarie.reviewed.v1:g:\\images\\apply:idempotent_censored.png";
  storage.set(idempotentOldKey, "true");
  storage.delete(idempotentNewKey);
  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.has(idempotentOldKey), false);
  assert.equal(storage.get(idempotentNewKey), "true");
  assert.equal(isReviewed(idempotentNewPath), true);

  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.get(idempotentNewKey), "true");
  assert.equal(isReviewed(idempotentNewPath), true);

  storage.delete(idempotentOldKey);
  storage.delete(idempotentNewKey);
  state.reviewedPaths = new Set(["idempotent.png"]);
  moveReviewedPathAfterApply(idempotentOldPath, idempotentNewPath);
  assert.equal(storage.has(idempotentNewKey), false);
  assert.equal(isReviewed(idempotentNewPath), false);

  // Storage is the source of truth when another tab changed the old path just
  // before this tab migrated it.
  const storageWinsOldPath = { id: "storage-wins", relativePath: "storage-wins.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const storageWinsNewPath = { ...storageWinsOldPath, relativePath: "storage-wins_censored.png" };
  state.images = [storageWinsOldPath];
  state.reviewedPaths = new Set();
  storage.set("mozarie.reviewed.v1:g:\\images\\apply:storage-wins.png", "true");
  state.applyFinishing = false;
  const storageWinsMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["storage-wins"], completedImageIds: ["storage-wins"], startedAt: 307 });
  resolveFetch({ ok: true, json: async () => ({ images: [storageWinsNewPath] }) });
  await storageWinsMigration;
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\apply:storage-wins_censored.png"), "true");
  assert.equal(isReviewed(storageWinsNewPath), true);

  // If another tab already migrated the state, the new key is authoritative
  // even when this tab still has the old path selected in memory.
  const storageMissingOldPath = { id: "storage-missing", relativePath: "storage-missing.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const storageMissingNewPath = { ...storageMissingOldPath, relativePath: "storage-missing_censored.png" };
  state.images = [storageMissingOldPath];
  state.reviewedPaths = new Set(["storage-missing.png"]);
  storage.delete("mozarie.reviewed.v1:g:\\images\\apply:storage-missing.png");
  storage.set("mozarie.reviewed.v1:g:\\images\\apply:storage-missing_censored.png", "true");
  state.applyFinishing = false;
  const storageMissingMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["storage-missing"], completedImageIds: ["storage-missing"], startedAt: 308 });
  resolveFetch({ ok: true, json: async () => ({ images: [storageMissingNewPath] }) });
  await storageMissingMigration;
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\apply:storage-missing_censored.png"), "true");
  assert.equal(isReviewed(storageMissingNewPath), true);

  // An unreviewed source remains unreviewed at its new path, while any stale
  // record at that path is removed.
  const unreviewedOldPath = { id: "unreviewed", relativePath: "plain.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const unreviewedNewPath = { ...unreviewedOldPath, relativePath: "plain_censored.png" };
  state.images = [unreviewedOldPath];
  state.reviewedPaths = new Set();
  storage.delete("mozarie.reviewed.v1:g:\\images\\apply:plain.png");
  storage.delete("mozarie.reviewed.v1:g:\\images\\apply:plain_censored.png");
  state.applyFinishing = false;
  const unreviewedPathMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["unreviewed"], completedImageIds: ["unreviewed"], startedAt: 303 });
  resolveFetch({ ok: true, json: async () => ({ images: [unreviewedNewPath] }) });
  await unreviewedPathMigration;
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\apply:plain.png"), false);
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\apply:plain_censored.png"), false);
  assert.equal(isReviewed(unreviewedNewPath), false);

  // Storage failures do not prevent the in-session reviewed state from moving.
  const storageGetItem = context.localStorage.getItem;
  const storageSetItem = context.localStorage.setItem;
  const storageRemoveItem = context.localStorage.removeItem;
  const memoryOnlyOldPath = { id: "memory-only", relativePath: "memory.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const memoryOnlyNewPath = { ...memoryOnlyOldPath, relativePath: "memory_censored.png" };
  state.images = [memoryOnlyOldPath];
  state.reviewedPaths = new Set(["memory.png"]);
  context.localStorage.getItem = () => { throw new Error("storage unavailable"); };
  context.localStorage.setItem = () => { throw new Error("storage unavailable"); };
  context.localStorage.removeItem = () => { throw new Error("storage unavailable"); };
  state.applyFinishing = false;
  const memoryOnlyMigration = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["memory-only"], completedImageIds: ["memory-only"], startedAt: 304 });
  resolveFetch({ ok: true, json: async () => ({ images: [memoryOnlyNewPath] }) });
  await memoryOnlyMigration;
  assert.equal(isReviewed(memoryOnlyNewPath), true);
  assert.equal(state.reviewedPaths.has("memory.png"), false);
  context.localStorage.getItem = storageGetItem;
  context.localStorage.setItem = storageSetItem;
  context.localStorage.removeItem = storageRemoveItem;

  // A normal copy creates a new ID, so it must never inherit review state.
  const copiedSource = { id: "source", relativePath: "source.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  const copiedOutput = { id: "copy", relativePath: "source_censored.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [copiedSource];
  state.reviewedPaths = new Set(["source.png"]);
  storage.set("mozarie.reviewed.v1:g:\\images\\apply:source.png", "true");
  state.applyFinishing = false;
  const normalCopy = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["source"], completedImageIds: ["source"], startedAt: 305 });
  resolveFetch({ ok: true, json: async () => ({ images: [copiedSource, copiedOutput] }) });
  await normalCopy;
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\apply:source.png"), "true");
  assert.equal(isReviewed(copiedOutput), false);

  // Overwrite retains the same path, so reviewed state remains untouched.
  state.images = [copiedSource];
  state.reviewedPaths = new Set(["source.png"]);
  state.applyFinishing = false;
  const overwritten = finishApplyJob({ kind: "apply", state: "complete", completed: 1, imageIds: ["source"], completedImageIds: ["source"], startedAt: 306 });
  resolveFetch({ ok: true, json: async () => ({ images: [copiedSource] }) });
  await overwritten;
  assert.equal(isReviewed(copiedSource), true);

  // A tab that did not start detection must use the server job's immutable
  // target IDs, rather than its own stale local target list.
  const detectedTarget = { id: "detected", relativePath: "detected.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [detectedTarget];
  state.currentId = null;
  state.currentImage = null;
  state.reviewRoot = "g:\\images\\detect";
  state.reviewedPaths = new Set(["detected.png", "fallback.png"]);
  storage.set("mozarie.reviewed.v1:g:\\images\\detect", '["detected.png", "fallback.png"]');
  state.detectionTargetIds = ["fallback"];
  state.pageLoadedAt = 1000;
  state.handledDetectionStartedAt = null;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 999 }, { kind: "idle", state: "idle" }), false);
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 1001 }, { kind: "idle", state: "idle" }), true);
  state.handledDetectionStartedAt = 1001;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 1001 }, { kind: "idle", state: "idle" }), false);
  state.handledDetectionStartedAt = null;
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 999 }, { kind: "detect", state: "running", startedAt: 999 }), true);
  const crossTabDetection = finishDetectionJob({ kind: "detect", state: "complete", imageIds: ["detected"], startedAt: 777 });
  resolveFetch({ ok: true, json: async () => ({ images: [detectedTarget] }) });
  await crossTabDetection;
  assert.equal(isReviewed(detectedTarget), false);
  assert.equal(state.reviewedPaths.has("fallback.png"), true);
  assert.equal(state.handledDetectionStartedAt, 777);
  assert.equal(isTerminalDetection({ kind: "detect", state: "complete", startedAt: 777 }, { kind: "detect", state: "complete", startedAt: 777 }), false);

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
  state.reviewRoot = "g:\\images\\work";
  state.reviewedPaths = new Set();
  setReviewed(state.images[0], true);
  assert.equal(isReviewed(state.images[0]), true);
  assert.equal(isReviewed(state.images[1]), false);
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\work:first.png"), "true");
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\work:second.png"), false);
  state.reviewedPaths = new Set();
  loadReviewedPaths();
  assert.equal(isReviewed(state.images[0]), true);
  state.reviewRoot = "g:\\images\\other";
  loadReviewedPaths();
  assert.equal(isReviewed(state.images[0]), false);
  state.reviewRoot = "g:\\images\\work";
  loadReviewedPaths();
  storage.set("mozarie.reviewed.v1:g:\\images\\work:second.png", "true");
  state.reviewedPaths = new Set();
  setReviewed(state.images[0], true);
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\work:first.png"), "true");
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\work:second.png"), "true");
  markImagesUnreviewed(["first"]);
  assert.equal(storage.has("mozarie.reviewed.v1:g:\\images\\work:first.png"), false);
  assert.equal(storage.get("mozarie.reviewed.v1:g:\\images\\work:second.png"), "true");
  handleReviewStorageEvent({ key: "mozarie.reviewed.v1:g:\\images\\work:first.png", newValue: "true" });
  assert.equal(isReviewed(state.images[0]), true);
  handleReviewStorageEvent({ key: "mozarie.reviewed.v1:g:\\images\\work:first.png", newValue: null });
  assert.equal(isReviewed(state.images[0]), false);
  handleReviewStorageEvent({ key: "mozarie.reviewed.v1:g:\\images\\work:second.png", newValue: "true" });
  assert.equal(isReviewed(state.images[1]), true);
  const overviewSentinel = {
    sentinel: true,
    dataset: { id: "sentinel" },
    remove() {
      const index = overviewGrid.children.indexOf(this);
      if (index >= 0) overviewGrid.children.splice(index, 1);
    },
  };
  overviewGrid.children = [overviewSentinel];
  const writesBeforeNoop = storageWrites;
  state.viewMode = "edit";
  const gallerySentinel = {
    sentinel: true,
    dataset: { id: "sentinel" },
    remove() {
      const index = gallery.children.indexOf(this);
      if (index >= 0) gallery.children.splice(index, 1);
    },
  };
  gallery.children = [gallerySentinel];
  setReviewed(state.images[1], true);
  renderOverview();
  assert.equal(storageWrites, writesBeforeNoop);
  assert.equal(overviewGrid.children[0], overviewSentinel);
  setReviewed(state.images[0], false);
  assert.equal(overviewGrid.children[0], overviewSentinel);
  assert.equal(gallery.children[0], gallerySentinel);
  setReviewed(state.images[0], true);
  setReviewed(state.images[1], false);
  state.overviewFilter = "unreviewed";
  assert.deepEqual(JSON.parse(JSON.stringify(overviewImages().map((image) => image.id))), ["second"]);
  assert.equal(nextUnreviewedImage()?.id, "second");
  setViewMode("overview");
  assert.equal(overviewGrid.children.filter((item) => item.dataset.id === "second").length, 1);
  state.overviewFilter = "all";
  state.images = [
    { id: "nested", relativePath: "A/B/C/file.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "sibling", relativePath: "A/D/file.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(overviewFolderOptions())), ["A", "A/B", "A/B/C", "A/D"]);
  state.overviewFolder = "A/B";
  assert.deepEqual(JSON.parse(JSON.stringify(overviewImages().map((image) => image.id))), ["nested"]);
  state.overviewFolder = "";
  state.viewMode = "edit";
  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "third", relativePath: "third.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.reviewedPaths = new Set(["second.png"]);
  setViewMode("overview");
  overviewGrid.children.find((item) => item.dataset.id === "first").click();
  assert.equal(state.viewMode, "edit");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  state.navigationShortcutsEnabled = false;
  const disabledEnter = keyEvent("Enter");
  assert.equal(handleNavigationKeydown(disabledEnter), false);
  assert.equal(disabledEnter.prevented, false);
  assert.equal(isReviewed(state.images[0]), false);
  state.navigationShortcutsEnabled = true;
  elements.get("#applyDialog").open = false;
  assert.equal(navigationShortcutAction(keyEvent("ArrowRight", { shiftKey: true })), "nextUnreviewed");
  assert.equal(navigationShortcutAction(keyEvent("Home")), "first");
  assert.equal(navigationShortcutAction(keyEvent("End")), "last");
  document.activeElement = { tagName: "INPUT" };
  assert.equal(navigationShortcutAction(keyEvent("g")), null);
  document.activeElement = null;
  elements.get("#confirmDialog").open = true;
  assert.equal(navigationShortcutAction(keyEvent("g")), null);
  elements.get("#confirmDialog").open = false;
  const toggleOverview = keyEvent("g");
  assert.equal(handleNavigationKeydown(toggleOverview), true);
  assert.equal(toggleOverview.prevented, true);
  assert.equal(state.viewMode, "overview");
  assert.equal(document.activeElement, elements.get("#overviewPane"));
  setViewMode("edit");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  const shortcutCheckbox = elements.get("#navigationShortcutsEnabled");
  shortcutCheckbox.focus();
  shortcutCheckbox.checked = true;
  shortcutCheckbox.dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/api/settings", { ok: true, json: async () => ({ settings: state.settings, status: { models: {} } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  runNavigationAction(() => {});
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  const space = keyEvent(" ", { code: "Space" });
  state.navigationShortcutsEnabled = false;
  assert.equal(handleEditorKeydown(space), false);
  assert.equal(space.prevented, false);
  const undo = keyEvent("z", { ctrlKey: true });
  assert.equal(handleEditorKeydown(undo), true);
  assert.equal(undo.prevented, true);
  state.viewMode = "overview";
  const overviewSpace = keyEvent(" ", { code: "Space" });
  assert.equal(handleEditorKeydown(overviewSpace), false);
  assert.equal(overviewSpace.prevented, false);
  const overviewUndo = keyEvent("z", { ctrlKey: true });
  assert.equal(handleEditorKeydown(overviewUndo), false);
  assert.equal(overviewUndo.prevented, false);
  state.viewMode = "edit";
  state.navigationShortcutsEnabled = true;
  const shiftRight = keyEvent("ArrowRight", { shiftKey: true });
  assert.equal(handleNavigationKeydown(shiftRight), true);
  assert.equal(shiftRight.prevented, true);
  assert.equal(requests.at(-1).path, "/api/candidates/third");
  resolvePendingFetch("/api/candidates/third", { ok: true, json: async () => ({ candidates: [] }) });
  await new Promise((resolve) => setImmediate(resolve));
  const requestCountBeforeEnter = requests.length;
  const enter = keyEvent("Enter");
  assert.equal(handleNavigationKeydown(enter), true);
  assert.equal(enter.prevented, true);
  assert.equal(isReviewed(state.images[2]), true);
  assert.equal(requests.length, requestCountBeforeEnter, "reviewing the last image must not start another selection request");
  rebuildMosaicPreview();
  paintMosaicPreview();
  saveAll();

  const importedFiles = [
    { name: "first.png", webkitRelativePath: "album/first.png" },
    { name: "ignored.txt" },
    { name: "second.webp" },
  ];
  const importing = importFiles(importedFiles);
  assert.equal(state.importing, true);
  resolveFetch({ ok: true, json: async () => ({ images: state.images, imported: [] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images, imported: [] }) });
  await importing;
  const importRequests = requests.filter((request) => request.path === "/api/import/file");
  assert.equal(importRequests.length, 2);
  assert.equal(importRequests[0].options.headers["Content-Type"], "application/octet-stream");
  assert.equal(importRequests[0].options.headers["X-Mozarie-Relative-Path"], "album%2Ffirst.png");
  assert.equal(importRequests[0].options.body, importedFiles[0]);
  assert.equal(importRequests[1].options.body, importedFiles[2]);
  assert.equal(state.importing, false);

  // Import mappings bind browser-only source handles to the returned image id.
  let clientKeyCounter = 0;
  context.crypto.randomUUID = () => `mapped-${++clientKeyCounter}`;
  const handledFile = { name: "handled.png", size: 9, lastModified: 77 };
  const handledSource = { kind: "file", name: handledFile.name, async getFile() { return handledFile; }, async queryPermission() { return "granted"; } };
  const mappedImport = importFiles([{ file: handledFile, relativePath: "nested/handled.png", fileHandle: handledSource, parentHandle: { name: "nested" } }]);
  await new Promise((resolve) => setImmediate(resolve));
  const mappedRequest = requests.at(-1);
  const mappedClientKey = decodeURIComponent(mappedRequest.options.headers["X-Mozarie-Client-Key"]);
  resolveFetch({ ok: true, json: async () => ({ images: [{ id: "handled", sourceKind: "session", relativePath: "nested/handled.png", width: 10, height: 10 }], imported: [{ clientKey: mappedClientKey, imageId: "handled" }] }) });
  await mappedImport;
  assert.equal(state.sourceAccess.get("handled").fileHandle, handledSource);
  assert.equal(state.sourceAccess.get("handled").parentHandle.name, "nested");

  const dragged = await directFilesFromDrop({
    items: [{ getAsFileSystemHandle: () => Promise.resolve(handledSource) }],
    files: [],
  });
  assert.equal(dragged[0].fileHandle, handledSource, "drag-and-drop retains the file handle through import");

  let openFileOptions = null;
  let openDirectoryOptions = null;
  context.window.showOpenFilePicker = async (options) => { openFileOptions = options; return []; };
  context.window.showDirectoryPicker = async (options) => { openDirectoryOptions = options; return { async *values() {} }; };
  await pickImageFiles();
  await pickImageDirectory();
  assert.equal(openFileOptions.multiple, true);
  assert.equal(openDirectoryOptions.mode, "readwrite");

  const imageInput = elements.get("#importImagesInput");
  const requestCountBeforeCancel = requests.length;
  const catalogBeforeCancel = JSON.stringify(state.images);
  imageInput.files = [];
  imageInput.value = "previous-selection";
  imageInput.dispatch("change");
  assert.equal(imageInput.value, "");
  assert.equal(requests.length, requestCountBeforeCancel);
  assert.equal(JSON.stringify(state.images), catalogBeforeCancel);

  const folderInput = elements.get("#importFolderInput");
  folderInput.value = "same-folder";
  const folderImport = importFiles([{ name: "nested.png", webkitRelativePath: "source/nested/nested.png" }]);
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await folderImport;
  folderInput.value = "";
  assert.equal(folderInput.value, "");
  const folderRequest = requests.at(-1);
  assert.equal(folderRequest.options.headers["X-Mozarie-Relative-Path"], "source%2Fnested%2Fnested.png");

  const savedFiles = new Map([["image_censored.png", { name: "image_censored.png" }]]);
  const fakeDirectory = {
    async getFileHandle(name, options = {}) {
      if (savedFiles.has(name)) return savedFiles.get(name);
      if (!options.create) { const error = new Error("missing"); error.name = "NotFoundError"; throw error; }
      const handle = {
        name,
        async getFile() { return { size: 0, lastModified: Date.now() }; },
        async createWritable() { return { async write() {}, async close() { savedFiles.set(name, handle); } }; },
      };
      return handle;
    },
    async getDirectoryHandle() { return this; },
  };
  context.window.showDirectoryPicker = async (options) => {
    assert.equal(options.id, "mozarie-output");
    assert.equal(options.mode, "readwrite");
    return fakeDirectory;
  };
  assert.equal(await pickOutputDirectory(), fakeDirectory);
  assert.equal((await uniqueOutputFile(fakeDirectory, "image.png", "_censored")).name, "image_censored_2.png");
  context.window.showDirectoryPicker = async () => { const error = new Error("cancel"); error.name = "AbortError"; throw error; };
  await assert.rejects(pickOutputDirectory(), /error\.directoryPickerCancelled/);

  // Empty editor canvases never retain a full-resolution Data URL draft.
  state.currentId = "empty-draft";
  state.currentImage = { width: 100, height: 80 };
  state.candidates = [];
  state.candidateImages.clear();
  state.drafts.set("empty-draft", { add: "data:image/png;base64,old", exclusion: "", manualEnabled: true });
  for (const canvas of [addMask, exclusionMask, combinedMask]) {
    canvas._usePixelAlpha = true;
    canvas._alpha.fill(0);
  }
  saveDraft();
  assert.equal(state.drafts.has("empty-draft"), false);
  addMask._alpha[0] = 1;
  state.manualMaskPresent = true;
  saveDraft();
  assert.match(state.drafts.get("empty-draft").add, /^data:image\/png/);
  assert.equal(state.drafts.get("empty-draft").exclusion, "");
  for (const canvas of [addMask, exclusionMask, combinedMask]) {
    canvas._usePixelAlpha = false;
    canvas._alpha.fill(0);
  }

  const addContext = addMask._context;
  const exclusionContext = exclusionMask._context;
  state.currentImage = { width: 100, height: 80 };
  state.candidates = [];
  state.candidateImages.clear();

  state.currentId = "restore-add-only";
  state.imageGeneration = 701;
  state.drafts = new Map([[state.currentId, {
    add: "data:image/png;base64,add-only",
    exclusion: "",
    manualEnabled: true,
    manualMaskPresent: true,
  }]]);
  addContext.drawImageCalls = [];
  exclusionContext.drawImageCalls = [];
  restoreDraft(state.currentId, state.imageGeneration);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(addContext.drawImageCalls.length, 1);
  assert.equal(addContext.drawImageCalls[0][0]._src, "data:image/png;base64,add-only");
  assert.equal(exclusionContext.drawImageCalls.length, 0);

  state.currentId = "restore-exclusion-only";
  state.imageGeneration = 702;
  state.drafts = new Map([[state.currentId, {
    add: "",
    exclusion: "data:image/png;base64,exclusion-only",
    manualEnabled: true,
    manualMaskPresent: false,
  }]]);
  addContext.drawImageCalls = [];
  exclusionContext.drawImageCalls = [];
  restoreDraft(state.currentId, state.imageGeneration);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(addContext.drawImageCalls.length, 0);
  assert.equal(exclusionContext.drawImageCalls.length, 1);
  assert.equal(exclusionContext.drawImageCalls[0][0]._src, "data:image/png;base64,exclusion-only");

  state.candidateUpdateVersions.set("old:row", 1);
  state.candidateDeleting.add("old:row");
  resetCatalog([], "");
  assert.equal(state.candidateUpdateVersions.size, 0);
  assert.equal(state.candidateDeleting.size, 0);

  // Loading either language refreshes dynamic detection labels and model status,
  // and parameterized strings never leak unresolved placeholders to the UI.
  state.settings = { general: { language: "en" } };
  state.settingsStatus = { models: { target: { configured: true, valid: true, detail: "ready" } } };
  const englishLoad = loadTranslations();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await englishLoad;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(elements.get("#detectModeStandard").textContent, "Standard");
  assert.equal(elements.get("#detectModeHighPrecision").textContent, "High precision");
  assert.equal(elements.get("#settingsModelStatus").textContent, "");
  for (const rendered of [
    t("apply.complete", { completed: 3 }),
    t("apply.completeWithStale", { completed: 3, stale: 1 }),
    t("overview.count", { visible: 2, total: 7 }),
    t("editor.calculatedPixels", { value: 13 }),
  ]) assert.doesNotMatch(rendered, /\{[^}]+\}/, `English UI leaked an unresolved placeholder: ${rendered}`);

  state.settings.general.language = "ja";
  const japaneseLoad = loadTranslations();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => translationFixtures.ja });
  await japaneseLoad;
  assert.equal(document.documentElement.lang, "ja");
  assert.equal(elements.get("#detectModeStandard").textContent, translationFixtures.ja["detectDialog.standard"]);
  assert.equal(elements.get("#settingsModelStatus").textContent, "");

  // Selecting a language updates immediately, while closing without Save
  // restores the persisted language. The settings shortcut control itself
  // does not alter the active global shortcut setting before Save.
  state.settings.general.shortcuts_enabled = true;
  elements.get("#settingsShortcuts").checked = false;
  elements.get("#settingsShortcuts").dispatch("change");
  assert.equal(state.navigationShortcutsEnabled, true);
  elements.get("#settingsLanguage").value = "en";
  elements.get("#settingsLanguage").dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.lang, "en");
  elements.get("#settingsDialog").close();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => translationFixtures.ja });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.lang, "ja");

  // Saving settings into another language loads that dictionary before the
  // success message is rendered, so the result cannot be left in the old UI language.
  const japaneseSettings = {
    general: { language: "ja", open_browser: true, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "target.onnx", hand_detection: "hand.onnx", sam_checkpoint: "sam.pth", sam_model_type: "vit_b", provider: "cpu" },
    display: { apply_color: "#ff0000", exclude_color: "#00ffff", overlay_opacity: 0.5, mosaic_preview: true },
    detection: { threshold: 0.5, parallelism: 2, mode: "standard" },
  };
  const englishSettings = { ...japaneseSettings, general: { ...japaneseSettings.general, language: "en" } };
  setSettingsForm(japaneseSettings, { models: { target: { configured: true, valid: true, detail: "ready" } } });
  state.translations = translationFixtures.ja;
  elements.get("#settingsLanguage").value = "en";
  let preventedSettingsSubmit = false;
  const languageSwitchSave = saveSettings({ preventDefault() { preventedSettingsSubmit = true; } });
  assert.equal(preventedSettingsSubmit, true);
  resolvePendingFetch("/api/settings", { ok: true, json: async () => ({ settings: englishSettings, status: { models: { target: { configured: true, valid: true, detail: "ready" } } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settingsResult").textContent, "", "settings success text waits for the replacement language dictionary");
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await languageSwitchSave;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(elements.get("#settingsResult").textContent, translationFixtures.en["settings.saved"]);

  assert.equal(pendingFetches.length, 0, `every mocked fetch must be resolved before this test completes: ${pendingFetches.map((item) => item.path).join(", ")}`);
  testReachedEnd = true;
  clearTimeout(completionWatchdog);
  console.log("test_app_js: passed (reached end with no pending fetches)");
})().catch((error) => { clearTimeout(completionWatchdog); console.error(error); process.exitCode = 1; });
