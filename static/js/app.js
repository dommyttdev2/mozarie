function modelHelpInfo(key) {
  const samType = $("#settingsSamType")?.value || "vit_b";
  const samFiles = { vit_b: "sam_vit_b_01ec64.pth", vit_l: "sam_vit_l_0b3195.pth", vit_h: "sam_vit_h_4b8939.pth" };
  const source = (label, url) => ({ source: label, url });
  const english = $("#settingsLanguage")?.value === "en";
  const conversionCommand = (model) => {
    const path = model === "ntd11"
      ? (english ? "path\\to\\downloaded\\ntd11_anime_nsfw_segm_v5-variant1.pt" : "ダウンロードしたntd11_anime_nsfw_segm_v5-variant1.ptのパス")
      : (english ? "path\\to\\downloaded\\sensitive_detect_v07.pt" : "ダウンロードしたsensitive_detect_v07.ptのパス");
    return `python -m pip install "ultralytics==8.4.75"\nyolo export model="${path}" format=onnx imgsz=1024 batch=1 dynamic=False simplify=False opset=17 nms=False end2end=False device=cpu`;
  };
  const models = {
    target: { model: "01miku/anime-nsfw-segm-yolo26 / nsfw-anime-xl-x1280", file: "nsfw-anime-xl-x1280.onnx", ...source("Hugging Face", "https://huggingface.co/01miku/anime-nsfw-segm-yolo26/blob/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx") },
    ntd11: { model: "Anime NSFW Detection / ADetailer All-in-One v5.0-variant1", file: "animeNSFWDetection_v50Variant1.zip → ntd11_anime_nsfw_segm_v5-variant1.pt → ntd11_anime_nsfw_segm_v5-variant1.onnx", ...source("Civitai.red", "https://civitai.red/models/1313556?modelVersionId=2350456"), command: conversionCommand("ntd11") },
    sensitive: { model: "sugarknight/sensitive-detect / sensitive_detect_v07", file: "sensitive_detect_v07.pt → sensitive_detect_v07.onnx", ...source("Hugging Face", "https://huggingface.co/sugarknight/sensitive-detect/tree/b7ec7a528841aac3d52411fb4d031d51a8225e40"), command: conversionCommand("sensitive") },
    precision: { model: "Meta Segment Anything (SAM)", file: "sam_vit_b_01ec64.pth / sam_vit_l_0b3195.pth / sam_vit_h_4b8939.pth", ...source("Meta", "https://github.com/facebookresearch/segment-anything#model-checkpoints") },
    samType: { model: `Meta Segment Anything (SAM) ${samType}`, file: samFiles[samType], ...source("Meta", "https://github.com/facebookresearch/segment-anything#model-checkpoints") },
    hand: { model: "deepghs/anime_hand_detection / hand_detect_v1.0_s", file: "hand_detect_v1.0_s/model.onnx（保存名 anime-hand-v1.0-s.onnx）", ...source("Hugging Face", "https://huggingface.co/deepghs/anime_hand_detection/tree/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s") },
    handSegmentation: { model: "HandSegNet anime SDXL", file: "handsegnet_vit_b_best.safetensors", ...source("Hugging Face", "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/tree/77ff734683306141e56aef9d491958a82508b41a") },
    fluid: { model: t("modelHelp.noAdditionalModel"), file: t("modelHelp.notRequired"), source: "", url: "" },
  };
  return models[key];
}

function openModelHelp(key) {
  const info = modelHelpInfo(key);
  $("#modelHelpTitle").textContent = t(`modelHelp.${key}.title`);
  $("#modelHelpText").hidden = false;
  $("#modelHelpText").textContent = t(`modelHelp.${key}.text`);
  $("#modelHelpModel").textContent = info.model;
  $("#modelHelpFile").textContent = info.file;
  const source = $("#modelHelpSource"); source.textContent = info.source; source.href = info.url || "#";
  $("#modelHelpDetails").hidden = !info;
  source.closest("dd").hidden = !info.url; $("#modelHelpSourceLabel").hidden = !info.url;
  $("#modelHelpCommandWrap").hidden = !info.command;
  $("#modelHelpCommand").textContent = info.command || "";
  $("#modelHelpCopyResult").textContent = "";
  $("#modelHelpSamTable").hidden = key !== "samType";
  $("#modelHelpDialog").showModal();
}

async function copyCommand(commandId, resultId) {
  const result = $(resultId); result.textContent = "";
  try {
    await navigator.clipboard.writeText($(commandId).textContent);
    result.textContent = t("command.copied");
  } catch (error) { setStatus(error.message, "error"); }
}

function bindEvents() {
  const lightDismiss = (dialog, close) => {
    let backdropPointerId = null;
    const isBackdrop = (event) => {
      if (event.target !== dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    dialog.addEventListener("pointerdown", (event) => { backdropPointerId = event.isPrimary && event.button === 0 && isBackdrop(event) ? event.pointerId : null; });
    dialog.addEventListener("pointerup", (event) => {
      const shouldClose = backdropPointerId === event.pointerId && isBackdrop(event);
      backdropPointerId = null;
      if (shouldClose) close();
    });
    dialog.addEventListener("pointercancel", () => { backdropPointerId = null; });
  };
  $("#settingsButton").addEventListener("click", () => { void openSettings(); });
  $("#updateToast").addEventListener("click", () => { void openSettings().then(() => selectSettingsTab("info")); });
  $("#settingsCloseButton").addEventListener("click", () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#settingsDialog").close(); });
  lightDismiss($("#settingsDialog"), () => $("#settingsDialog").close());
  $("#settingsDialog").addEventListener("close", () => {
    const language = state.settings?.general?.language || "ja";
    if (state.settings?.models && state.settings?.display && state.settings?.detection) {
      setSettingsForm(state.settings, state.settingsStatus);
    } else {
      $("#settingsLanguage").value = language;
    }
    void loadTranslations(language);
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#settingsResetButton").addEventListener("click", () => { void resetSettings(); });
  $("#settingsChooseOutputDirectory").addEventListener("click", () => { void chooseSettingsOutputDirectory(); });
  document.querySelectorAll("[data-model-picker]").forEach((button) => button.addEventListener("click", () => { void chooseSettingsModelFile(button); }));
  document.querySelectorAll("[data-model-download]").forEach((button) => button.addEventListener("click", () => { void startModelDownload(button.dataset.modelDownload); }));
  $("#modelDownloadCancel").addEventListener("click", () => { void cancelModelDownload(); });
  $("#modelDownloadStart").addEventListener("click", () => { void beginModelDownload(); });
  $("#modelDownloadCopy").addEventListener("click", () => { void copyCommand("#modelDownloadCommand", "#modelDownloadCopyResult"); });
  $("#modelDownloadClose").addEventListener("click", () => $("#modelDownloadDialog").close());
  $("#modelDownloadDialog").addEventListener("cancel", (event) => { if (modelDownloadPoll) event.preventDefault(); else $("#modelDownloadDialog").close(); });
  $("#settingsProvider").addEventListener("change", syncProviderSelection);
  document.querySelectorAll('input[name="settingsSamVariant"]').forEach((radio) => radio.addEventListener("change", () => {
    if (radio.checked) selectSamVariant(radio.value, true);
  }));
  $("#checkUpdateButton").addEventListener("click", () => { void startUpdate(); });
  document.querySelectorAll("[data-model-help]").forEach((button) => button.addEventListener("click", () => openModelHelp(button.dataset.modelHelp)));
  $("#modelHelpCopy").addEventListener("click", () => { void copyCommand("#modelHelpCommand", "#modelHelpCopyResult"); });
  $("#modelHelpCloseButton").addEventListener("click", () => $("#modelHelpDialog").close());
  $("#modelHelpDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#modelHelpDialog").close(); });
  lightDismiss($("#modelHelpDialog"), () => $("#modelHelpDialog").close());
  toolRail.addEventListener("keydown", handleToolRailKeydown);
  toolRailItems().forEach((item) => item.addEventListener("focus", () => setToolRailTabStop(item)));
  setToolRailTabStop();
  document.querySelectorAll(".settings-tab").forEach((button) => {
    button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
    button.addEventListener("keydown", moveSettingsTab);
  });
  document.querySelectorAll("[data-model-toggle]").forEach((toggle) => {
    toggle.addEventListener("change", () => {
      setModelCardEnabled(toggle.dataset.modelToggle, toggle.checked);
      if (toggle.dataset.modelToggle === "hand_detection") setHandSegmentationAvailable(toggle.checked);
    });
  });
  $("#settingsPrecisionToggle").addEventListener("change", () => setPrecisionDetectionEnabled($("#settingsPrecisionToggle").checked));
  $("#settingsFluidToggle").addEventListener("change", () => setFluidExclusionEnabled($("#settingsFluidToggle").checked));
  $("#pickImages").addEventListener("click", () => { void pickImageFiles(); });
  $("#pickFolderFiles").addEventListener("click", () => { void pickImageDirectory(); });
  for (const inputId of ["#importImagesInput", "#importFolderInput"]) $(inputId).addEventListener("change", (event) => {
    const input = event.currentTarget;
    const files = [...input.files];
    input.value = "";
    if (files.length) void importFiles(files);
  });
  document.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) void importDroppedFiles(event);
  });
  $("#folderPath").addEventListener("keydown", (event) => { if (event.key === "Enter") loadFolder(); });
  $("#loadFolderButton").addEventListener("click", loadFolder);
  const detectAll = () => {
    if (!activeDetection()) openDetectionDialog(state.images.filter((image) => !isHidden(image)).map((image) => image.id));
  };
  $("#detectAllButton").addEventListener("click", detectAll);
  $("#detectCurrentButton").addEventListener("click", () => state.currentId && runDetection([state.currentId], detectionConfidence(), 1));
  $("#saveAllButton").addEventListener("click", saveAll); $("#saveButton").addEventListener("click", saveCurrent); $("#fitButton").addEventListener("click", () => { if (!isBusy() && !state.importing) fitImage(); });
  $("#removeCurrentImageButton").addEventListener("click", () => { const image = currentRecord(); if (image) setHidden(image, !isHidden(image)); });
  $("#clearCurrentMasksButton").addEventListener("click", () => state.currentId && clearMasks([state.currentId], "confirm.clearCurrent.title", "confirm.clearCurrent.message"));
  $("#clearAllMasksButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearMasks(state.images.map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message"); });
  $("#clearCatalogButton").addEventListener("click", () => { closeBatchMoreMenus(); void clearCatalog(); });
  for (const [menuId, buttonId] of [["#batchMoreMenu", "#batchMoreButton"], ["#selectionActionsMenu", "#selectionActionsButton"]]) {
    $(menuId).addEventListener("toggle", () => $(buttonId).setAttribute("aria-expanded", String($(menuId).matches(":popover-open"))));
  }
  $("#galleryFilter").addEventListener("change", (event) => { if (isBusy() || state.importing) return; state.galleryFilter = event.currentTarget.value; renderGallery(); });
  $("#overviewButton").addEventListener("click", () => { if (!isBusy() && !state.importing) setViewMode("overview"); });
  $("#closeOverviewButton").addEventListener("click", () => setViewMode("edit"));
  $("#previousImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(-1)));
  $("#nextImageButton").addEventListener("click", () => runNavigationAction(() => moveCurrentBy(1)));
  $("#reviewAndNextButton").addEventListener("click", () => runNavigationAction(reviewAndMoveNext));
  $("#removeAndNextButton").addEventListener("click", () => { void removeImageFromCatalog(state.currentId); });
  $("#hideAndNextButton").addEventListener("click", () => { void hideAndMoveNext(); });
  document.querySelectorAll("[data-selection-action]").forEach((button) => button.addEventListener("click", () => { void runSelectionAction(button.dataset.selectionAction); }));
  $("#selectionClearButton").addEventListener("click", () => { state.batchMode = false; clearBatchSelection(); renderOverview(); updateSelectionActionBar(); });
  $("#batchModeButton").addEventListener("click", () => { state.batchMode = true; clearBatchSelection(); renderOverview(); updateSelectionActionBar(); });
  document.querySelectorAll("[data-candidate-batch]").forEach((button) => button.addEventListener("click", () => { void batchCandidateOperation(button.dataset.candidateBatch); }));
  document.querySelectorAll("[data-candidate-display-toggle]").forEach((button) => button.addEventListener("click", () => toggleCandidateDisplay(button.dataset.candidateDisplayToggle)));
  document.querySelectorAll("[data-candidate-effective-toggle]").forEach((button) => button.addEventListener("click", () => toggleCandidateEffective(button.dataset.candidateEffectiveToggle)));
  $("#settingsLanguage").addEventListener("change", async (event) => {
    const bindings = Object.fromEntries([...document.querySelectorAll("[data-shortcut-action]")].map((input) => [input.dataset.shortcutAction, input.value]));
    const actions = Object.fromEntries([...document.querySelectorAll("[data-shortcut-enabled]")].map((input) => [input.dataset.shortcutEnabled, input.checked]));
    await loadTranslations(event.target.value);
    renderShortcutBindings(bindings, actions);
  });
  document.querySelectorAll(".overview-filter").forEach((button) => button.addEventListener("click", () => {
    if (isBusy() || state.importing) return;
    state.overviewFilter = button.dataset.overviewFilter; renderOverview();
  }));
  let overviewQueryTimer = null;
  $("#overviewQuery").addEventListener("input", (event) => {
    state.overviewQuery = event.target.value;
    clearTimeout(overviewQueryTimer);
    overviewQueryTimer = setTimeout(() => renderOverview(), 120);
  });
  $("#overviewFolder").addEventListener("change", (event) => { state.overviewFolder = event.target.value; renderOverview(); });
  $("#brushTool").addEventListener("click", () => setTool("brush")); $("#mosaicEraserTool").addEventListener("click", () => setTool("mosaic_eraser")); $("#eraserTool").addEventListener("click", () => setTool("eraser"));
  $("#excludeEraserTool").addEventListener("click", () => setTool("exclude_eraser"));
  $("#boundaryTool").addEventListener("click", () => {
    setBoundaryModeMenuOpen($("#boundaryModeMenu").hidden);
  });
  $("#bucketTool").addEventListener("click", () => setTool("bucket"));
  $("#excludeBucketTool").addEventListener("click", () => setTool("exclude_bucket"));
  $("#rectangleTool").addEventListener("click", () => setTool("boundary"));
  $("#polygonTool").addEventListener("click", () => setTool("polygon"));
  $("#boundaryBrushTool").addEventListener("click", () => setTool("boundary_brush"));
  $("#boundaryDetectButton").addEventListener("click", () => {
    if (!canDetectBoundary()) return;
    void addBoundaryCandidate();
  });
  $("#boundaryCancelButton").addEventListener("click", cancelBoundary);
  $("#mosaicPreviewButton").addEventListener("click", () => setMosaicPreviewEnabled(!state.mosaicPreviewEnabled));
  $("#brushSize").addEventListener("input", () => updateBrushSize($("#brushSize").value));
  $("#divisor").addEventListener("input", () => {
    if (isBusy() || state.importing) return;
    const divisor = normaliseDivisor($("#divisor").value);
    $("#divisor").value = divisor;
    rebuildMosaicPreview(); updateBlockSizeDisplay(); render();
  });
  $("#applyDivisor").addEventListener("input", () => { if (!isBusy() && !state.importing) updateBlockSizeDisplay(); });
  $("#confidence").addEventListener("input", () => { if (!isBusy() && !state.importing) setDetectionConfidence($("#confidence").value); });
  $("#detectConfidenceRange").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceRange").value));
  $("#detectConfidenceNumber").addEventListener("input", () => setDetectionConfidence($("#detectConfidenceNumber").value));
  document.querySelectorAll(".target-chip input").forEach((input) => input.addEventListener("change", () => {
    syncDetectionTargetSwitch(input);
    if (input.id.startsWith("dialog")) validateDetectionTargets(detectionTargets("dialogTarget"), $("#detectTargetValidation"));
    else validateDetectionTargets(detectionTargets(), $("#detectionTargetValidation"));
  }));
  $("#detectForm").addEventListener("submit", startDetectionFromDialog);
  $("#detectCancelButton").addEventListener("click", () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; $("#detectTargetValidation").hidden = true; });
  $("#detectDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#detectDialog").close(); state.pendingDetectionTargetIds = []; $("#detectTargetValidation").hidden = true; });
  lightDismiss($("#detectDialog"), () => { $("#detectDialog").close(); state.pendingDetectionTargetIds = []; });
  $("#undoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex - 1)); $("#redoButton").addEventListener("click", () => restoreSnapshot(state.historyIndex + 1));
  const grid = $(".studio-grid");
  const setPaneCollapsed = (side, collapsed) => {
    const isGallery = side === "gallery";
    const content = $(isGallery ? "#galleryPaneContent" : "#candidatePaneContent");
    const button = $(isGallery ? "#collapseGalleryButton" : "#collapseInspectorButton");
    const className = isGallery ? "gallery-collapsed" : "inspector-collapsed";
    state[isGallery ? "galleryCollapsed" : "inspectorCollapsed"] = collapsed;
    grid.classList.toggle(className, collapsed);
    content.inert = collapsed;
    content.setAttribute("aria-hidden", String(collapsed));
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = isGallery ? (collapsed ? "›" : "‹") : (collapsed ? "‹" : "›");
    const labelKey = isGallery
      ? (collapsed ? "workspace.expandGallery" : "workspace.collapseGallery")
      : (collapsed ? "workspace.expandInspector" : "workspace.collapseInspector");
    button.setAttribute("aria-label", t(labelKey));
    button.title = t(labelKey);
    requestAnimationFrame(() => { resizeRenderCanvas(); fitImage(); });
  };
  $("#collapseGalleryButton").addEventListener("click", () => setPaneCollapsed("gallery", !state.galleryCollapsed));
  $("#collapseInspectorButton").addEventListener("click", () => setPaneCollapsed("inspector", !state.inspectorCollapsed));
  setPaneCollapsed("gallery", false);
  setPaneCollapsed("inspector", false);
  $("#applyForm").addEventListener("submit", startApplyFromDialog);
  $("#chooseOutputDirectoryButton").addEventListener("click", chooseOutputDirectory);
  document.querySelectorAll('input[name="saveMode"]').forEach((input) => input.addEventListener("change", syncApplyMode));
  $("#applyTargetMode").addEventListener("change", refreshApplyTargets);
  $("#mosaicHelpButton").addEventListener("click", () => {
    $("#mosaicHelpDialog").showModal();
  });
  $("#mosaicHelpCloseButton").addEventListener("click", () => $("#mosaicHelpDialog").close());
  lightDismiss($("#mosaicHelpDialog"), () => $("#mosaicHelpDialog").close());
  $("#removeAfterSave").addEventListener("change", syncApplyMode);
  $("#applyCloseButton").addEventListener("click", () => $("#applyDialog").close());
  $("#applyPauseButton").addEventListener("click", () => {
    const paused = state.browserSave ? state.browserSave.paused : state.job?.state === "paused";
    controlApply(paused ? "resume" : "pause");
  });
  $("#applyCancelButton").addEventListener("click", () => controlApply("cancel"));
  $("#applyDialog").addEventListener("cancel", (event) => { event.preventDefault(); if (!state.applyRunning) $("#applyDialog").close(); });
  lightDismiss($("#applyDialog"), () => { if (!state.applyRunning) $("#applyDialog").close(); });
  $("#confirmDialog").addEventListener("cancel", (event) => { event.preventDefault(); $("#confirmDialog").close("cancel"); });
  lightDismiss($("#confirmDialog"), () => $("#confirmDialog").close("cancel"));
  $("#processingDialog").addEventListener("cancel", (event) => event.preventDefault());
  $("#processingPauseButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing) return;
    if (processing.kind === "import") {
      const session = state.importSession; if (!session) return;
      session.paused = !session.paused;
      showProcessing({ ...processing, state: session.paused ? "paused" : "running" });
      return;
    }
    try {
      const job = await api(`/api/job/${processing.state === "paused" ? "resume" : "pause"}`, { method: "POST", body: JSON.stringify({}) });
      state.job = job; updateProgress(job); scheduleJobPoll(true);
    }
    catch (error) { setStatus(error.message, "error"); }
  });
  $("#processingCancelButton").addEventListener("click", async () => {
    const processing = state.processing;
    if (!processing || $("#processingCancelButton").disabled) return;
    $("#processingCancelButton").disabled = true;
    if (processing.kind === "import") { if (state.importSession) state.importSession.cancelled = true; return; }
    await cancelDetection();
  });
  $("#toggleReviewMenuItem").addEventListener("click", () => {
    const image = state.images.find((item) => item.id === state.contextMenuImageId);
    if (image) setReviewed(image, !isReviewed(image));
    closeCatalogContextMenu();
  });
  $("#removeImageMenuItem").addEventListener("click", () => { const image = state.images.find((item) => item.id === state.contextMenuImageId); if (image) setHidden(image, !isHidden(image)); closeCatalogContextMenu(); });
  $("#gallery").addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault(); setGalleryDropOverlay(true);
  });
  $("#gallery").addEventListener("dragleave", (event) => {
    if (!$("#gallery").contains(event.relatedTarget)) setGalleryDropOverlay(false);
  });
  $("#gallery").addEventListener("drop", importDroppedFiles);

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    if (event.button === 1) {
      canvas.setPointerCapture(event.pointerId); state.panning = true; state.pointer = { x: event.clientX, y: event.clientY }; canvas.style.cursor = "grabbing"; return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const rawPoint = pointFromEvent(event); const point = clampPoint(rawPoint);
    state.drawing = true; state.pointer = point; state.hover = rawPoint;
    if (state.tool === "boundary") { state.boundaryStart = point; state.boundaryStartClient = { x: event.clientX, y: event.clientY }; state.boundaryPoint = point; state.boundaryDragging = false; render(); return; }
    if (state.tool === "polygon") {
      const vertex = polygonVertexAt(point);
      if (vertex >= 0) {
        state.polygonDragIndex = vertex;
        state.drawing = true;
      } else {
        const completedVertex = completedPolygonVertexAt(point);
        if (completedVertex) {
          state.polygonDraftDrag = { id: completedVertex.draft.id, index: completedVertex.index };
        } else if (state.polygonPoints.length < 4) {
          state.polygonPoints.push(point);
          if (state.polygonPoints.length === 4 && polygonIsValid()) {
            addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
            state.polygonPoints = [];
          }
        }
        state.drawing = false;
      }
      updateBoundaryActions(); render(); return;
    }
    if (state.tool === "boundary_brush") { beginBoundaryBrushStroke(point); render(); return; }
    if (["bucket", "exclude_bucket"].includes(state.tool)) { state.drawing = false; fillAt(point); return; }
    beginManualStroke(rawPoint); render();
  });
  const processPointerMove = (event) => {
    if (isBusy() || state.importing) return;
    if (state.panning) {
      state.view.x += event.clientX - state.pointer.x; state.view.y += event.clientY - state.pointer.y; state.pointer = { x: event.clientX, y: event.clientY }; render(); return;
    }
    state.hover = pointFromEvent(event);
    if (state.drawing && (event.buttons & 1)) {
      const point = clampPoint(state.hover);
      if (state.tool === "boundary") {
        state.boundaryPoint = point;
        state.boundaryDragging ||= boundaryDragStarted(event);
      } else if (state.tool === "polygon" && state.polygonDragIndex >= 0) {
        state.polygonPoints[state.polygonDragIndex] = point;
      } else if (state.tool === "polygon" && state.polygonDraftDrag) {
        const draft = state.boundaryDrafts.find((item) => item.id === state.polygonDraftDrag.id);
        if (draft) {
          draft.points[state.polygonDraftDrag.index] = point;
          draft.roi = polygonRoi(draft.points);
          state.boundaryActiveId = draft.id;
        }
      } else if (state.tool === "boundary_brush") {
        appendBoundaryBrushPoint(point);
      } else { appendManualStrokePoint(state.hover); state.pointer = state.hover; }
    }
    render();
  };
  canvas.addEventListener("pointermove", (event) => {
    const events = event.getCoalescedEvents?.() || [event];
    for (const pointEvent of events) processPointerMove(pointEvent);
  });
  function finishCanvasGesture(event, cancelled = false) {
    const wasDrawing = state.drawing;
    const manualStrokeStarted = Boolean(state.activeStroke);
    const boundaryStarted = Boolean(state.boundaryStart);
    try { if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    state.drawing = false; state.panning = false;
    if (state.tool === "polygon") {
      if (state.polygonPoints.length === 4 && polygonIsValid()) {
        addBoundaryDraft({ type: "polygon", points: state.polygonPoints.map((item) => ({ ...item })), roi: polygonRoi(state.polygonPoints) });
        state.polygonPoints = [];
      }
      state.polygonDragIndex = -1; state.polygonDraftDrag = null; updateBoundaryActions(); flushRender(); return;
    }
    const boundaryStart = state.boundaryStart;
    const boundaryDragging = state.boundaryDragging;
    state.boundaryStart = null; state.boundaryStartClient = null; state.boundaryPoint = null; state.boundaryDragging = false;
    canvas.style.cursor = ["mosaic_eraser", "eraser", "exclude_eraser"].includes(state.tool) ? "cell" : "crosshair";
    if (wasDrawing && manualStrokeStarted) completeManualStroke();
    if (!cancelled && wasDrawing && state.tool === "boundary_brush") completeBoundaryBrushStroke();
    if (cancelled && state.tool === "boundary_brush") state.boundaryBrushStroke = null;
    if (!cancelled && wasDrawing && boundaryStarted && !isBusy() && !state.importing && event?.button === 0) {
      const point = clampPoint(pointFromEvent(event));
      const roi = roiFromPoints(boundaryStart, point);
      if (boundaryDragging && roi) {
        addBoundaryDraft({ type: "rectangle", roi, point: pointForRoi(roi) });
        state.boundaryRoi = null;
      } else {
        const draft = rectangleDraftAt(point);
        if (draft) {
          draft.point = point;
          state.boundaryActiveId = draft.id;
        }
      }
    }
    flushRender();
  }
  canvas.addEventListener("pointerup", (event) => finishCanvasGesture(event));
  canvas.addEventListener("pointercancel", (event) => finishCanvasGesture(event, true));
  canvas.addEventListener("pointerleave", () => { if (!state.drawing) state.hover = null; render(); });
  canvas.addEventListener("wheel", (event) => {
    if (!state.currentImage || isBusy() || state.importing) return;
    event.preventDefault();
    if (event.shiftKey) {
      const current = Number($("#brushSize").value); const direction = event.deltaY < 0 ? 1 : -1;
      return updateBrushSize(Math.max(1, current + direction * Math.max(1, Math.round(current * 0.1))));
    }
    const rect = canvas.getBoundingClientRect(); const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
    const sourceX = (mouseX - state.view.x) / state.view.scale; const sourceY = (mouseY - state.view.y) / state.view.scale;
    state.view.scale = Math.min(12, Math.max(0.03, state.view.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    state.view.x = mouseX - sourceX * state.view.scale; state.view.y = mouseY - sourceY * state.view.scale; render();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.fillWorker) { event.preventDefault(); cancelFillWork(); return; }
    if (event.key === "Escape" && !$("#boundaryModeMenu").hidden) {
      event.preventDefault(); closeBoundaryModeMenu(); focusElement($("#boundaryTool")); return;
    }
    if (hasBoundaryDraft()) {
      if (event.key === "Escape") { event.preventDefault(); cancelBoundary(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        if (canDetectBoundary()) void addBoundaryCandidate();
        return;
      }
    }
    const menu = $("#catalogContextMenu");
    if (menu.matches?.(":popover-open")) {
      const items = [...menu.querySelectorAll("button:not([disabled])")];
      const currentIndex = items.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeCatalogContextMenu(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        focusElement(items[nextIndex]); return;
      }
    }
    handleWindowKeydown(event);
  });
  window.addEventListener("dragend", () => setGalleryDropOverlay(false));
  document.addEventListener("pointerdown", (event) => {
    const boundaryMenu = $("#boundaryModeMenu");
    if (!boundaryMenu.hidden && event.target !== $("#boundaryTool") && !boundaryMenu.contains?.(event.target)) closeBoundaryModeMenu();
    const menu = $("#catalogContextMenu");
    if (!menu.matches?.(":popover-open") || menu.contains(event.target)) return;
    closeCatalogContextMenu();
  });
  window.addEventListener("storage", handleReviewStorageEvent);
}

async function initialise() {
  try {
    const settings = await api("/api/settings?status=0");
    setSettingsForm(settings.settings, settings.status);
    $("#settingsVersion").textContent = settings.version;
  } catch { /* The defaults below keep the editor usable when settings are unavailable. */ }
  await loadTranslations(); bindEvents();
  setNavigationShortcutsEnabled(state.settings?.general?.shortcuts_enabled ?? true);
  new ResizeObserver(resizeRenderCanvas).observe(stage); scheduleJobPoll(true);
  document.addEventListener("visibilitychange", () => scheduleJobPoll(document.visibilityState === "visible"));
  updateBrushSize($("#brushSize").value); resizeRenderCanvas(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons();
  try {
    const data = await api("/api/images");
    if (data.images.length) {
      $("#folderPath").value = data.root || "";
      resetCatalog(data.images, data.root);
      setStatusKey("status.imagesLoaded", { count: state.images.length });
    }
  } catch (error) { setStatus(error.message, "error"); }
  if (document.visibilityState === "visible") setTimeout(() => { void checkForUpdate({ silent: true }); }, 1000);
}

initialise();
