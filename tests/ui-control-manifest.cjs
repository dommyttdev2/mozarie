// Every id-addressable control in static/index.html has one contract here.
// Dynamic template controls deliberately use data-* selectors and are exercised
// by the candidate, gallery, overview, model, and context-menu E2E cases.
const ids = `
pickFolder detectAllButton saveAllButton folderPath loadFolderButton pickImages pickFolderFiles settingsButton updateToast batchMoreButton clearAllMasksButton clearCatalogButton galleryFilter overviewButton collapseGalleryButton
brushTool mosaicEraserTool eraserTool excludeEraserTool boundaryTool rectangleTool polygonTool boundaryBrushTool bucketTool excludeBucketTool fitButton undoButton redoButton mosaicPreviewButton brushSize mosaicHelpButton divisor bucketTolerance
previousImageButton nextImageButton removeAndNextButton hideAndNextButton reviewAndNextButton boundaryDetectButton boundaryCancelButton collapseInspectorButton detectCurrentButton saveButton clearCurrentMasksButton removeCurrentImageButton detectTargetPenis detectTargetPussy confidence
closeOverviewButton batchModeButton overviewQuery overviewFolder selectionActionsButton selectionClearButton toggleReviewMenuItem copyImagePathMenuItem removeImageMenuItem confirmNeverShow confirmAccept errorDialogClose
detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber detectCancelButton detectStartButton
settingsCloseButton settingsTabGeneral settingsTabModels settingsTabDisplay settingsTabShortcuts settingsTabConfirm settingsTabInfo settingsLanguage settingsPort settingsDefaultOutputDirectory settingsChooseOutputDirectory settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsTargetModel settingsNtd11Toggle settingsNtd11Model settingsSensitiveToggle settingsSensitiveModel settingsPrecisionToggle settingsSamType settingsSamModel settingsHandToggle settingsHandModel settingsHandSegmentationToggle settingsHandSegmentationModel settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy checkUpdateButton settingsResetButton settingsSaveButton
modelDownloadClose modelDownloadCopy modelDownloadStart modelDownloadCancel applyTargetMode applyCopyMode applyOverwriteMode applySuffix deleteOriginal applyOutputDirectoryStatus chooseOutputDirectoryButton removeAfterSave applyDivisor applyCloseButton applyPauseButton applyCancelButton applyStartButton mosaicHelpCloseButton processingPauseButton processingCancelButton modelHelpCloseButton modelHelpCopy
`.trim().split(/\s+/);

// Text-entry controls are exercised with a real keyboard event.  Selects,
// switches, ranges, and numeric inputs receive input/change.  Every remaining
// id is a button-style activation.  The separate list keeps a new control from
// silently bypassing the interaction sweep.
const keyboardIds = new Set(`
folderPath overviewQuery settingsDefaultOutputDirectory settingsTargetModel settingsNtd11Model settingsSensitiveModel settingsSamModel settingsHandModel settingsHandSegmentationModel applySuffix applyOutputDirectoryStatus
`.trim().split(/\s+/));
const changeIds = new Set(`
galleryFilter brushSize divisor bucketTolerance confidence detectParallelism dialogTargetPenis dialogTargetPussy detectConfidenceRange detectConfidenceNumber settingsLanguage settingsPort settingsImportParallelism settingsSaveParallelism settingsOpenBrowser settingsProvider settingsGpuDevice settingsNtd11Toggle settingsSensitiveToggle settingsPrecisionToggle settingsSamType settingsHandToggle settingsHandSegmentationToggle settingsFluidToggle settingsApplyColor settingsExcludeColor settingsOpacity settingsMosaicPreview settingsExcludeForcedDefault settingsShortcutsEnabled confirmClearMasks confirmClearCatalog confirmRemoveImage confirmCandidateDelete confirmCandidateRoleDelete confirmOverwriteSource confirmDeleteSourceAfterCopy applyTargetMode applyCopyMode applyOverwriteMode deleteOriginal removeAfterSave applyDivisor
`.trim().split(/\s+/));

const fixtureForScenario = {
  import: "import",
  detection: "detect",
  editor: "editor",
  overview: "overview",
  settings: "settings",
  save: "save",
  processing: "processing",
  confirmation: "confirmation",
  gallery: "workspace",
  candidate: "editor",
  workspace: "workspace",
};
const exemptReasons = {
  // A readonly status field has no product handler.  Its adjacent button is
  // the user operation that changes it and is covered by the save fixture.
  applyOutputDirectoryStatus: "readonly output-directory status; chooseOutputDirectoryButton is the operable control",
  settingsSamType: "hidden selected-SAM value; input[name=settingsSamVariant] is the operable control",
};

function interactionFor(id) {
  const action = keyboardIds.has(id) ? "keyboard" : changeIds.has(id) ? "change" : "click";
  let resultKind = "dom";
  let scenario = "workspace";
  if (/^(pickFolder|folderPath|loadFolderButton|pickImages|pickFolderFiles)/.test(id)) {
    resultKind = "dialog"; scenario = "import";
  } else if (/^(detect|confidence|boundaryDetectButton|boundaryCancelButton)/.test(id)) {
    resultKind = "api"; scenario = "detection";
  } else if (/^(save|apply|deleteOriginal|removeAfterSave|chooseOutputDirectoryButton)/.test(id)) {
    resultKind = "api"; scenario = "save";
  } else if (/^(settings|modelDownload|modelHelp)/.test(id)) {
    resultKind = /^settings(?:Language|Port|DefaultOutputDirectory|ImportParallelism|SaveParallelism|OpenBrowser|Provider|GpuDevice|TargetModel|Ntd11|Sensitive|Precision|Sam|Hand|Fluid|ApplyColor|ExcludeColor|Opacity|MosaicPreview|ExcludeForcedDefault|ShortcutsEnabled)/.test(id) ? "value" : "dialog";
    scenario = "settings";
  } else if (/^(brush|mosaicEraser|eraser|excludeEraser|boundaryTool|rectangleTool|polygonTool|boundaryBrushTool|bucketTool|excludeBucketTool|fitButton|undoButton|redoButton|mosaicPreviewButton|brushSize|divisor|bucketTolerance)/.test(id)) {
    resultKind = "canvas"; scenario = "editor";
  } else if (/^(overview|closeOverview|batchMode|overviewQuery|overviewFolder|selection)/.test(id)) {
    resultKind = "navigation"; scenario = "overview";
  } else if (/^(confirm|errorDialog)/.test(id)) {
    resultKind = "dialog"; scenario = "confirmation";
  } else if (/^(processing)/.test(id)) {
    resultKind = "api"; scenario = "processing";
  } else if (/^(previousImage|nextImage|removeAndNext|hideAndNext|reviewAndNext|clearAllMasks|clearCatalog|galleryFilter|batchMore|collapseGallery)/.test(id)) {
    resultKind = "dom"; scenario = "gallery";
  }
  const expected = `${resultKind} result is asserted by the ${scenario} fixture scenario`;
  // `assertionId` is deliberately a stable, inspectable link to the browser
  // ledger.  The ledger is allowed to use a fresh page for the same fixture,
  // but it may not silently treat a merely-present control as covered.
  return { action, resultKind, scenario, fixture: fixtureForScenario[scenario], assertionId: `${scenario}:${id}`, exemptReason: exemptReasons[id], expected };
}

const controls = ids.map((id) => ({ id, ...interactionFor(id) }));
const dynamicControls = [
  { selector: "[data-candidate-batch]", action: "click", resultKind: "dom", scenario: "candidate", fixture: "editor", assertionId: "candidate:data-candidate-batch", expected: "selects the candidate batch" },
  { selector: "[data-candidate-display-toggle]", action: "click", resultKind: "canvas", scenario: "candidate", fixture: "editor", assertionId: "candidate:data-candidate-display-toggle", expected: "changes candidate display visibility" },
  { selector: "[data-candidate-effective-toggle]", action: "click", resultKind: "canvas", scenario: "candidate", fixture: "editor", assertionId: "candidate:data-candidate-effective-toggle", expected: "changes effective candidate visibility" },
  { selector: "[data-overview-filter]", action: "change", resultKind: "navigation", scenario: "overview", fixture: "overview", assertionId: "overview:data-overview-filter", expected: "filters the overview fixture" },
  { selector: "[data-selection-action]", action: "click", resultKind: "api", scenario: "overview", fixture: "overview", assertionId: "overview:data-selection-action", expected: "applies an isolated selection action" },
  { selector: ".gallery-item", action: "click", resultKind: "navigation", scenario: "gallery", fixture: "workspace", assertionId: "gallery:gallery-item", expected: "selects the isolated gallery image" },
  { selector: ".overview-item", action: "click", resultKind: "navigation", scenario: "overview", fixture: "overview", assertionId: "overview:overview-item", expected: "selects the isolated overview image" },
  { selector: "[data-model-download]", action: "click", resultKind: "dialog", scenario: "settings", fixture: "settings", assertionId: "settings:data-model-download", expected: "opens the model download dialog" },
  { selector: "[data-model-help]", action: "click", resultKind: "dialog", scenario: "settings", fixture: "settings", assertionId: "settings:data-model-help", expected: "opens model help" },
  { selector: "[data-model-picker]", action: "click", resultKind: "dialog", scenario: "settings", fixture: "settings", assertionId: "settings:data-model-picker", expected: "uses the picker fixture" },
  { selector: "input[name=settingsSamVariant]", action: "change", resultKind: "value", scenario: "settings", fixture: "settings", assertionId: "settings:settingsSamVariant", expected: "selects the SAM variant" },
];

const scenarioContracts = Object.fromEntries([...new Set([...controls, ...dynamicControls].map((control) => control.scenario))].map((scenario) => {
  const scenarioControls = [...controls, ...dynamicControls].filter((control) => control.scenario === scenario);
  return [scenario, {
    controls: scenarioControls.map((control) => control.id || control.selector),
    assertions: [...new Set(scenarioControls.map((control) => `${control.resultKind}:${control.expected}`))],
  }];
}));

module.exports = {
  controls,
  dynamicControls,
  scenarioContracts,
};
