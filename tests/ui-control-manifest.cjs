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

function interactionFor(id) {
  if (keyboardIds.has(id)) return { action: "keyboard", expected: "accepts a keyboard interaction when its fixture state makes it available" };
  if (changeIds.has(id)) return { action: "change", expected: "accepts input/change when its fixture state makes it available" };
  return { action: "click", expected: "accepts activation when its fixture state makes it available" };
}

module.exports = {
  controls: ids.map((id) => ({ id, ...interactionFor(id) })),
  dynamicControls: [
    { selector: "[data-candidate-batch]", action: "click", expected: "selects the candidate batch" },
    { selector: "[data-candidate-display-toggle]", action: "click", expected: "changes candidate display visibility" },
    { selector: "[data-candidate-effective-toggle]", action: "click", expected: "changes effective candidate visibility" },
    { selector: "[data-overview-filter]", action: "change", expected: "filters the overview fixture" },
    { selector: "[data-selection-action]", action: "click", expected: "applies an isolated selection action" },
    { selector: ".gallery-item", action: "click", expected: "selects the isolated gallery image" },
    { selector: ".overview-item", action: "click", expected: "selects the isolated overview image" },
    { selector: "[data-model-download]", action: "click", expected: "opens the model download dialog" },
    { selector: "[data-model-help]", action: "click", expected: "opens model help" },
    { selector: "[data-model-picker]", action: "click", expected: "uses the picker fixture" },
    { selector: "input[name=settingsSamVariant]", action: "change", expected: "selects the SAM variant" },
  ],
};
