const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const translationFixtures = Object.fromEntries(["en", "ja"].map((language) => [
  language,
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "static", "i18n", `${language}.json`), "utf8")),
]));
for (const language of ["en", "ja"]) {
  const source = fs.readFileSync(path.join(__dirname, "..", "static", "i18n", `${language}.json`), "utf8");
  const keys = [...source.matchAll(/^  "([^"]+)":/gm)].map((match) => match[1]);
  assert.equal(new Set(keys).size, keys.length, `${language} translations do not repeat keys`);
}

function element(tagName = "") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(), disabled: false, checked: false, textContent: "", className: "", hidden: false, value: "", style: {}, dataset: {}, attributes: {}, children: [],
    classList: {
      contains(name) { return classes.has(name); },
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    }, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, contains(target) { return target === this || this.children.includes(target); }, addEventListener(type, listener) { listeners.set(type, listener); }, setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] ?? null; }, removeAttribute(name) { delete this.attributes[name]; }, showModal() { this.open = true; }, close() { this.open = false; listeners.get("close")?.({ currentTarget: this, target: this }); }, matches(selector) { return selector === ":popover-open" && Boolean(this.popoverOpen); }, hidePopover() { this.hidePopoverCalls = (this.hidePopoverCalls || 0) + 1; this.popoverOpen = false; listeners.get("toggle")?.({ currentTarget: this, target: this }); }, focus(options) { document.activeElement = this; this.focusOptions = options; }, click() { this.clickCalls = (this.clickCalls || 0) + 1; this.focus(); const event = { currentTarget: this, target: this }; listeners.get("click")?.(event); this.onclick?.(event); }, dispatch(type, event = {}) { listeners.get(type)?.({ currentTarget: this, target: this, ...event }); }, scrollIntoView() {},
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
  "editorCanvas", "canvasStage", "canvasToolRail", "detectAllButton", "detectCurrentButton", "clearCurrentMasksButton", "clearAllMasksButton", "clearCatalogButton", "saveAllButton", "saveButton", "removeCurrentImageButton", "galleryFilter", "pickFolder", "pickImages", "pickFolderFiles", "pickerMenu", "importImagesInput", "importFolderInput", "mosaicPreviewButton", "folderPath", "brushTool", "eraserTool", "boundaryTool", "rectangleTool", "boundaryModeMenu", "polygonTool", "boundaryBrushTool", "boundaryActions", "boundaryDetectButton", "boundaryCancelButton", "fitButton", "undoButton", "redoButton", "brushSize", "confidence", "confidenceValue", "detectDialog", "detectForm", "detectTargetCount", "detectConfidenceRange", "detectConfidenceNumber", "detectParallelism", "detectCancelButton", "detectStartButton", "settingsModelStatus", "settingsDialog", "settingsCloseButton",
  "overviewButton", "previousImageButton", "nextImageButton", "nextUnreviewedButton", "reviewAndNextButton", "removeAndNextButton", "imagePosition", "imageInfo", "reviewStatus", "closeOverviewButton", "overviewPane", "overviewGrid", "overviewCount", "overviewQuery", "overviewFolder", "confirmDialog", "settingsShortcutsEnabled",
  "status", "statusLine", "processingDialog", "processingTitle", "processingCurrent", "processingProgress", "processingProgressText", "processingPauseButton", "processingCancelButton", "gallery", "galleryEmptyState", "galleryFilteredEmptyState", "galleryDropOverlay", "candidateList", "candidateStatus", "divisor", "blockSizeValue", "batchMoreButton", "batchMoreMenu", "catalogContextMenu", "toggleReviewMenuItem", "removeImageMenuItem", "overviewEmptyState", "collapseGalleryButton", "collapseInspectorButton", "galleryPane", "galleryPaneContent", "candidatePane", "candidatePaneContent",
  "applyTargetCount", "applyBlockSize", "applyDivisor", "applyProgressPanel", "applyStartButton", "applyCloseButton", "applyPauseButton", "applyCancelButton", "applySettings", "applyResult", "applySuffix", "applySuffixRow", "deleteOriginal", "deleteOriginalRow", "applyDialog", "applyCopyMode", "applyOverwriteMode", "applyOverwriteRow", "applyTemporarySourceNote", "applyOutputDirectoryRow", "applyOutputDirectoryStatus", "chooseOutputDirectoryButton", "removeAfterSave", "settingsLanguage", "settingsOpenBrowser", "settingsPort", "settingsDefaultOutputDirectory", "settingsChooseOutputDirectory", "settingsImportParallelism", "settingsSaveParallelism", "settingsTargetModel", "settingsNtd11Model", "settingsSensitiveModel", "settingsHandModel", "settingsHandSegmentationModel", "settingsSamModel", "settingsSamType", "settingsProvider", "settingsApplyColor", "settingsExcludeColor", "settingsOpacity", "settingsMosaicPreview", "settingsToolPosition", "settingsResult", "settingsVersion", "settingsNtd11Card", "settingsSensitiveCard", "settingsHandCard", "settingsHandSegmentationCard", "settingsPrecisionCard", "settingsFluidCard", "settingsNtd11Toggle", "settingsSensitiveToggle", "settingsHandToggle", "settingsHandSegmentationToggle", "settingsPrecisionToggle", "settingsFluidToggle", "modelHelpDialog", "modelHelpTitle", "modelHelpText", "modelHelpSamTable", "modelHelpCloseButton", "batchModeButton", "overviewSelectionBar", "selectionActionsButton", "selectionActionsMenu", "selectionCount", "selectionClearButton", "bucketToleranceControl", "confirmCandidateDelete", "confirmCandidateRoleDelete", "confirmOverwriteSource", "confirmCandidateRoleDelete", "confirmOverwriteSource", "confirmDeleteSourceAfterCopy", "updateToast",
]) {
  const value = element();
  value.id = id;
  elements.set(`#${id}`, value);
}
elements.get("#applySuffix").value = "_censored";
elements.get("#statusLine").hidden = true;
elements.get("#applyDivisor").value = "100";
elements.get("#divisor").value = "100";
elements.get("#detectParallelism").value = "2";
for (const id of ["settingsButton", "settingsStatusButton", "settingsStatusResult", "checkUpdateButton", "updateStatus", "settingsGpuDevice"]) {
  const value = element(); value.id = id; elements.set(`#${id}`, value);
}
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
elements.get("#editorCanvas").getContext = () => ({ clearRect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, closePath() {}, arc() {}, fill() {}, stroke() {}, clip() {}, setLineDash() {} });
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
const settingsTabs = [
  ["settingsTabGeneral", "general"], ["settingsTabModels", "models"], ["settingsTabDisplay", "display"], ["settingsTabHelp", "help"], ["settingsTabInfo", "info"],
].map(([id, name]) => {
  const tab = element("button"); tab.id = id; tab.dataset.settingsTab = name; elements.set(`#${id}`, tab); return tab;
});
const settingsPanels = [
  ["settingsPanelGeneral", "general"], ["settingsPanelModels", "models"], ["settingsPanelDisplay", "display"], ["settingsPanelHelp", "help"], ["settingsPanelInfo", "info"],
].map(([id, name]) => {
  const panel = element("section"); panel.id = id; panel.dataset.settingsPanel = name; elements.set(`#${id}`, panel); return panel;
});
const modelCards = [
  ["settingsNtd11Toggle", "ntd11"], ["settingsSensitiveToggle", "sensitive"], ["settingsHandToggle", "hand_detection"], ["settingsHandSegmentationToggle", "hand_segmentation"],
].map(([id, modelToggle]) => {
  const toggle = elements.get(`#${id}`); toggle.dataset.modelToggle = modelToggle; return toggle;
});
for (const [toggleId, cardId] of [["settingsNtd11Toggle", "settingsNtd11Card"], ["settingsSensitiveToggle", "settingsSensitiveCard"], ["settingsHandToggle", "settingsHandCard"], ["settingsHandSegmentationToggle", "settingsHandSegmentationCard"], ["settingsPrecisionToggle", "settingsPrecisionCard"], ["settingsFluidToggle", "settingsFluidCard"]]) {
  const toggle = elements.get(`#${toggleId}`);
  toggle.closest = (selector) => selector === ".model-card" ? elements.get(`#${cardId}`) : null;
}
elements.get("#boundaryModeMenu").children = [elements.get("#rectangleTool"), elements.get("#polygonTool"), elements.get("#boundaryBrushTool")];

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
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, closePath() {}, fill() {}, clip() {}, stroke() { this.strokeCalls += 1; },
    getImageData() {
      if (!target._usePixelAlpha) return { data: new Uint8ClampedArray(combinedMaskPresent ? [0, 0, 0, 255] : [0, 0, 0, 0]) };
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
const documentListeners = new Map();
const document = {
  addEventListener(type, listener) { documentListeners.set(type, listener); },
  querySelector: (selector) => {
    if (selector === 'input[name="saveMode"]:checked') return { value: elements.get("#applyOverwriteMode").checked ? "overwrite" : "copy" };
    return selector === ".studio-grid" ? studioGrid : (elements.get(selector) || element());
  },
  querySelectorAll: (selector) => {
    if (selector === "button, input, select, textarea") return [...elements.values()].filter((item) => item.id);
    if (selector === "dialog") return [elements.get("#confirmDialog"), elements.get("#applyDialog"), elements.get("#detectDialog")];
    if (selector === ".settings-tab") return settingsTabs;
    if (selector === "[data-settings-panel]") return settingsPanels;
    if (selector === "[data-model-toggle]") return modelCards;
    return [];
  },
  createElement: (tag) => tag === "canvas" ? canvasElement() : element(tag),
};
document.activeElement = null;
document.documentElement = { lang: "ja" };
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
const workerInstances = [];
const scheduledTimers = new Map(); let nextTimerId = 1;
class WorkerMock {
  constructor(url) { this.url = url; this.terminated = false; workerInstances.push(this); }
  postMessage(data, transfer) { this.message = data; this.transfer = transfer; }
  terminate() { this.terminated = true; }
}
const context = {
  console, document, Date, Math, Promise, Uint8Array, Uint8ClampedArray, Int32Array, ArrayBuffer, structuredClone, AbortController, DOMException, Worker: WorkerMock, crypto: { randomUUID: () => "test-client-key" }, navigator: { locks: { async request(_name, _options, callback) { return callback(); } } }, window: { devicePixelRatio: 1, addEventListener(type, listener) { windowListeners.set(type, listener); } }, setInterval() {}, setTimeout(callback, delay) { const id = nextTimerId++; scheduledTimers.set(id, { callback, delay }); return id; }, clearTimeout(id) { scheduledTimers.delete(id); }, requestAnimationFrame(callback) { callback(); }, ResizeObserver: class { observe() {} }, createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
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
    if (String(path).startsWith("/api/image/")) return Promise.resolve({ ok: true, blob: async () => ({}) });
    return new Promise((resolve) => {
      const pending = { path: `${path}#${fetchCalls}`, resolve };
      pendingFetches.push(pending);
      resolveFetch = (response) => {
        settlePendingFetch(pending, response);
      };
    });
  },
};

const staticRoot = path.join(__dirname, "..", "static");
const manifest = fs.readFileSync(path.join(staticRoot, "js", "manifest.js"), "utf8");
const scriptOrder = [...manifest.matchAll(/"([a-z-]+\.js)"/g)].map((match) => match[1]);
assert.deepEqual(scriptOrder, ["core.js", "resources.js", "gallery.js", "editor-canvas.js", "editor-masks.js", "detection.js", "save.js", "interaction.js", "settings.js", "app.js"]);
let source = scriptOrder.map((name) => fs.readFileSync(path.join(staticRoot, "js", name), "utf8")).join("\n");
assert.doesNotMatch(source, /setInterval\(\s*render\s*,/);
const markup = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
assert.match(markup, /data-i18n="settings\.genitalDetection"/);
assert.match(markup, /data-i18n="settings\.exclusionProcessing"/);
assert.equal((markup.match(/role="switch"/g) || []).length, 6, "six optional processing switches are rendered");
assert.doesNotMatch(markup, /modelProfileHelp|modelsRequired|補助セグメンテーション|SAM チェックポイント/);
assert.doesNotMatch(source, /model-card-toggle|aria-pressed.*model/);
assert.equal(translationFixtures.ja["settings.models"], "検出");
assert.equal(translationFixtures.en["settings.models"], "Detection");
assert.equal(translationFixtures.ja["settings.precisionModel"], "自動検出の輪郭を補正");
assert.equal(translationFixtures.en["settings.fluidExclusion"], "Detect white-fluid candidates");
assert.equal(translationFixtures.ja["detectDialog.help"], "高いほど誤検出は減りますが、見逃しは増えます。");
assert.equal(translationFixtures.en["detectDialog.help"], "Higher values reduce false positives but can miss targets.");
assert.equal(translationFixtures.ja["detection.help"], "高いほど誤検出は減りますが、見逃しは増えます。");
assert.equal(translationFixtures.en["detection.help"], "Higher values reduce false positives but can miss targets.");
assert.match(markup, /id="boundaryActions"[^>]*hidden/);
assert.match(markup, /id="boundaryModeMenu"[^>]*hidden/);
assert.match(markup, /<div class="appbar-spacer" aria-hidden="true"><\/div>\s*<button id="settingsButton"/);
assert.match(markup, /<div id="statusLine" class="status-line" hidden><div id="status"/);
assert.match(markup, /<div id="status" class="status" aria-live="polite"><\/div>/);
assert.doesNotMatch(markup, /status\.chooseFolder/);
assert.doesNotMatch(markup, /appbar-actions|appbar-status|selectionActionBar/);
assert.doesNotMatch(markup, /id="polygonActions"|id="polygonDetectButton"|id="polygonCancelButton"/);
assert.match(styles, /\.boundary-actions\[hidden\]\s*\{\s*display:\s*none/);
assert.match(styles, /\.settings-dialog\s*\{\s*width:\s*min\(680px/);
assert.match(markup, /id="settingsTabGeneral"[^>]*aria-controls="settingsPanelGeneral"[^>]*aria-selected="true"[^>]*tabindex="0"/);
assert.match(markup, /id="settingsPanelGeneral"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsTabGeneral"/);
for (const id of ["imageInfo", "reviewStatus", "candidateStatus", "applyOutputDirectoryStatus"]) {
  assert.match(markup, new RegExp(`id="${id}"[^>]*data-i18n-dynamic`));
}
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
  source = source.replace(/\ninitialise\(\);\s*$/, "\nglobalThis.__mosaicTest = { state, t, loadTranslations, setSettingsForm, renderModelStatus, updateSelectionActionBar, clearBatchSelection, updateBoundaryActions, boundaryActionAnchor, cancelBoundary, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, clearBoundaryInteraction, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, renderCandidates, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, importSingleFile, importFileHandles, importDirectoryHandle, directFilesFromDrop, loadCandidateBundle, selectImage, updateCandidate, deleteCandidate, deleteManualMask, saveDraft, restoreDraft, draftPayload, buildCombinedMask, restoreSnapshot, beginManualStroke, appendManualStrokePoint, completeManualStroke, resetHistoryToCurrentManualMask, rebuildManualMaskFromHistory, commitBrowserSaveWithRetry, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, persistNavigationShortcuts, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, ensureSaveSources, pickImageFiles, pickImageDirectory, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence, pickOutputDirectory, runBrowserSave, removeImageFromCatalog, removeCompletedImagesFromCatalog, setGalleryDropOverlay, fillAt, cancelFillWork, originalCanvas, originalCtx };\n");
  source = source.replace("renderCandidates, overviewFolderOptions", "renderCandidates, selectCatalogImage, selectOverviewImage, updateGalleryCurrent, overviewFolderOptions");
  source = source.replace("deleteManualMask, saveDraft", "deleteManualMask, batchCandidateOperation, saveDraft");
  source = source.replace("runNavigationAction, setNavigation", "runNavigationAction, runSelectionAction, setNavigation");
  source = source.replace("globalThis.__mosaicTest = {", "globalThis.__mosaicTest = { saveSettings, resetSettings, openSettings, settingsPayload, setPrecisionDetectionEnabled, setFluidExclusionEnabled, applyToolPosition, handleToolRailKeydown, render, setStatus, setStatusKey, clearStatus, canDetectBoundary, clearEditor, closeBoundaryModeMenu, setBoundaryModeMenuOpen, selectSettingsTab, moveSettingsTab, boundaryRequests, addBoundaryDraft, beginBoundaryBrushStroke, appendBoundaryBrushPoint, completeBoundaryBrushStroke, drawBoundaryScrim, polygonPointsValid, rectangleDraftAt,");
vm.runInNewContext(source, context, { filename: "static/app.js" });
  const { openSettings } = context.__mosaicTest;
  const { batchCandidateOperation } = context.__mosaicTest;
  const { runSelectionAction } = context.__mosaicTest;
  const { state, t, loadTranslations, setSettingsForm, renderModelStatus, updateSelectionActionBar, clearBatchSelection, saveSettings, settingsPayload, setPrecisionDetectionEnabled, setFluidExclusionEnabled, applyToolPosition, handleToolRailKeydown, updateBoundaryActions, boundaryActionAnchor, cancelBoundary, clampPoint, roiFromPoints, boundaryDragStarted, addBoundaryCandidate, clearBoundaryInteraction, saveCurrent, saveAll, startApplyFromDialog, finishApplyJob, finishDetectionJob, pollJob, isBusy, updateActionButtons, updateProgress, isTerminalApply, isTerminalDetection, calculatedBlockSize, imageHasMask, saveTargets, rebuildMosaicPreview, paintMosaicPreview, refreshMaskStatus, renderGallery, renderOverview, renderCatalogViews, renderCandidates, selectCatalogImage, selectOverviewImage, updateGalleryCurrent, overviewFolderOptions, setViewMode, setMosaicPreviewEnabled, importFiles, importSingleFile, importFileHandles, directFilesFromDrop, loadCandidateBundle, selectImage, updateCandidate, deleteCandidate, deleteManualMask, saveDraft, restoreDraft, draftPayload, buildCombinedMask, restoreSnapshot, beginManualStroke, appendManualStrokePoint, completeManualStroke, resetHistoryToCurrentManualMask, rebuildManualMaskFromHistory, commitBrowserSaveWithRetry, setReviewed, markImagesUnreviewed, isReviewed, loadReviewedPaths, moveReviewedPathAfterApply, overviewImages, nextUnreviewedImage, reviewAndMoveNext, runNavigationAction, setNavigationShortcutsEnabled, persistNavigationShortcuts, handleReviewStorageEvent, navigationShortcutAction, handleEditorKeydown, handleNavigationKeydown, resetCatalog, loadFolder, initialise, syncApplyMode, sourceCanOverwrite, sourceCanDelete, applyTargetsSupport, ensureSaveSources, pickImageFiles, pickImageDirectory, bindEvents, openDetectionDialog, runDetection, startDetectionFromDialog, cancelDetection, setDetectionConfidence, pickOutputDirectory, runBrowserSave, removeImageFromCatalog, removeCompletedImagesFromCatalog, setGalleryDropOverlay, fillAt, cancelFillWork, originalCanvas, originalCtx } = context.__mosaicTest;
  const { render, setStatus, setStatusKey, clearStatus, canDetectBoundary, clearEditor, closeBoundaryModeMenu, setBoundaryModeMenuOpen, selectSettingsTab, moveSettingsTab, boundaryRequests, addBoundaryDraft, beginBoundaryBrushStroke, appendBoundaryBrushPoint, completeBoundaryBrushStroke, drawBoundaryScrim, polygonPointsValid, rectangleDraftAt } = context.__mosaicTest;
  bindEvents();
  assert.equal(elements.get("#statusLine").hidden, true, "the status line starts hidden with no notification");
  clearStatus();
  assert.equal(elements.get("#statusLine").hidden, true, "clearing status hides its entire line");
  setStatus("Working", "running");
  assert.equal(elements.get("#statusLine").hidden, false, "a status message restores the compact line");
  assert.equal(elements.get("#status").textContent, "Working");
  clearStatus();
  assert.equal(elements.get("#statusLine").hidden, true);
  state.batchMode = true;
  state.selectedImageIds = new Set(["one", "two"]);
  state.selectionAnchorId = "one";
  updateSelectionActionBar();
  assert.equal(elements.get("#batchModeButton").hidden, false, "batch mode keeps its entry available in the overview heading");
  assert.equal(elements.get("#overviewSelectionBar").hidden, false, "batch controls are visible only while editing a selection");
  assert.equal(elements.get("#selectionCount").textContent, "selection.count");
  state.batchMode = false;
  clearBatchSelection();
  updateSelectionActionBar();
  assert.equal(state.selectedImageIds.size, 0, "leaving batch mode clears selected ids without retaining green state");
  assert.equal(state.selectionAnchorId, null, "leaving batch mode clears the range anchor");
  assert.equal(elements.get("#batchModeButton").hidden, false);
  assert.equal(elements.get("#overviewSelectionBar").hidden, true);
  state.images = [];
  updateActionButtons();
  assert.equal(elements.get("#batchModeButton").disabled, true, "batch edit is unavailable while the catalog is empty");
  for (const [position, orientation] of [["left", "vertical"], ["right", "vertical"], ["top", "horizontal"], ["bottom", "horizontal"]]) {
    elements.get("#boundaryModeMenu").hidden = false;
    applyToolPosition(position);
    assert.equal(elements.get("#canvasStage").dataset.toolPosition, position);
    assert.equal(elements.get("#canvasToolRail").getAttribute("aria-orientation"), orientation);
    assert.equal(elements.get("#boundaryModeMenu").hidden, true, "changing tool position closes the boundary menu");
  }
  applyToolPosition("left");
  elements.get("#brushTool").focus();
  handleToolRailKeydown({ target: elements.get("#brushTool"), key: "ArrowDown", preventDefault() {} });
  assert.equal(document.activeElement, elements.get("#eraserTool"), "vertical toolbars use up/down navigation");
  applyToolPosition("top");
  elements.get("#brushTool").focus();
  handleToolRailKeydown({ target: elements.get("#brushTool"), key: "ArrowRight", preventDefault() {} });
  assert.equal(document.activeElement, elements.get("#eraserTool"), "horizontal toolbars use left/right navigation");
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
  elements.get("#applySuffix").value = "_keep";
  elements.get("#deleteOriginal").checked = true;
  elements.get("#applyOverwriteMode").checked = true;
  elements.get("#applyCopyMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#applySuffixRow").hidden, true);
  assert.equal(elements.get("#deleteOriginalRow").hidden, true);
  assert.equal(elements.get("#applyOutputDirectoryRow").hidden, true);
  elements.get("#applyOverwriteMode").checked = false;
  elements.get("#applyCopyMode").checked = true;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, false);
  assert.equal(elements.get("#deleteOriginal").disabled, false);
  assert.equal(elements.get("#chooseOutputDirectoryButton").disabled, false);
  assert.equal(elements.get("#applySuffix").value, "_keep");
  assert.equal(elements.get("#deleteOriginal").checked, true);
  assert.equal(elements.get("#applySuffixRow").hidden, false);
  assert.equal(elements.get("#deleteOriginalRow").hidden, false);
  assert.equal(elements.get("#applyOutputDirectoryRow").hidden, false);

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
  document.visibilityState = "hidden";
  const startupSettings = {
    general: { language: "ja", open_browser: true, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "", ntd11: "", ntd11_enabled: false, sensitive: "", sensitive_enabled: false, hand_detection: "", hand_detection_enabled: false, sam_checkpoint: "", sam_model_type: "vit_b", provider: "cpu" },
    display: { apply_color: "#ff0000", exclude_color: "#00ffff", overlay_opacity: 0.5, mosaic_preview: true, tool_position: "left" },
    importing: { parallelism: 3 },
    detection: { threshold: 0.5, parallelism: 2, mode: "high_precision", fluid_exclusion_enabled: true },
    confirmations: { candidateDelete: false, candidateRoleDelete: false, overwriteSource: false, deleteSourceAfterCopy: false },
  };
  const initialiseRun = initialise();
  resolveFetch({ ok: true, json: async () => ({ settings: startupSettings, version: "v0.3.0" }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  const initialImage = { id: "initial", relativePath: "initial.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  resolveFetch({ ok: true, json: async () => ({ images: [initialImage], root: "G:/images/initial" }) });
  await initialiseRun;
  assert.equal(requests.at(-1).path, "/api/images");
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), [initialImage]);
  assert.equal(elements.get("#settingsVersion").textContent, "v0.3.0", "startup settings display the local version without an update check");
  assert.equal(requests.some((request) => request.path === "/api/update/status"), false, "hidden startup does not need an online update check to display the local version");
  state.settings = startupSettings;
  const persistShortcuts = persistNavigationShortcuts(false);
  resolveFetch({ ok: true, json: async () => ({ settings: state.settings }) });
  await persistShortcuts;
  assert.equal(elements.get("#settingsShortcutsEnabled").checked, false);
  assert.equal(state.settings.general.shortcuts_enabled, false);
  assert.equal(requests.at(-1).path, "/api/settings?status=0");
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
  resolveFetch({ ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
  await batchRemoval;
  const prefetchedBatchCandidate = pendingFetches.find((item) => item.path.startsWith("/api/candidates/batch-a"));
  if (prefetchedBatchCandidate) settlePendingFetch(prefetchedBatchCandidate, { ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
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
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { imageIds: [loadedImage.id], confidence: 1.00, parallelism: 1, targetClasses: ["penis", "pussy"] });
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
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { imageIds: [loadedImage.id], confidence: 0.67, parallelism: 2, targetClasses: ["penis", "pussy"] });
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
  state.currentId = "boundary-draft";
  state.tool = "boundary";
  state.view = { x: 0, y: 0, scale: 1 };
  state.boundaryRoi = null;
  state.boundaryDrafts = [{ id: "draft-1", type: "rectangle", roi: { left: 20, top: 340, right: 100, bottom: 390 }, point: { x: 60, y: 365 } }];
  state.boundaryActiveId = "draft-1";
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").hidden, false);
  assert.equal(elements.get("#boundaryDetectButton").disabled, false);
  assert.equal(elements.get("#boundaryActions").style.top, "294px");
  assert.equal(elements.get("#boundaryActions").style.left, "8px");
  state.tool = "polygon";
  state.boundaryDrafts = [];
  state.polygonPoints = [{ x: 10, y: 10 }];
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").hidden, false);
  assert.equal(elements.get("#boundaryDetectButton").disabled, true);
  cancelBoundary();
  assert.equal(elements.get("#boundaryActions").hidden, true);

  // Draft actions follow a temporary rectangle and remain clamped in both axes.
  state.tool = "boundary";
  state.boundaryRoi = null;
  state.boundaryStart = { x: 0, y: 0 };
  state.boundaryPoint = { x: 60, y: 40 };
  state.boundaryDragging = true;
  state.view = { x: -400, y: -300, scale: 1 };
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").hidden, false);
  assert.equal(elements.get("#boundaryDetectButton").disabled, true);
  assert.equal(elements.get("#boundaryActions").style.left, "8px");
  assert.equal(elements.get("#boundaryActions").style.top, "8px");
  state.boundaryStart = { x: 900, y: 700 };
  state.boundaryPoint = { x: 980, y: 780 };
  state.view = { x: 0, y: 0, scale: 1 };
  updateBoundaryActions();
  assert.equal(elements.get("#boundaryActions").style.left, "450px");
  assert.equal(elements.get("#boundaryActions").style.top, "354px");
  state.boundaryDragging = false;
  state.boundaryRoi = { left: 20, top: 20, right: 80, bottom: 80 };
  state.view = { x: 120, y: 100, scale: 2 };
  render();
  assert.equal(elements.get("#boundaryActions").style.left, "149px");
  assert.equal(elements.get("#boundaryActions").style.top, "268px");
  state.tool = "polygon";
  state.boundaryRoi = null;
  state.polygonPoints = [{ x: -20, y: -20 }, { x: 10, y: -20 }, { x: 10, y: 10 }, { x: -20, y: 10 }];
  state.view = { x: 0, y: 0, scale: 1 };
  render();
  assert.equal(elements.get("#boundaryActions").style.left, "8px");
  assert.equal(elements.get("#boundaryActions").style.top, "18px");
  elements.get("#boundaryDetectButton").focus();
  clearBoundaryInteraction();
  assert.equal(document.activeElement, elements.get("#editorCanvas"));

  // The mode flyout has one close path for tool selection, outside clicks and Escape.
  setBoundaryModeMenuOpen(true);
  assert.equal(elements.get("#boundaryTool").attributes["aria-expanded"], "true");
  elements.get("#rectangleTool").click();
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  assert.equal(state.tool, "boundary");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  assert.equal(elements.get("#boundaryTool").attributes["aria-expanded"], "false");
  setBoundaryModeMenuOpen(true);
  documentListeners.get("pointerdown")({ target: element() });
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  assert.equal(elements.get("#boundaryTool").attributes["aria-expanded"], "false");
  setBoundaryModeMenuOpen(true);
  windowListeners.get("keydown")({ key: "Escape", preventDefault() {} });
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  assert.equal(document.activeElement, elements.get("#boundaryTool"));
  closeBoundaryModeMenu();

  // Settings tabs form a real roving tablist.
  selectSettingsTab("models");
  assert.equal(elements.get("#settingsTabModels").attributes["aria-selected"], "true");
  assert.equal(elements.get("#settingsTabModels").tabIndex, 0);
  assert.equal(elements.get("#settingsTabGeneral").tabIndex, -1);
  assert.equal(elements.get("#settingsPanelModels").hidden, false);
  elements.get("#settingsResult").textContent = "global settings error";
  elements.get("#settingsResult").classList.add("error");
  elements.get("#settingsStatusResult").textContent = "panel-local status";
  elements.get("#settingsModelStatus").textContent = "panel-local model";
  elements.get("#updateStatus").textContent = "panel-local update";
  selectSettingsTab("models");
  assert.equal(elements.get("#settingsResult").textContent, "global settings error", "selecting the active settings tab preserves the global result");
  assert.equal(elements.get("#settingsResult").classList.contains("error"), true, "selecting the active settings tab preserves result styling");
  selectSettingsTab("missing");
  assert.equal(elements.get("#settingsResult").textContent, "global settings error", "an unknown settings tab leaves the global result alone");
  assert.equal(elements.get("#settingsTabModels").classList.contains("active"), true, "an unknown settings tab leaves the actual tab active");
  selectSettingsTab("display");
  assert.equal(elements.get("#settingsResult").textContent, "", "changing settings tabs clears the global result");
  assert.equal(elements.get("#settingsResult").classList.contains("error"), false, "changing settings tabs clears global error styling");
  assert.equal(elements.get("#settingsStatusResult").textContent, "panel-local status", "changing settings tabs preserves panel-local results");
  assert.equal(elements.get("#settingsModelStatus").textContent, "panel-local model", "changing settings tabs preserves model status");
  assert.equal(elements.get("#updateStatus").textContent, "panel-local update", "changing settings tabs preserves update status");
  moveSettingsTab({ currentTarget: elements.get("#settingsTabModels"), key: "ArrowRight", preventDefault() {} });
  assert.equal(document.activeElement, elements.get("#settingsTabDisplay"));
  moveSettingsTab({ currentTarget: elements.get("#settingsTabDisplay"), key: "End", preventDefault() {} });
  assert.equal(document.activeElement, elements.get("#settingsTabInfo"));
  moveSettingsTab({ currentTarget: elements.get("#settingsTabInfo"), key: "Home", preventDefault() {} });
  assert.equal(document.activeElement, elements.get("#settingsTabGeneral"));

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
  assert.equal(state.polygonPoints.length, 0, "a repaired valid polygon is committed after dragging a vertex");
  assert.deepEqual(JSON.parse(JSON.stringify(state.boundaryDrafts.at(-1).points[0])), { x: 18, y: 22 });
  assert.equal(state.polygonDragIndex, -1);
  state.tool = "brush";

  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "second", relativePath: "second.png", width: 100, height: 80, candidateCount: 4, enabledCandidateCount: 2 },
  ];
  state.currentId = "first";
  state.imageGeneration = 1;
  state.reviewedPaths = new Set(["first.png"]);
  state.tool = "boundary";
  state.polygonPoints = [];
  const staleBoundaryAppends = galleryAppendCount;
  state.boundaryRoi = null;
  state.boundaryDrafts = [{ id: "stale-boundary", type: "rectangle", roi: { left: 1, top: 1, right: 20, bottom: 20 }, point: { x: 8.5, y: 7.5 } }];
  state.boundaryActiveId = "stale-boundary";
  state.candidates = [];
  state.candidateImages = new Map();
  const pending = addBoundaryCandidate();
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
  state.boundaryRoi = { left: 1, top: 1, right: 20, bottom: 20 };
  state.boundaryPromptPoint = { x: 8, y: 7 };
  state.boundaryDragging = true;
  updateBoundaryActions();
  const blockedBoundaryRequests = fetchCalls;
  assert.equal(canDetectBoundary(), false);
  let draggingEnterPrevented = false;
  windowListeners.get("keydown")({ key: "Enter", preventDefault() { draggingEnterPrevented = true; } });
  assert.equal(draggingEnterPrevented, true);
  elements.get("#boundaryDetectButton").click();
  await addBoundaryCandidate({ x: 8, y: 7 });
  assert.equal(fetchCalls, blockedBoundaryRequests);
  state.boundaryDragging = false;
  state.pendingImageId = "loading";
  updateBoundaryActions();
  assert.equal(canDetectBoundary(), false);
  let loadingEnterPrevented = false;
  windowListeners.get("keydown")({ key: "Enter", preventDefault() { loadingEnterPrevented = true; } });
  assert.equal(loadingEnterPrevented, true);
  elements.get("#boundaryDetectButton").click();
  await addBoundaryCandidate({ x: 8, y: 7 });
  assert.equal(fetchCalls, blockedBoundaryRequests);
  state.pendingImageId = null;

  // Enter is always consumed by a boundary draft, even when the polygon is
  // incomplete or invalid, so it cannot mark the image reviewed or navigate.
  state.tool = "polygon";
  state.boundaryRoi = null;
  state.boundaryStart = null;
  state.boundaryPoint = null;
  state.boundaryDragging = false;
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.reviewedPaths = new Set();
  for (const points of [
    [{ x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: 12, y: 0 }],
    [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }],
    [{ x: 0, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 12 }, { x: 12, y: 0 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  ]) {
    state.polygonPoints = points.map((point) => ({ ...point }));
    const savedDraft = JSON.parse(JSON.stringify(state.polygonPoints));
    const currentBeforeEnter = state.currentId;
    const requestsBeforeEnter = fetchCalls;
    let prevented = false;
    windowListeners.get("keydown")({ key: "Enter", preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(fetchCalls, requestsBeforeEnter);
    assert.equal(state.currentId, currentBeforeEnter);
    assert.equal(isReviewed(state.images[0]), false);
    assert.deepEqual(JSON.parse(JSON.stringify(state.polygonPoints)), savedDraft);
  }
  state.tool = "boundary";
  state.polygonPoints = [];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.imageGeneration = 20;
  state.reviewRoot = "";
  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", true]]);
  combinedMaskPresent = true;
  const candidateCountBeforeBoundary = state.images[0].candidateCount;
  const galleryAppendsBeforeBoundary = galleryAppendCount;
  state.boundaryRoi = null;
  state.boundaryDrafts = [{ id: "success-boundary", type: "rectangle", roi: { left: 1, top: 1, right: 20, bottom: 20 }, point: { x: 8, y: 7 } }];
  state.boundaryActiveId = "success-boundary";
  const boundarySuccess = addBoundaryCandidate();
  const existingBoundary = { id: "boundary-existing", enabled: true, confidence: 0.9, color: "#fff", role: "apply" };
  const boundarySuccessCandidate = { id: "boundary-success", enabled: true, confidence: 0.9, color: "#fff", role: "apply" };
  resolveFetch({ ok: true, json: async () => ({ candidates: [boundarySuccessCandidate], candidateRevision: 2 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ candidates: [existingBoundary, boundarySuccessCandidate], candidateRevision: 2 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/api/mask/first/boundary-existing", { ok: true, blob: async () => ({}) });
  resolvePendingFetch("/api/mask/first/boundary-success", { ok: true, blob: async () => ({}) });
  await boundarySuccess;
  assert.equal(state.boundaryDrafts.length, 0);
  assert.equal(state.images[0].candidateCount, candidateCountBeforeBoundary + 1);
  assert.equal(isReviewed(state.images[0]), false);
  assert.equal(galleryAppendCount - galleryAppendsBeforeBoundary, state.images.length);
  assert.match(gallery.children[0].meta.textContent, /2 candidates/);
  combinedMaskPresent = false;

  state.reviewedPaths = new Set(["first.png"]);
  state.maskStatus = new Map([["first", false]]);
  const candidateCountBeforeMaskFailure = state.images[0].candidateCount;
  const maskFailureAppends = galleryAppendCount;
  state.boundaryRoi = null;
  state.boundaryDrafts = [{ id: "mask-failure-boundary", type: "rectangle", roi: { left: 1, top: 1, right: 20, bottom: 20 }, point: { x: 8, y: 7 } }];
  state.boundaryActiveId = "mask-failure-boundary";
  const boundaryMaskFailure = addBoundaryCandidate();
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

  state.boundaryRoi = null;
  state.boundaryDrafts = [{ id: "failed-boundary", type: "rectangle", roi: { left: 1, top: 1, right: 20, bottom: 20 }, point: { x: 8, y: 7 } }];
  state.boundaryActiveId = "failed-boundary";
  const boundaryFailure = addBoundaryCandidate();
  resolveFetch({ ok: false, json: async () => ({ error: "boundary failed" }) });
  await boundaryFailure;
  assert.deepEqual(JSON.parse(JSON.stringify(state.boundaryDrafts[0].roi)), { left: 1, top: 1, right: 20, bottom: 20 });

  // Boundary drafts keep creation order. Brush strokes merge by touching bounds,
  // while disconnected strokes remain independent SAM requests.
  state.boundaryDrafts = [];
  elements.get("#brushSize").value = "6";
  const rectangleDraft = addBoundaryDraft({ type: "rectangle", roi: { left: 2, top: 2, right: 20, bottom: 20 }, point: { x: 11, y: 11 } });
  beginBoundaryBrushStroke({ x: 30, y: 20 }); appendBoundaryBrushPoint({ x: 36, y: 20 }); completeBoundaryBrushStroke();
  beginBoundaryBrushStroke({ x: 36, y: 20 }); appendBoundaryBrushPoint({ x: 40, y: 20 }); completeBoundaryBrushStroke();
  beginBoundaryBrushStroke({ x: 80, y: 50 }); appendBoundaryBrushPoint({ x: 85, y: 50 }); completeBoundaryBrushStroke();
  const boundaryBatch = boundaryRequests();
  assert.equal(boundaryBatch.length, 3, "rectangle plus touching and disconnected brush selections create three requests");
  assert.equal(boundaryBatch[0].draftIds.join(","), rectangleDraft.id);
  assert.equal(boundaryBatch[1].draft.type, "brush");
  assert.equal(boundaryBatch[1].draftIds.length, 2, "touching brush strokes share one request");
  assert.equal(boundaryBatch[2].draftIds.length, 1, "disconnected brush strokes stay separate");
  const rectangleHit = rectangleDraftAt({ x: 10, y: 10 });
  assert.equal(rectangleHit.id, rectangleDraft.id, "a click inside a rectangle can retarget its SAM prompt point");
  const validPolygon = [{ x: 2, y: 2 }, { x: 20, y: 2 }, { x: 20, y: 20 }, { x: 2, y: 20 }];
  const crossedPolygon = [{ x: 2, y: 2 }, { x: 20, y: 20 }, { x: 20, y: 2 }, { x: 2, y: 20 }];
  assert.equal(polygonPointsValid(validPolygon), true);
  assert.equal(polygonPointsValid(crossedPolygon), false);
  state.boundaryDrafts.push({ id: "invalid-polygon", type: "polygon", points: crossedPolygon, roi: { left: 2, top: 2, right: 20, bottom: 20 } });
  assert.equal(boundaryRequests().some((request) => request.draftIds.includes("invalid-polygon")), false, "an invalid edited polygon is not submitted");
  assert.match(source, /globalCompositeOperation = "destination-out"/, "the boundary scrim cuts selected interiors out of the dark overlay");
  assert.match(source, /boundaryOverlayCtx\.clip\(\)/, "the boundary scrim is clipped to the displayed image");
  cancelBoundary();
  assert.equal(state.boundaryDrafts.length, 0, "boundary cancel clears every pending selection");

  // A failed item must remain after earlier items completed successfully.
  state.currentId = "first"; state.currentImage = { width: 100, height: 80 }; state.imageGeneration = 90;
  state.boundaryDrafts = [
    { id: "ordered-1", type: "rectangle", roi: { left: 1, top: 1, right: 12, bottom: 12 }, point: { x: 6, y: 6 } },
    { id: "ordered-2", type: "rectangle", roi: { left: 30, top: 10, right: 45, bottom: 30 }, point: { x: 37, y: 20 } },
  ];
  const orderedBoundary = addBoundaryCandidate();
  state.imageGeneration += 1;
  resolveFetch({ ok: true, json: async () => ({ candidates: [{ id: "ordered-candidate", enabled: true, role: "apply" }], candidateRevision: 5 }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: false, json: async () => ({ error: "second boundary failed" }) });
  await orderedBoundary;
  assert.equal(state.boundaryDrafts.length, 1, "only failed and unprocessed selections remain");
  assert.equal(state.boundaryDrafts[0].id, "ordered-2");
  const orderedRequests = requests.filter((request) => request.path === "/api/boundary").slice(-2).map((request) => JSON.parse(request.options.body).roi.left);
  assert.equal(orderedRequests.join(","), "1,30", "boundary requests are sent sequentially in draft order");

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
  assert.equal(elements.get("#applySuffixRow").hidden, true, "overwrite hides the suffix");
  assert.equal(elements.get("#deleteOriginalRow").hidden, true, "overwrite hides original deletion");
  assert.equal(elements.get("#applyOutputDirectoryRow").hidden, true, "overwrite hides the destination");
  elements.get("#applyCopyMode").checked = true;
  elements.get("#applyOverwriteMode").checked = false;
  syncApplyMode();
  assert.equal(elements.get("#applySuffix").disabled, false, "copy restores suffix editing");
  assert.equal(elements.get("#applySuffixRow").hidden, false, "copy shows suffix editing");
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
  updateProgress({ kind: "detect", state: "paused", total: 3, completed: 1 });
  assert.equal(elements.get("#processingDialog").open, true);
  updateActionButtons();
  assert.equal(elements.get("#detectCurrentButton").disabled, true);

  state.job = { state: "pausing" };
  assert.equal(isBusy(), true);
  updateProgress({ kind: "detect", state: "pausing", total: 3, completed: 1 });
  assert.equal(elements.get("#processingPauseButton").disabled, true);

  state.applyRunning = false;
  state.job = { kind: "detect", state: "running", total: 80, completed: 0 };
  updateProgress(state.job);
  assert.equal(elements.get("#processingProgressText").textContent, "0 / 80");
  assert.equal(elements.get("#pickFolder").disabled, true);
  assert.equal(elements.get("#folderPath").disabled, true);
  assert.equal(elements.get("#galleryFilter").disabled, true);
  assert.equal(elements.get("#brushTool").disabled, true);
  assert.equal(elements.get("#confidence").disabled, true);
  assert.equal(elements.get("#mosaicPreviewButton").disabled, true);
  const maskBeforeToggle = state.maskStatus.get("first");
  setMosaicPreviewEnabled(false);
  assert.equal(state.mosaicPreviewEnabled, true);
  assert.equal(state.maskStatus.get("first"), maskBeforeToggle);
  state.job = { kind: "detect", state: "complete", total: 80, completed: 80 };
  updateProgress(state.job);
  assert.equal(elements.get("#processingDialog").open, true);
  for (const terminalState of ["cancelled", "error", "idle"]) {
    updateProgress({ kind: "detect", state: terminalState, total: 80, completed: 80 });
    assert.equal(elements.get("#processingDialog").open, true, `${terminalState} must not reset the active modal`);
  }
  assert.equal(elements.get("#pickFolder").disabled, false);
  setMosaicPreviewEnabled(false);
  assert.equal(state.mosaicPreviewEnabled, false);
  assert.equal(state.maskStatus.get("first"), maskBeforeToggle);
  setMosaicPreviewEnabled(true);

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

  // A pending image switch clears the previous boundary before either async
  // dependency resolves, so its old Detect action cannot submit.
  state.images = [
    { id: "first", relativePath: "first.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
    { id: "deferred", relativePath: "deferred.png", width: 50, height: 40, candidateCount: 0, enabledCandidateCount: 0 },
  ];
  state.currentId = "first";
  state.currentImage = { width: 100, height: 80 };
  state.tool = "boundary";
  state.boundaryRoi = { left: 10, top: 10, right: 30, bottom: 30 };
  state.boundaryPromptPoint = { x: 20, y: 20 };
  for (const [key] of state.imageCache.items) state.imageCache.delete(key);
  state.imageCache.set("deferred:0", { width: 50, height: 40, src: "blob:deferred" }, 8000);
  setBoundaryModeMenuOpen(true);
  updateBoundaryActions();
  const deferredSelection = selectImage("deferred");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.pendingImageId, "deferred");
  assert.equal(state.boundaryRoi, null);
  assert.equal(elements.get("#boundaryActions").hidden, true);
  assert.equal(elements.get("#boundaryDetectButton").disabled, true);
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  elements.get("#boundaryDetectButton").click();
  assert.equal(requests.at(-1).path, "/api/candidates/deferred");
  resolveFetch({ ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
  await deferredSelection;
  state.tool = "brush";

  // A successful selection always replaces stale gallery aggregates with the
  // candidate bundle returned for that image.
  const countSyncedImage = { id: "count-sync", relativePath: "count-sync.png", width: 60, height: 40, candidateCount: 9, enabledCandidateCount: 7 };
  state.images = [countSyncedImage];
  state.currentId = null;
  state.currentImage = null;
  const countSyncedSelection = selectImage("count-sync");
  resolveFetch({ ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
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

  // A batch keeps this image selected until its server mutation succeeds, so
  // its manual mask cannot be left behind while only candidates are updated.
  state.candidateUpdateChains.clear(); state.candidateBatchPending.clear();
  const batchFirst = { id: "batch-first", relativePath: "batch-first.png", width: 100, height: 80, candidateCount: 1, enabledCandidateCount: 1 };
  const batchSecond = { id: "batch-second", relativePath: "batch-second.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 };
  state.images = [batchFirst, batchSecond];
  state.currentId = batchFirst.id; state.currentImage = { width: 100, height: 80 }; state.imageGeneration = 61;
  state.candidates = [{ id: "batch-candidate", className: "penis", confidence: 0.9, enabled: true, role: "apply", color: "#ffffff" }];
  state.candidateImages = new Map([["batch-candidate", {}]]);
  state.manualMaskPresent = true; state.manualEnabled = true;
  state.settings.confirmations = { ...(state.settings.confirmations || {}), candidateRoleDelete: false };
  const pendingBatch = batchCandidateOperation("apply:delete");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/candidates/batch");
  assert.equal(state.manualMaskPresent, true);
  updateActionButtons();
  assert.equal(elements.get("#nextImageButton").disabled, true);
  assert.equal(elements.get("#removeAndNextButton").disabled, true);
  await selectImage(batchSecond.id);
  assert.equal(state.currentId, batchFirst.id);
  resolveFetch({ ok: true, json: async () => ({ candidateRevision: 1 }) });
  await pendingBatch;
  assert.equal(state.manualMaskPresent, false);
  updateActionButtons();
  assert.equal(elements.get("#nextImageButton").disabled, false);
  assert.equal(elements.get("#removeAndNextButton").disabled, false);

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
  state.maskDirty = true;
  buildCombinedMask();
  assert.deepEqual([...combinedMask._alpha], [0, 1]);
  state.manualEnabled = false;
  state.maskDirty = true;
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
  state.settings.confirmations = { ...(state.settings.confirmations || {}), candidateDelete: false };
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
  assert.equal(state.maskDirty, false, "manual-toggle composition is already current before serialization");

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
  const timersBeforeRetry = new Set(scheduledTimers.keys());
  const retryPromise = commitBrowserSaveWithRetry({ imageId: "first", candidateRevision: 1, saveToken: "retry", sourceAction: "keep" });
  resolveFetch({ ok: false, status: 503, json: async () => ({ error: "temporary" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const retryTimer = [...scheduledTimers].find(([id, timer]) => !timersBeforeRetry.has(id) && timer.delay === 150);
  assert.ok(retryTimer, "transient commit failure schedules its first retry");
  scheduledTimers.delete(retryTimer[0]); retryTimer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/save/commit");
  resolveFetch({ ok: true, status: 200, json: async () => ({ cleared: true }) });
  assert.equal((await retryPromise).cleared, true);

  // Retry only twice after the initial request: 150ms, then 500ms. Each
  // retry keeps the original token and a final transient failure is surfaced.
  const requestCountBeforeExhaustion = requests.length;
  const timersBeforeExhaustion = new Set(scheduledTimers.keys());
  const exhaustedRetry = commitBrowserSaveWithRetry({ imageId: "first", candidateRevision: 1, saveToken: "same-token", sourceAction: "keep" });
  resolveFetch({ ok: false, status: 503, json: async () => ({ error: "temporary" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const firstExhaustionTimer = [...scheduledTimers].find(([id, timer]) => !timersBeforeExhaustion.has(id) && timer.delay === 150);
  assert.ok(firstExhaustionTimer);
  scheduledTimers.delete(firstExhaustionTimer[0]); firstExhaustionTimer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: false, status: 503, json: async () => ({ error: "temporary" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const secondExhaustionTimer = [...scheduledTimers].find(([, timer]) => timer.delay === 500);
  assert.ok(secondExhaustionTimer);
  scheduledTimers.delete(secondExhaustionTimer[0]); secondExhaustionTimer[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: false, status: 503, json: async () => ({ error: "temporary" }) });
  await assert.rejects(exhaustedRetry);
  const exhaustedRequests = requests.slice(requestCountBeforeExhaustion);
  assert.equal(exhaustedRequests.length, 3);
  assert.ok(exhaustedRequests.every((request) => request.path === "/api/save/commit" && request.options.body.includes("same-token")));

  const requestCountBeforeClientError = requests.length;
  const noRetry = commitBrowserSaveWithRetry({ imageId: "first", candidateRevision: 1, saveToken: "client-error", sourceAction: "keep" });
  resolveFetch({ ok: false, status: 400, json: async () => ({ error: "invalid" }) });
  await assert.rejects(noRetry);
  assert.equal(requests.length, requestCountBeforeClientError + 1);

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
  const crossTabCandidateRequest = pendingFetches.find((item) => item.path.startsWith("/api/candidates/target"));
  if (crossTabCandidateRequest) settlePendingFetch(crossTabCandidateRequest, { ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
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
  const reloadedCandidateRequest = pendingFetches.find((item) => item.path.startsWith("/api/candidates/target"));
  if (reloadedCandidateRequest) settlePendingFetch(reloadedCandidateRequest, { ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
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
  state.viewMode = "edit";
  const batchMoreMenu = elements.get("#batchMoreMenu");
  const selectionActionsMenu = elements.get("#selectionActionsMenu");
  batchMoreMenu.hidePopoverCalls = 0; selectionActionsMenu.hidePopoverCalls = 0;
  batchMoreMenu.popoverOpen = true; selectionActionsMenu.popoverOpen = true;
  elements.get("#batchMoreButton").setAttribute("aria-expanded", "true");
  elements.get("#selectionActionsButton").setAttribute("aria-expanded", "true");
  setViewMode("overview");
  assert.equal(batchMoreMenu.hidePopoverCalls, 1, "opening overview closes the gallery menu once");
  assert.equal(selectionActionsMenu.hidePopoverCalls, 1, "opening overview closes the selection menu once");
  assert.equal(elements.get("#batchMoreButton").getAttribute("aria-expanded"), "false");
  assert.equal(elements.get("#selectionActionsButton").getAttribute("aria-expanded"), "false");
  setViewMode("overview");
  assert.equal(batchMoreMenu.hidePopoverCalls, 1, "staying in overview does not close menus again");
  assert.equal(selectionActionsMenu.hidePopoverCalls, 1, "staying in overview does not close selection menus again");
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
  state.viewMode = "overview";
  state.batchMode = true;
  clearBatchSelection();
  renderOverview(true);
  selectOverviewImage("first");
  assert.deepEqual([...state.selectedImageIds], ["first"], "plain overview selection toggles the visible target");
  assert.equal(state.selectionAnchorId, "first", "plain overview selection updates the range anchor");
  assert.equal(state.currentId, "first", "batch selection does not change the current image");
  const currentOverviewItem = overviewGrid.children.find((item) => item.dataset.id === "first");
  assert.equal(currentOverviewItem.classList.contains("current"), true, "the current overview item keeps its current state while selected");
  assert.equal(currentOverviewItem.classList.contains("batch-selected"), true, "the current overview item also keeps its batch selection state");
  assert.equal(currentOverviewItem.getAttribute("aria-current"), "true", "the current overview item exposes current state independently");
  assert.equal(currentOverviewItem.getAttribute("aria-pressed"), "true", "the current overview item exposes selected state independently");
  selectOverviewImage("third", { shiftKey: true });
  assert.deepEqual([...state.selectedImageIds], ["first", "second", "third"], "shift selection replaces with the visible overview range");
  clearBatchSelection();
  selectOverviewImage("first");
  selectOverviewImage("third", { ctrlKey: true, shiftKey: true });
  assert.deepEqual([...state.selectedImageIds], ["first", "second", "third"], "ctrl-shift adds the visible overview range");
  state.overviewQuery = "second";
  selectOverviewImage("second", { shiftKey: true });
  assert.equal(state.selectionAnchorId, "second", "a filtered-out anchor falls back to toggling the overview target");
  assert.equal(state.viewMode, "overview", "batch selection stays in the overview");
  renderGallery(true);
  assert.equal([...state.galleryNodes.values()].some((item) => item.classList.contains("batch-selected") || item.getAttribute("aria-pressed") !== null), false, "the normal gallery never exposes batch selection state");
  state.overviewQuery = "";
  batchMoreMenu.popoverOpen = true; selectionActionsMenu.popoverOpen = true;
  setViewMode("edit");
  assert.equal(batchMoreMenu.hidePopoverCalls, 2, "returning to edit closes the gallery menu once");
  assert.equal(selectionActionsMenu.hidePopoverCalls, 2, "returning to edit closes the selection menu once");
  assert.equal(state.batchMode, false, "returning to edit exits overview batch mode");
  assert.equal(state.selectedImageIds.size, 0, "returning to edit clears overview selection");
  state.batchMode = true;
  state.selectedImageIds.add("first");
  state.selectionAnchorId = "first";
  setViewMode("overview");
  assert.equal(state.batchMode, false, "opening the overview starts without stale batch mode");
  assert.equal(state.selectedImageIds.size, 0, "opening the overview clears stale selection");
  selectionActionsMenu.popoverOpen = true;
  overviewGrid.children.find((item) => item.dataset.id === "first").click();
  assert.equal(selectionActionsMenu.hidePopoverCalls, 3, "opening an overview image closes the selection menu once");
  assert.equal(state.viewMode, "edit");
  assert.equal(document.activeElement, elements.get("#editorCanvas"));
  state.viewMode = "overview";
  state.batchMode = true;
  state.selectedImageIds = new Set(["second"]);
  state.selectionAnchorId = "second";
  state.settings.confirmations = { ...state.settings.confirmations, removeImage: false };
  const imagesBeforeBatchRemoval = [...state.images];
  const reviewedPathsBeforeBatchRemoval = new Set(state.reviewedPaths);
  renderOverview(true);
  const removeSelection = runSelectionAction("remove");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.at(-1).path, "/api/catalog/image/second", "batch removal deletes only the selected overview image");
  resolveFetch({ ok: true, json: async () => ({ images: [state.images[0], state.images[2]] }) });
  await removeSelection;
  assert.equal(state.batchMode, false, "batch removal exits batch mode after removing a subset");
  assert.equal(state.selectedImageIds.size, 0, "batch removal clears the selected ids after removing a subset");
  assert.equal(overviewGrid.children.filter((item) => !item.sentinel).some((item) => item.classList.contains("batch-selected") || item.getAttribute("aria-pressed") !== null), false, "batch removal clears selection state from surviving overview cards");
  state.images = imagesBeforeBatchRemoval;
  state.reviewedPaths = reviewedPathsBeforeBatchRemoval;
  setViewMode("edit");
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
  batchMoreMenu.popoverOpen = true;
  assert.equal(handleNavigationKeydown(toggleOverview), true);
  assert.equal(toggleOverview.prevented, true);
  assert.equal(state.viewMode, "overview");
  assert.equal(batchMoreMenu.hidePopoverCalls, 3, "overview keyboard navigation closes the gallery menu once");
  assert.equal(document.activeElement, elements.get("#overviewPane"));
  selectionActionsMenu.popoverOpen = true;
  setViewMode("edit");
  assert.equal(selectionActionsMenu.hidePopoverCalls, 4, "return navigation closes the selection menu once");
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
  resolvePendingFetch("/api/candidates/third", { ok: true, json: async () => ({ candidates: [], candidateRevision: 0 }) });
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
  state.settings = { ...(state.settings || {}), importing: { parallelism: 1 } };
  const importing = importFiles(importedFiles);
  assert.equal(state.importing, true);
  resolveFetch({ ok: true, json: async () => ({ images: state.images, imported: [] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images, imported: [] }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await importing;
  const importRequests = requests.filter((request) => request.path === "/api/import/file");
  assert.equal(importRequests.length, 2);
  assert.equal(importRequests[0].options.headers["Content-Type"], "application/octet-stream");
  assert.equal(importRequests[0].options.headers["X-Mozarie-Relative-Path"], "album%2Ffirst.png");
  assert.equal(importRequests[0].options.body, importedFiles[0]);
  assert.equal(importRequests[1].options.body, importedFiles[2]);
  assert.equal(state.importing, false);

  // Folder and multi-file imports start no more than the configured workers.
  const parallelFiles = Array.from({ length: 5 }, (_, index) => ({ name: `parallel-${index}.png` }));
  state.settings = { ...(state.settings || {}), importing: { parallelism: 3 } };
  const parallelRequestStart = requests.length;
  const parallelImport = importFiles(parallelFiles);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.slice(parallelRequestStart).filter((request) => request.path === "/api/import/file").length, 3);
  for (let index = 0; index < parallelFiles.length; index += 1) {
    resolvePendingFetch("/api/import/file", { ok: true, json: async () => ({ imported: [] }) });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(requests.slice(parallelRequestStart).filter((request) => request.path === "/api/import/file").length, 5);
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await parallelImport;
  assert.equal(state.importing, false);

  // Stopping an import still synchronizes files that already reached the server.
  const cancelledFiles = Array.from({ length: 5 }, (_, index) => ({ name: `cancelled-${index}.png` }));
  const cancelledImport = importFiles(cancelledFiles);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.slice(-3).every((request) => request.path === "/api/import/file"), true);
  state.importSession.cancelled = true;
  for (let index = 0; index < 3; index += 1) {
    resolvePendingFetch("/api/import/file", { ok: true, json: async () => ({ imported: [] }) });
    await new Promise((resolve) => setImmediate(resolve));
  }
  const partialCatalog = [{ id: "partial", relativePath: "cancelled-0.png", width: 10, height: 10 }];
  resolvePendingFetch("/api/images", { ok: true, json: async () => ({ images: partialCatalog }) });
  await cancelledImport;
  assert.deepEqual(JSON.parse(JSON.stringify(state.images)), partialCatalog);
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
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: [{ id: "handled", sourceKind: "session", relativePath: "nested/handled.png", width: 10, height: 10 }] }) });
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
  await new Promise((resolve) => setImmediate(resolve));
  resolveFetch({ ok: true, json: async () => ({ images: state.images }) });
  await folderImport;
  folderInput.value = "";
  assert.equal(folderInput.value, "");
  const folderRequest = requests.filter((request) => request.path === "/api/import/file").at(-1);
  assert.equal(folderRequest.options.headers["X-Mozarie-Relative-Path"], "source%2Fnested%2Fnested.png");


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
  setBoundaryModeMenuOpen(true);
  elements.get("#rectangleTool").focus();
  state.batchMode = true;
  state.selectedImageIds.add("old:row");
  state.selectionAnchorId = "old:row";
  resetCatalog([], "");
  assert.equal(state.candidateUpdateVersions.size, 0);
  assert.equal(state.candidateDeleting.size, 0);
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  assert.equal(state.batchMode, false, "resetting the catalog exits batch mode");
  assert.equal(state.selectedImageIds.size, 0, "resetting the catalog clears batch selection");
  assert.equal(document.activeElement, elements.get("#boundaryTool"));
  setBoundaryModeMenuOpen(true);
  elements.get("#polygonTool").focus();
  clearEditor();
  assert.equal(elements.get("#boundaryModeMenu").hidden, true);
  assert.equal(document.activeElement, elements.get("#boundaryTool"));

  // Loading either language refreshes dynamic detection labels and model status,
  // and parameterized strings never leak unresolved placeholders to the UI.
  state.settings = { general: { language: "en" }, saving: { default_output_directory: "G:\\saved-output" } };
  state.settingsStatus = { models: { target: { required: true, enabled: true, configured: true, valid: true, detail: "ready" } } };
  state.images = [{ id: "dynamic", relativePath: "dynamic-name.png", width: 20, height: 10, candidateCount: 1, enabledCandidateCount: 1 }];
  state.currentId = "dynamic";
  state.currentImage = { width: 20, height: 10 };
  state.candidates = [{ id: "dynamic-candidate", enabled: true }];
  state.reviewedPaths = new Set(["dynamic-name.png"]);
  state.job = { kind: "detect", state: "running", completed: 2, total: 4 };
  setStatus("");
  const englishLoad = loadTranslations();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await englishLoad;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(elements.get("#settingsModelStatus").textContent, "");
  const invalidModelStatuses = {
    target_segmentation: { required: true, enabled: true, configured: true, valid: true, detail: "" },
    ntd11: { required: false, enabled: true, configured: true, valid: false, reasonCode: "invalid_model" },
    hand_detection: { required: false, enabled: true, configured: true, valid: false, reasonCode: "missing" },
  };
  state.settingsStatus = { models: invalidModelStatuses };
  renderModelStatus();
  assert.equal(elements.get("#settingsModelStatus").textContent, [
    `${translationFixtures.en["settings.ntd11Model"]}: ${translationFixtures.en["settings.modelStatus.invalid_model"]}`,
    `${translationFixtures.en["settings.handModel"]}: ${translationFixtures.en["settings.modelStatus.missing"]}`,
  ].join("\n"));
  state.settingsStatus = { models: {
    target_segmentation: { required: true, enabled: true, configured: true, valid: true, detail: "" },
    ntd11: { required: false, enabled: true, configured: true, valid: false, reasonCode: "invalid_model" },
    sensitive: { required: false, enabled: false, configured: false, valid: false, detail: "" },
  } };
  renderModelStatus();
  assert.equal(elements.get("#settingsModelStatus").textContent, `${translationFixtures.en["settings.ntd11Model"]}: ${translationFixtures.en["settings.modelStatus.invalid_model"]}`);
  state.settingsStatus = { models: { target_segmentation: { required: true, enabled: true, configured: true, valid: true, detail: "ready" } } };
  renderModelStatus();
  assert.equal(elements.get("#imageInfo").textContent, "dynamic-name.png / 20 x 10");
  assert.equal(elements.get("#reviewStatus").textContent, translationFixtures.en["review.reviewed"]);
  assert.equal(elements.get("#candidateStatus").textContent, translationFixtures.en["candidates.count"].replace("{count}", "1"));
  assert.equal(elements.get("#processingProgressText").textContent, translationFixtures.en["status.progressCount"].replace("{completed}", "2").replace("{total}", "4"));
  assert.equal(elements.get("#status").textContent, "");
  assert.equal(elements.get("#applyOutputDirectoryStatus").value, "G:\\saved-output");
  for (const rendered of [
    t("apply.complete", { completed: 3 }),
    t("apply.completeWithStale", { completed: 3, stale: 1 }),
    t("overview.count", { visible: 2, total: 7 }),
    t("editor.calculatedPixels", { value: 13 }),
  ]) assert.doesNotMatch(rendered, /\{[^}]+\}/, `English UI leaked an unresolved placeholder: ${rendered}`);

  // A failed translation request is atomic: the previous dictionary and page
  // language remain in place instead of falling back to an empty UI.
  const englishDictionary = state.translations;
  const failedLanguageLoad = loadTranslations("ja");
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: false, json: async () => ({}) });
  assert.equal(await failedLanguageLoad, false);
  assert.equal(state.translations, englishDictionary);
  assert.equal(document.documentElement.lang, "en");
  const invalidJsonLanguageLoad = loadTranslations("ja");
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => { throw new Error("invalid JSON"); } });
  assert.equal(await invalidJsonLanguageLoad, false);
  assert.equal(state.translations, englishDictionary);
  assert.equal(document.documentElement.lang, "en");

  state.settings.general.language = "ja";
  setStatusKey("status.imagesLoaded", { count: 3 });
  const japaneseLoad = loadTranslations();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => translationFixtures.ja });
  await japaneseLoad;
  assert.equal(document.documentElement.lang, "ja");
  assert.equal(elements.get("#settingsModelStatus").textContent, "");
  state.settingsStatus = { models: invalidModelStatuses };
  renderModelStatus();
  assert.equal(elements.get("#settingsModelStatus").textContent, [
    `${translationFixtures.ja["settings.ntd11Model"]}: ${translationFixtures.ja["settings.modelStatus.invalid_model"]}`,
    `${translationFixtures.ja["settings.handModel"]}: ${translationFixtures.ja["settings.modelStatus.missing"]}`,
  ].join("\n"));
  state.settingsStatus = { models: { target_segmentation: { required: true, enabled: true, configured: true, valid: true, detail: "ready" } } };
  assert.equal(elements.get("#status").textContent, translationFixtures.ja["status.imagesLoaded"].replace("{count}", "3"));

  // Selecting a language updates immediately, while closing without Save
  // restores the persisted language. The settings shortcut control itself
  // does not alter the active global shortcut setting before Save.
  state.settings.general.shortcuts_enabled = true;
  elements.get("#settingsShortcutsEnabled").checked = false;
  elements.get("#settingsShortcutsEnabled").dispatch("change");
  assert.equal(state.navigationShortcutsEnabled, true);
  setStatusKey("status.applyProgress", { completed: 2, total: 4, current: "dynamic-name.png" }, "running");
  elements.get("#settingsLanguage").value = "en";
  elements.get("#settingsLanguage").dispatch("change");
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.lang, "en");
  assert.equal(elements.get("#status").textContent, translationFixtures.en["status.applyProgress"].replace("{completed}", "2").replace("{total}", "4").replace("{current}", "dynamic-name.png"));
  setStatus("raw server error", "error");
  elements.get("#settingsDialog").close();
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => translationFixtures.ja });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.documentElement.lang, "ja");
  assert.equal(elements.get("#status").textContent, "raw server error");

  // Saving settings into another language loads that dictionary before the
  // success message is rendered, so the result cannot be left in the old UI language.
  const japaneseSettings = {
    general: { language: "ja", open_browser: true, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "target.onnx", ntd11: "ntd11.onnx", ntd11_enabled: true, sensitive: "sensitive.onnx", sensitive_enabled: false, hand_detection: "hand.onnx", hand_detection_enabled: true, hand_segmentation: "hand.safetensors", hand_segmentation_enabled: true, sam_checkpoint: "sam.pth", sam_model_type: "vit_b", provider: "cpu" },
    display: { apply_color: "#ff0000", exclude_color: "#00ffff", overlay_opacity: 0.5, mosaic_preview: true },
    importing: { parallelism: 3 },
    detection: { threshold: 0.5, parallelism: 2, mode: "standard", fluid_exclusion_enabled: true },
  };
  const englishSettings = { ...japaneseSettings, general: { ...japaneseSettings.general, language: "en" }, display: { ...japaneseSettings.display, tool_position: "right" } };
  setSettingsForm(japaneseSettings, { models: { target: { required: true, enabled: true, configured: true, valid: true, detail: "ready" } } });
  assert.equal(elements.get("#settingsNtd11Toggle").checked, true);
  assert.equal(elements.get("#settingsNtd11Card").classList.contains("active"), true);
  assert.equal(elements.get("#settingsSensitiveToggle").checked, false);
  assert.equal(elements.get("#settingsSensitiveCard").classList.contains("active"), false);
  assert.equal(elements.get("#settingsHandToggle").checked, true);
  assert.equal(elements.get("#settingsHandCard").classList.contains("active"), true);
  assert.equal(elements.get("#settingsHandSegmentationToggle").checked, true);
  assert.equal(elements.get("#settingsHandSegmentationCard").classList.contains("active"), true);
  elements.get("#settingsHandSegmentationToggle").checked = false;
  elements.get("#settingsHandSegmentationToggle").dispatch("change");
  assert.equal(settingsPayload().models.hand_segmentation_enabled, false);
  assert.equal(elements.get("#settingsHandSegmentationCard").classList.contains("active"), false);
  elements.get("#settingsHandSegmentationToggle").checked = true;
  elements.get("#settingsHandSegmentationToggle").dispatch("change");
  assert.equal(elements.get("#settingsHandSegmentationCard").classList.contains("active"), true);
  assert.equal(elements.get("#settingsPrecisionToggle").checked, false);
  assert.equal(elements.get("#settingsFluidToggle").checked, true);
  selectSettingsTab("models");
  selectSettingsTab("general");
  selectSettingsTab("models");
  elements.get("#settingsSensitiveCard").click();
  assert.equal(elements.get("#settingsSensitiveToggle").checked, false, "card clicks do not toggle a switch");
  elements.get("#settingsSensitiveToggle").checked = true;
  elements.get("#settingsSensitiveToggle").dispatch("change");
  assert.equal(settingsPayload().models.sensitive_enabled, true);
  assert.equal(elements.get("#settingsSensitiveCard").classList.contains("active"), true);
  elements.get("#settingsPrecisionToggle").checked = true;
  elements.get("#settingsPrecisionToggle").dispatch("change");
  assert.equal(settingsPayload().detection.mode, "high_precision");
  elements.get("#settingsFluidToggle").checked = false;
  elements.get("#settingsFluidToggle").dispatch("change");
  assert.equal(settingsPayload().detection.fluid_exclusion_enabled, false);
  elements.get("#settingsImportParallelism").value = "0";
  assert.equal(settingsPayload().importing.parallelism, 1);
  elements.get("#settingsImportParallelism").value = "11";
  assert.equal(settingsPayload().importing.parallelism, 10);
  elements.get("#settingsImportParallelism").value = "3";
  assert.equal(settingsPayload().importing.parallelism, 3);
  elements.get("#settingsPrecisionToggle").checked = true;
  elements.get("#settingsPrecisionToggle").dispatch("change");
  elements.get("#settingsNtd11Toggle").checked = false;
  elements.get("#settingsNtd11Toggle").dispatch("change");
  elements.get("#settingsFluidToggle").checked = false;
  elements.get("#settingsFluidToggle").dispatch("change");
  elements.get("#settingsNtd11Model").value = "unsaved-ntd11.onnx";
  elements.get("#settingsSensitiveModel").value = "unsaved-sensitive.onnx";
  elements.get("#settingsHandModel").value = "unsaved-hand.onnx";
  elements.get("#settingsSamModel").value = "unsaved-sam.pth";
  elements.get("#settingsDialog").close();
  assert.equal(elements.get("#settingsPrecisionToggle").checked, false, "closing without saving restores the persisted precision mode");
  assert.equal(elements.get("#settingsNtd11Toggle").checked, true, "closing without saving restores enabled optional models");
  assert.equal(elements.get("#settingsFluidToggle").checked, true, "closing without saving restores fluid exclusion");
  assert.equal(elements.get("#settingsNtd11Model").value, "ntd11.onnx", "closing without saving restores model paths");
  assert.equal(elements.get("#settingsSensitiveModel").value, "sensitive.onnx");
  assert.equal(elements.get("#settingsHandModel").value, "hand.onnx");
  assert.equal(elements.get("#settingsSamModel").value, "sam.pth");
  resolvePendingFetch("/i18n/ja.json", { ok: true, json: async () => translationFixtures.ja });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#canvasStage").dataset.toolPosition, "left");
  elements.get("#settingsToolPosition").value = "bottom";
  assert.equal(settingsPayload().display.tool_position, "bottom");
  state.translations = translationFixtures.ja;
  selectSettingsTab("general");
  elements.get("#settingsLanguage").value = "en";
  let preventedSettingsSubmit = false;
  const languageSwitchSave = saveSettings({ preventDefault() { preventedSettingsSubmit = true; } });
  assert.equal(preventedSettingsSubmit, true);
  assert.equal(requests.at(-1).path, "/api/settings?status=0", "saving settings skips the expensive status probe");
  resolvePendingFetch("/api/settings", { ok: true, json: async () => ({ settings: englishSettings, status: { models: { target: { required: true, enabled: true, configured: true, valid: true, detail: "ready" } } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settingsResult").textContent, "", "settings success text waits for the replacement language dictionary");
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await languageSwitchSave;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(elements.get("#settingsResult").textContent, translationFixtures.en["settings.saved"]);
  assert.equal(state.settingsStatus, null, "saving leaves model and GPU status unverified");
  selectSettingsTab("general");
  assert.equal(elements.get("#settingsResult").textContent, translationFixtures.en["settings.saved"], "reselecting the saved tab preserves the save result");
  selectSettingsTab("models");
  assert.equal(elements.get("#settingsResult").textContent, "", "changing tabs after a save clears the save result");
  const resetSettingsRun = context.__mosaicTest.resetSettings();
  assert.equal(requests.at(-1).path, "/api/settings/reset?status=0", "resetting settings skips the expensive status probe");
  resolvePendingFetch("/api/settings/reset?status=0", { ok: true, json: async () => ({ settings: englishSettings, version: "v0.3.1" }) });
  await new Promise((resolve) => setImmediate(resolve));
  resolvePendingFetch("/i18n/en.json", { ok: true, json: async () => translationFixtures.en });
  await resetSettingsRun;
  assert.equal(state.settingsStatus, null, "resetting leaves model and GPU status unverified");
  const settingsRequestsBeforeReopen = requests.filter((request) => request.path.startsWith("/api/settings")).length;
  state.job = null; state.saving = false; state.saveStarting = false; state.detectionStarting = false; state.masksClearing = false; state.catalogMutation = false; state.boundaryPending = false; state.fillPending = false;
  elements.get("#settingsVersion").textContent = "v0.2.0";
  elements.get("#settingsButton").click();
  assert.equal(elements.get("#settingsDialog").open, true, "opening settings uses the already loaded settings immediately");
  assert.equal(requests.filter((request) => request.path.startsWith("/api/settings")).length, settingsRequestsBeforeReopen, "opening settings does not request model status again");
  state.settings = null;
  elements.get("#settingsButton").click();
  assert.equal(requests.at(-1).path, "/api/settings?status=0", "settings falls back to the lightweight response only when state is unavailable");
  resolvePendingFetch("/api/settings?status=0", { ok: true, json: async () => ({ settings: englishSettings, version: "v0.3.0" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settingsVersion").textContent, "v0.3.0", "the fallback updates the local version without status work");
  elements.get("#settingsTargetModel").value = "unsaved.onnx";
  elements.get("#settingsStatusButton").click();
  assert.equal(elements.get("#settingsStatusButton").disabled, true, "model and GPU status button is disabled while checking");
  resolvePendingFetch("/api/settings", { ok: true, json: async () => ({ settings: startupSettings, status: { gpus: [{ id: 2, name: "GPU" }], models: {} } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settingsTargetModel").value, "unsaved.onnx", "model status refresh does not overwrite unsaved settings");
  assert.equal(state.settingsStatus.gpus[0].id, 2, "model status refresh updates only status state");
  elements.get("#settingsStatusButton").click();
  assert.equal(elements.get("#settingsStatusResult").textContent, translationFixtures.en["settings.statusChecking"], "model status check reports loading");
  resolvePendingFetch("/api/settings", { ok: false, json: async () => ({ error: "backend" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settingsStatusResult").classList.contains("error"), true, "model status errors stay in the live result");
  elements.get("#checkUpdateButton").click();
  assert.equal(elements.get("#checkUpdateButton").disabled, true, "update check button is disabled while checking");
  resolvePendingFetch("/api/update/status", { ok: true, json: async () => ({ current: "v0.3.1", latest: "v0.3.1", available: false }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#updateStatus").textContent, translationFixtures.en["update.current"].replace("{version}", "v0.3.1"), "explicit update checks report the current release");
  elements.get("#checkUpdateButton").click();
  assert.equal(elements.get("#updateStatus").textContent, translationFixtures.en["update.checking"], "update checks report loading");
  resolvePendingFetch("/api/update/status", { ok: true, json: async () => ({ current: "v0.3.1", latest: "v0.3.2", available: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#updateStatus").textContent, translationFixtures.en["update.available"], "available updates are announced");
  elements.get("#checkUpdateButton").dataset.available = "false";
  elements.get("#checkUpdateButton").click();
  resolvePendingFetch("/api/update/status", { ok: false, json: async () => ({ error: "backend" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#updateStatus").textContent, translationFixtures.en["update.checkFailed"], "update errors use localized guidance");

  // Flood-fill responses are token-bound: a switch discards stale spans and
  // releases the busy state without touching history.
  state.images = [{ id: "fill", relativePath: "fill.png", width: 2, height: 2, assetVersion: "fill-v", candidateRevision: 0 }];
  state.currentId = "fill"; state.currentImage = { width: 2, height: 2 }; state.imageGeneration = 910; state.catalogEpoch = 910; state.history = []; state.historyIndex = 0;
  originalCanvas.width = 2; originalCanvas.height = 2;
  const fillPixels = new Uint8ClampedArray(16); originalCtx.getImageData = () => ({ data: fillPixels });
  fillAt({ x: 0, y: 0 });
  const staleFillWorker = workerInstances.at(-1);
  assert.equal(staleFillWorker.url, "/js/flood-fill-worker.js"); assert.equal(state.fillPending, true); assert.equal(isBusy(), true);
  assert.equal(staleFillWorker.message.pixels, fillPixels.buffer, "flood fill transfers the ImageData buffer directly");
  assert.equal(staleFillWorker.transfer[0], fillPixels.buffer, "the original pixel buffer is transferred to the worker");
  state.imageGeneration += 1;
  staleFillWorker.onmessage({ data: { spans: new Int32Array([0, 0, 2]) } });
  assert.equal(state.fillPending, false); assert.equal(state.history.length, 0, "stale worker result does not mutate history");
  fillAt({ x: 0, y: 0 }); const cancelledFillWorker = workerInstances.at(-1); cancelFillWork();
  assert.equal(cancelledFillWorker.terminated, true); assert.equal(state.fillPending, false);

  // A dense pointer stream preserves every point while composing and rendering
  // only once in the next animation frame.
  const queuedFrames = []; context.requestAnimationFrame = (callback) => { queuedFrames.push(callback); return queuedFrames.length; };
  state.images = [{ id: "raf", relativePath: "raf.png", width: 100, height: 80, assetVersion: "raf-v", candidateRevision: 0 }];
  state.currentId = "raf"; state.currentImage = { width: 100, height: 80 }; state.tool = "brush"; state.history = []; state.historyIndex = 0; state.maskDirty = false;
  combinedMask._context.clearRectCalls = 0;
  beginManualStroke({ x: 0, y: 0 });
  for (let index = 1; index <= 100; index += 1) { appendManualStrokePoint({ x: index, y: 0 }); render(); }
  assert.equal(state.activeStroke.points.length, 101, "all coalesced pointer samples are retained");
  assert.equal(queuedFrames.length, 1, "only one RAF render is queued");
  queuedFrames.shift()();
  assert.equal(combinedMask._context.clearRectCalls, 1, "dirty mask composition runs once per RAF");
  context.requestAnimationFrame = (callback) => { callback(); return 1; };

  for (const pending of [...pendingFetches]) if (pending.path.startsWith("/api/image/")) settlePendingFetch(pending, { ok: true, blob: async () => ({}) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingFetches.length, 0, `every mocked fetch must be resolved before this test completes: ${pendingFetches.map((item) => item.path).join(", ")}`);
  testReachedEnd = true;
  clearTimeout(completionWatchdog);
  console.log("test_app_js: passed (reached end with no pending fetches)");
})().catch((error) => { clearTimeout(completionWatchdog); console.error(error); process.exitCode = 1; });
