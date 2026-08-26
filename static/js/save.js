function setApplyResult(message, error = false) {
  const result = $("#applyResult"); result.textContent = message; result.classList.toggle("error", error);
}

function isTerminalApply(job) {
  if (job.kind !== "apply" || !["complete", "cancelled", "error"].includes(job.state)) return false;
  return state.applyRunning || (job.startedAt != null && state.handledApplyStartedAt !== job.startedAt);
}

function selectedSaveMode() { return document.querySelector('input[name="saveMode"]:checked').value; }
function sourceAccessFor(imageId) { return state.sourceAccess.get(imageId) || null; }
function sourceCanOverwrite(image) { return image?.sourceKind === "filesystem" || Boolean(sourceAccessFor(image?.id)?.fileHandle); }
function sourceCanDelete(image) {
  if (image?.sourceKind === "filesystem") return true;
  const access = sourceAccessFor(image?.id);
  return Boolean(access?.fileHandle && (typeof access.fileHandle.remove === "function" || access.parentHandle));
}
function applyTargetsSupport(capability) {
  return state.applyTargetIds.every((imageId) => {
    const image = state.images.find((entry) => entry.id === imageId);
    return capability === "overwrite" ? sourceCanOverwrite(image) : sourceCanDelete(image);
  });
}
function applyRestrictionMessage() {
  const noOverwrite = state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId)));
  const noDelete = state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId)));
  if (selectedSaveMode() === "overwrite" && noOverwrite.length) return t("apply.overwriteUnavailable", { count: noOverwrite.length });
  if (selectedSaveMode() === "copy" && $("#deleteOriginal").checked && noDelete.length) return t("apply.deleteUnavailable", { count: noDelete.length });
  return "";
}

function syncApplyMode() {
  const canOverwrite = applyTargetsSupport("overwrite");
  const canDelete = applyTargetsSupport("delete");
  const copying = selectedSaveMode() === "copy";
  $("#applySuffixRow").hidden = !copying;
  $("#deleteOriginalRow").hidden = !copying;
  $("#applyOutputDirectoryRow").hidden = !copying;
  $("#applySuffix").disabled = state.applyRunning;
  $("#applyTargetMode").disabled = state.applyRunning || state.saveStarting;
  $("#chooseOutputDirectoryButton").disabled = state.outputDirectoryPicking || state.applyRunning || state.saveStarting;
  $("#applyOutputDirectoryStatus").value = state.settings?.saving?.default_output_directory || "";
  $("#deleteOriginal").disabled = !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#removeAfterSave").disabled = state.applyRunning;
  $("#removeOnlyMasked").disabled = state.applyRunning || !$("#removeAfterSave").checked;
  $("#removeOnlyMaskedRow").classList.toggle("muted", !$("#removeAfterSave").checked);
  $("#applyOverwriteMode").disabled = !canOverwrite || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", !canOverwrite);
  const restriction = applyRestrictionMessage();
  const capabilityNote = !canOverwrite
    ? t("apply.overwriteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId))).length })
    : (!canDelete ? t("apply.deleteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId))).length }) : "");
  $("#applyTemporarySourceNote").textContent = restriction || capabilityNote || t("apply.handleSource");
  $("#applyTemporarySourceNote").hidden = !restriction && !capabilityNote;
  $("#applyStartButton").disabled = Boolean(restriction) || state.applyRunning || state.saveStarting || state.applyTargetIds.length === 0;
}

function refreshApplyTargets() {
  const mode = $("#applyTargetMode").value;
  state.applyTargetMode = mode; state.applyTargetIds = saveTargets(mode);
  $("#applyTargetCount").textContent = t("apply.target", { count: state.applyTargetIds.length });
  syncApplyMode();
}

async function openApplyDialog(options = {}) {
  const invoker = document.activeElement;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const initialMode = Array.isArray(options) ? "current" : (options.initialMode || "masked");
  if (isBusy() || state.importing) return;
  try { await flushDraftSaves(); }
  catch (error) { setStatus(error.message, "error"); return; }
  $("#applyTargetMode").value = initialMode;
  refreshApplyTargets();
  if (!state.applyTargetIds.length) return;
  state.applyRunning = false;
  $("#applyDivisor").value = $("#divisor").value;
  updateBlockSizeDisplay();
  $("#applyProgressPanel").hidden = true;
  $("#applyStartButton").hidden = false;
  $("#applyCloseButton").hidden = false;
  $("#applyPauseButton").hidden = true;
  $("#applyCancelButton").hidden = true;
  $("#applySettings").disabled = false;
  setApplyResult(""); syncApplyMode();
  showModalFromInvoker($("#applyDialog"), invoker);
}

function draftPayload(imageIds) {
  const drafts = {};
  for (const imageId of imageIds) {
    const draft = state.drafts.get(imageId);
    if (draft) drafts[imageId] = {
      add: draft.manualEnabled === false ? "" : draft.add,
      exclusion: draft.manualExclusionEnabled === false ? "" : draft.exclusion,
      exclusionErase: draft.manualExclusionEraseEnabled === false ? "" : draft.exclusionErase,
      manualExclusionForced: draft.manualExclusionForced ?? (state.settings?.detection?.exclude_forced_default !== false),
      removedCandidateIds: draft.removedCandidateIds || [],
    };
  }
  return drafts;
}

function renderOutputDirectory() {
  const directory = state.settings?.saving?.default_output_directory || "";
  $("#settingsDefaultOutputDirectory").value = directory;
  $("#applyOutputDirectoryStatus").value = directory;
  syncApplyMode();
}

let outputDirectoryPickRequest = null;

function setOutputDirectoryPickerBusy(picking) {
  state.outputDirectoryPicking = picking;
  $("#settingsChooseOutputDirectory").disabled = picking;
  syncApplyMode();
}

async function pickOutputDirectory() {
  if (!outputDirectoryPickRequest) {
    setOutputDirectoryPickerBusy(true);
    outputDirectoryPickRequest = api("/api/output-directory/pick", { method: "POST", body: JSON.stringify({}) })
      .then((selected) => selected.path || null)
      .finally(() => {
        outputDirectoryPickRequest = null;
        setOutputDirectoryPickerBusy(false);
      });
  }
  return outputDirectoryPickRequest;
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting) return;
  try {
    const directory = await pickOutputDirectory();
    if (!directory) return;
    const settings = await api("/api/settings?status=0", {
      method: "POST", body: JSON.stringify({ saving: { ...state.settings.saving, default_output_directory: directory } }),
    });
    setSettingsForm(settings.settings); setApplyResult("");
  } catch (error) { setApplyResult(error.message, true); }
}

async function waitForBrowserSave(save) {
  while (save.paused && !save.cancelled && !save.failed) await new Promise((resolve) => setTimeout(resolve, 100));
  return !save.cancelled && !save.failed;
}

function showBrowserSaveProgress(save, entry) {
  state.job = { kind: "apply", state: save.paused ? "paused" : "running", total: save.entries.length, completed: save.completed, current: entry?.relativePath || "" };
  $("#applyProgress").max = Math.max(1, save.entries.length);
  $("#applyProgress").value = save.completed;
  $("#applyCurrentName").textContent = entry?.relativePath || "";
  $("#applyProgressText").textContent = t("apply.progress", { completed: save.completed, total: save.entries.length });
  $("#applyPauseButton").textContent = t(save.paused ? "apply.resume" : "apply.pause");
}

function reconcileStoredMaskStatuses() {
  const remainingImageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.maskStatus.keys()) {
    if (!remainingImageIds.has(imageId)) state.maskStatus.delete(imageId);
  }
  for (const image of state.images) {
    const draft = state.drafts.get(image.id);
    if (!draft) {
      state.maskStatus.delete(image.id);
      continue;
    }
    state.maskStatus.set(image.id, draft.hasEffectiveMask === true);
  }
}

function reconcileBrowserSaveState() {
  reconcileStoredMaskStatuses();
  if (state.currentId && !state.images.some((image) => image.id === state.currentId)) {
    const removedCurrentId = state.currentId;
    state.currentId = null;
    state.currentImage = null;
    releaseCandidateBundles(removedCurrentId);
    state.candidates = [];
    clearEditor();
  } else if (state.currentId) {
    refreshMaskStatus();
    renderCandidates();
    render();
  }
  renderCatalogViews();
}

async function ensureHandlePermission(access, requireWrite = true) {
  const handle = access?.fileHandle;
  if (!handle) return;
  const options = requireWrite ? { mode: "readwrite" } : { mode: "read" };
  let permission = await handle.queryPermission?.(options);
  if (permission !== "granted") permission = await handle.requestPermission?.(options);
  if (permission && permission !== "granted") throw new Error(t("error.sourcePermissionDenied", { name: handle.name || access.name || "" }));
  const file = await handle.getFile();
  if (access.size != null && (file.size !== access.size || file.lastModified !== access.lastModified)) {
    throw new Error(t("error.sourceChanged", { name: file.name || handle.name }));
  }
}

async function ensureSaveSources(imageIds, mode, deleteOriginal) {
  for (const imageId of imageIds) {
    const image = state.images.find((entry) => entry.id === imageId);
    const access = sourceAccessFor(imageId);
    if (mode === "overwrite" && !sourceCanOverwrite(image)) throw new Error(t("apply.overwriteUnavailable", { count: 1 }));
    if (mode === "copy" && deleteOriginal && !sourceCanDelete(image)) throw new Error(t("apply.deleteUnavailable", { count: 1 }));
    if (access?.fileHandle) await ensureHandlePermission(access, mode === "overwrite" || deleteOriginal);
  }
}

async function writeSourceHandle(access, response) {
  const stream = await access.fileHandle.createWritable({ keepExistingData: false });
  try {
    await response.body.pipeTo(stream);
    const file = await access.fileHandle.getFile();
    access.name = file.name;
    access.size = file.size;
    access.lastModified = file.lastModified;
  }
  catch (error) { try { await stream.abort?.(); } catch { /* Preserve the original whenever possible. */ } throw error; }
}

async function removeSourceHandle(access) {
  if (typeof access.fileHandle.remove === "function") {
    await access.fileHandle.remove();
    return;
  }
  if (access.parentHandle) {
    await access.parentHandle.removeEntry(access.fileHandle.name || access.name);
    return;
  }
  throw new Error(t("error.sourceDeleteUnavailable", { name: access.fileHandle.name || access.name || "" }));
}

async function removeCompletedImagesFromCatalog(imageIds, initialOrder, recordsById) {
  if (!imageIds.length) return;
  const currentId = state.currentId;
  const currentIndex = initialOrder.indexOf(currentId);
  const data = await api("/api/catalog/remove", { method: "POST", body: JSON.stringify({ imageIds }) });
  state.images = data.images;
  const remainingIds = new Set(state.images.map((image) => image.id));
  const removedIds = new Set([
    ...(data.removedImageIds || []),
    ...imageIds.filter((imageId) => !remainingIds.has(imageId)),
  ]);
  if (!removedIds.size) return;

  for (const imageId of removedIds) {
    state.selectedImageIds.delete(imageId);
    releaseImageCaches(imageId);
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    clearCandidateMutationState(imageId);
    const image = recordsById.get(imageId);
    if (image) clearReviewForRemovedImage(image);
  }
  if (!state.images.length) { state.batchMode = false; clearBatchSelection(); }

  if (currentId && removedIds.has(currentId)) {
    releaseCandidateBundles(currentId);
    state.currentId = null;
    state.currentImage = null;
    state.pendingImageId = null;
    state.candidates = [];
    clearEditor();
  }
  pruneSourceAccess();
  renderCatalogViews(); updateSelectionActionBar();

  if (currentId && removedIds.has(currentId)) {
    const survivors = new Set(state.images.map((image) => image.id));
    const nextId = [...initialOrder.slice(currentIndex + 1), ...initialOrder.slice(0, currentIndex).reverse()]
      .find((imageId) => survivors.has(imageId));
    if (nextId) await selectImage(nextId, true, { saveCurrentDraft: false });
    else updateNavigationControls();
  }
  updateActionButtons();
}

async function runBrowserSave(imageIds, suffix, deleteOriginal, mode = "copy", removeAfterSave = false, removeOnlyMasked = true) {
  const result = await api("/api/save/prepare", {
    method: "POST",
    body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, deleteOriginal: false }),
  });
  const save = {
    entries: result.entries, completed: 0, stale: 0, paused: false, cancelled: false, failed: false, removeAfterSave, removeOnlyMasked,
    removableImageIds: new Set(), initialOrder: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])),
    catalogEpoch: state.catalogEpoch,
  };
  state.browserSave = save;
  state.saving = true;
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  updateActionButtons();
  try {
    {
      const saveEntry = async (entry) => {
        showBrowserSaveProgress(save, entry);
        const draft = draftPayload([entry.imageId])[entry.imageId] || null;
        const sourceImage = state.images.find((image) => image.id === entry.imageId);
        const access = sourceAccessFor(entry.imageId);
        let sourceAction = "keep";
        if (mode === "copy") {
          const response = await api("/api/save/render", {
            method: "POST", body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision,
              divisor: Number($("#applyDivisor").value), draft, copyToDefault: true, suffix }),
          });
          if (deleteOriginal) {
            if (access?.fileHandle) {
              await ensureHandlePermission(access, true);
              await removeSourceHandle(access);
            }
            sourceAction = "deleted";
          }
          const committed = await commitBrowserSaveWithRetry({
            imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken: response.saveToken,
          });
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else if (access?.fileHandle) {
          const binary = await fetch("/api/save/render", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
            body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
          });
          if (!binary.ok) { const body = await binary.json().catch(() => ({})); const error = new Error(body.error || t("error.requestFailed")); error.code = body.error_code || ""; throw error; }
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          await ensureHandlePermission(access, true);
          await writeSourceHandle(access, binary);
          sourceAction = "overwrite";
          const committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken });
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else if (sourceImage?.sourceKind === "filesystem") {
          const binary = await fetch("/api/save/render", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "" },
            body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
          });
          if (!binary.ok) { const body = await binary.json().catch(() => ({})); const error = new Error(body.error || t("error.requestFailed")); error.code = body.error_code || ""; throw error; }
          const saveToken = binary.headers?.get("X-Mozarie-Save-Token") || "";
          sourceAction = "overwrite";
          const committed = await commitBrowserSaveWithRetry({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken });
          return finishBrowserSaveEntry(committed, entry, save, sourceAction);
        } else {
          throw new Error(t("apply.overwriteUnavailable", { count: 1 }));
        }
      };
      const finishBrowserSaveEntry = (committed, entry, save, sourceAction) => {
        if (committed.cleared) {
          state.drafts.delete(entry.imageId);
          if (state.currentId === entry.imageId) {
            releaseCandidateBundles(entry.imageId);
            state.candidates = [];
            state.manualMaskPresent = false;
            state.manualEnabled = true;
            resetCurrentDraft();
          }
        }
        if (save.removeAfterSave && save.removeOnlyMasked && committed.cleared && !committed.stale) save.removableImageIds.add(entry.imageId);
        if (committed.stale) save.stale += 1;
        if (sourceAction === "overwrite" && state.currentId === entry.imageId) save.reloadCurrent = true;
        pruneSourceAccess();
        save.completed += 1;
        showBrowserSaveProgress(save, entry);
      };
      let nextEntry = 0;
      const parallelism = Math.min(save.entries.length, Math.max(1, Math.round(Number(state.settings?.saving?.parallelism) || 1)));
      const settled = await Promise.allSettled(Array.from({ length: parallelism }, async () => {
        while (true) {
          // Cancellation is observed only before an entry starts. Once an output or source has
          // changed, commit that entry so browser files and catalog state remain consistent.
          if (!await waitForBrowserSave(save)) return;
          const entry = save.entries[nextEntry++];
          if (!entry) return;
          try { await saveEntry(entry); }
          catch (error) {
            // A stale candidate can become fully excluded after the dialog was
            // opened. It is not a failed save and must never trigger deletion.
            if (error?.code === "no_effective_mask") continue;
            save.failed = true; throw error;
          }
        }
      }));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    const cancelled = save.cancelled;
    setApplyResult(cancelled
      ? t("apply.cancelled", { completed: save.completed })
      : (save.stale ? t("apply.completeWithStale", { completed: save.completed, stale: save.stale }) : t("apply.complete", { completed: save.completed })));
  } finally {
    try {
      let catalogCurrent = false;
      try {
        // Commits may resolve out of order; apply one authoritative catalogue
        // snapshot only after every started entry has settled.
        const latest = await api("/api/images");
        catalogCurrent = isCurrentCatalogEpoch(save.catalogEpoch);
        if (catalogCurrent) state.images = latest.images;
      } catch (error) {
        setApplyResult(error.message, true);
      }
      if (catalogCurrent) {
        if (save.removeAfterSave && !save.removeOnlyMasked && !save.cancelled && !save.failed && !save.stale && save.completed === save.entries.length) {
          save.removableImageIds = new Set(save.initialOrder);
        }
        try {
          await removeCompletedImagesFromCatalog([...save.removableImageIds], save.initialOrder, save.recordsById);
        } catch (error) {
          setApplyResult(error.message, true);
        }
        reconcileBrowserSaveState();
        if (save.reloadCurrent && state.currentId && state.images.some((image) => image.id === state.currentId)) {
          await selectImage(state.currentId, true, { saveCurrentDraft: false });
        }
      }
    } finally {
      state.saving = false;
      state.applyRunning = false;
      state.applyCatalogSnapshot = null;
      state.browserSave = null;
      state.job = { kind: "idle", state: "idle" };
      $("#applyPauseButton").hidden = true;
      $("#applyCancelButton").hidden = true;
      $("#applyCloseButton").hidden = false;
      updateActionButtons();
    }
  }
}

async function commitBrowserSaveWithRetry(payload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await api("/api/save/commit", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      const retryable = !error?.status || [408, 429, 502, 503, 504].includes(error.status);
      if (!retryable || attempt) throw error;
    }
  }
}

async function startApplyFromDialog(event) {
  event.preventDefault();
  const imageIds = [...state.applyTargetIds];
  if (!imageIds.length || isBusy() || state.importing) return;
  const mode = selectedSaveMode();
  const copy = mode === "copy";
  const suffix = $("#applySuffix").value.trim();
  if (copy && !suffix) return setApplyResult(t("error.requestFailed"), true);
  if (!copy && !await confirmAction(t("confirm.overwriteSource.title"), t("confirm.overwriteSource.message"), "overwriteSource")) return;
  if (copy && $("#deleteOriginal").checked && !await confirmAction(t("confirm.deleteSourceAfterCopy.title"), t("confirm.deleteSourceAfterCopy.message"), "deleteSourceAfterCopy")) return;
  // This lock is intentionally set before the first await. A second submit must never create
  // another browser save loop while permissions or the output-directory picker are pending.
  state.saveStarting = true;
  state.saving = true;
  state.applyRunning = true;
  state.applyCatalogSnapshot = { order: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])), removeOnlyMasked: $("#removeOnlyMasked").checked };
  updateActionButtons();
  if (copy && !$("#deleteOriginal").checked) {
    try {
      await flushDraftSaves(imageIds);
      await api("/api/apply", { method: "POST", body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, drafts: draftPayload(imageIds), removeAfterSave: $("#removeAfterSave").checked, removeOnlyMasked: $("#removeOnlyMasked").checked, copyToDefault: true }) });
      state.saveStarting = false; state.job = { kind: "apply", state: "running", total: imageIds.length, completed: 0, current: "" }; showRunningApply(state.job); return;
    } catch (error) { setApplyResult(error.message, true); return finishSaveStart(); }
  }
  try {
    // Permission requests must begin while this submit is still a user action.
    await ensureSaveSources(imageIds, mode, copy && $("#deleteOriginal").checked);
  } catch (error) {
    setApplyResult(error.message, true);
    return finishSaveStart();
  }
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (state.importing) return finishSaveStart();
  try {
    await flushDraftSaves(imageIds);
    state.saveStarting = false;
    await runBrowserSave(imageIds, suffix, copy && $("#deleteOriginal").checked, mode, $("#removeAfterSave").checked, $("#removeOnlyMasked").checked);
  } catch (error) {
    setApplyResult(error.message, true);
    state.saving = false;
    state.applyRunning = false;
    state.applyCatalogSnapshot = null;
    state.browserSave = null;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    updateActionButtons();
  }
}

function finishSaveStart() {
  state.saveStarting = false;
  state.saving = false;
  state.applyRunning = false;
  state.applyCatalogSnapshot = null;
  updateActionButtons();
}

async function controlApply(action) {
  if (state.browserSave) {
    if (action === "cancel") state.browserSave.cancelled = true;
    if (action === "pause") state.browserSave.paused = true;
    if (action === "resume") state.browserSave.paused = false;
    showBrowserSaveProgress(state.browserSave, state.browserSave.entries[state.browserSave.completed]);
    return;
  }
  try { await api(`/api/job/${action}`, { method: "POST", body: JSON.stringify({}) }); }
  catch (error) { setApplyResult(error.message, true); }
}

function showRunningApply(job) {
  state.applyRunning = true;
  $("#applySettings").disabled = true;
  $("#applyProgressPanel").hidden = false;
  $("#applyStartButton").hidden = true;
  $("#applyCloseButton").hidden = true;
  $("#applyPauseButton").hidden = false;
  $("#applyCancelButton").hidden = false;
  const dialog = $("#applyDialog");
  showModalFromInvoker(dialog);
}

async function finishApplyJob(job) {
  if (state.applyFinishing) return;
  state.applyFinishing = true;
  let reconciled = false;
  const generation = ++state.imageGeneration;
  const catalogEpoch = state.catalogEpoch;
  try {
    const keepCurrent = state.currentId;
    const previousOrder = state.images.map((image) => image.id);
    const previousImagesById = new Map(state.images.map((image) => [image.id, image]));
    const requestedImageIds = Array.isArray(job.imageIds) ? job.imageIds : state.applyTargetIds;
    const completedImageIds = Array.isArray(job.completedImageIds)
      ? job.completedImageIds
      : (job.state === "complete" ? requestedImageIds : []);
    const reloadCurrent = Boolean(keepCurrent && completedImageIds.includes(keepCurrent));
    const data = await api("/api/images");
    if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = data.images;
    pruneSourceAccess();
    const reloadedImagesById = new Map(state.images.map((image) => [image.id, image]));
    for (const imageId of completedImageIds) {
      const previousImage = previousImagesById.get(imageId);
      const reloadedImage = reloadedImagesById.get(imageId);
      if (previousImage && reloadedImage) moveReviewedPathAfterApply(previousImage, reloadedImage);
    }
    state.maskStatus.clear();
    for (const imageId of completedImageIds) state.drafts.delete(imageId);
    state.applyTargetIds = requestedImageIds;
    const snapshot = state.applyCatalogSnapshot;
    const fullyCompleted = job.state === "complete" && completedImageIds.length === requestedImageIds.length;
    const removableImageIds = job.removeAfterSave && fullyCompleted && snapshot?.removeOnlyMasked === false
      ? snapshot.order
      : completedImageIds;
    const removalOrder = snapshot?.removeOnlyMasked === false ? snapshot.order : previousOrder;
    const removalRecords = snapshot?.removeOnlyMasked === false ? snapshot.recordsById : previousImagesById;
    if (job.removeAfterSave && removableImageIds.length && (fullyCompleted || snapshot?.removeOnlyMasked !== false)) {
      await removeCompletedImagesFromCatalog(removableImageIds, removalOrder, removalRecords);
      if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
    }
    const removedAfterSave = Boolean(job.removeAfterSave && removableImageIds.length && (fullyCompleted || snapshot?.removeOnlyMasked !== false));
    if (removedAfterSave) {
      // removeCompletedImagesFromCatalog already selects the next surviving image.
    } else if (reloadCurrent) {
      releaseCandidateBundles(keepCurrent);
      state.candidates = [];
    }
    const reloadedCurrent = reloadCurrent && state.images.some((image) => image.id === keepCurrent);
    if (removedAfterSave) {
      // The batch cleanup above has restored either a neighboring image or an empty editor.
    } else if (reloadedCurrent) {
      await selectImage(keepCurrent, true, { saveCurrentDraft: false });
    } else if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
      refreshMaskStatus();
      renderCandidates();
      render();
    }
    else { state.currentId = null; state.currentImage = null; clearEditor(); }
    renderCatalogViews();
    state.saving = false;
    state.applyRunning = false;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    if (job.state === "complete") setApplyResult(t("apply.complete", { completed: job.completed }));
    else if (job.state === "cancelled") setApplyResult(t("apply.cancelled", { completed: job.completed }));
    else setApplyResult(t("apply.error", { error: jobErrorMessage(job) }), true);
    updateActionButtons();
    reconciled = true;
  } finally {
    if (reconciled && job.startedAt != null) state.handledApplyStartedAt = job.startedAt;
    if (reconciled) state.applyCatalogSnapshot = null;
    state.applyFinishing = false;
  }
}

function isTerminalDetection(job, previous) {
  if (job.kind !== "detect" || !["complete", "cancelled", "error"].includes(job.state) || job.startedAt == null || state.handledDetectionStartedAt === job.startedAt) return false;
  const observedRunning = previous?.kind === "detect" && previous?.startedAt === job.startedAt && ["running", "pausing", "paused"].includes(previous.state);
  const reconciliationPending = state.processing?.kind === "detect" && state.processing?.startedAt === job.startedAt;
  return observedRunning || Number(job.startedAt) >= state.pageLoadedAt || reconciliationPending;
}

function jobErrorMessage(job) {
  if (!job.errorCode) return job.error || t("error.background");
  const key = errorCodeTranslationKey(job.errorCode, job.params || {});
  const localized = t(key, job.params || {});
  return localized === key ? (job.error || t("error.background")) : localized;
}

async function finishDetectionJob(job) {
  const generation = ++state.imageGeneration;
  const catalogEpoch = state.catalogEpoch;
  const keepCurrent = state.currentId;
  const requestedIds = Array.isArray(job.imageIds) && job.imageIds.length ? job.imageIds : state.detectionTargetIds;
  const targetIds = Array.isArray(job.completedImageIds) && job.completedImageIds.length
    ? job.completedImageIds
    : (job.state === "complete" ? requestedIds : []);
  const data = await api("/api/images");
  if (!isCurrentGeneration(generation) || !isCurrentCatalogEpoch(catalogEpoch)) return;
  state.images = data.images;
  pruneSourceAccess();
  state.maskStatus.clear();
  markImagesUnreviewed(targetIds, false);
  state.handledDetectionStartedAt = job.startedAt;
  state.detectionTargetIds = [];
  state.detectCancelRequested = false;
  closeProcessing();
  if (keepCurrent && state.images.some((image) => image.id === keepCurrent)) {
    await selectImage(keepCurrent, true);
  }
  renderCatalogViews();
}

async function pollJob() {
  if (state.browserSave) { scheduleJobPoll(); return; }
  if (state.pollInFlight) return state.pollInFlight;
  state.pollInFlight = (async () => {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; state.pollFailures = 0; updateProgress(job);
    const jobError = jobErrorMessage(job);
    const terminalApply = isTerminalApply(job);
    if (terminalApply) {
      await finishApplyJob(job);
      if (job.state === "complete") setStatusKey("status.applyDone");
      else if (job.state === "cancelled") setStatusKey("status.applyCancelled");
      else if (jobError) setStatus(jobError, "error");
      else setStatusKey("error.background", {}, "error");
    } else if (job.kind === "apply" && ["running", "pausing", "paused"].includes(job.state)) {
      if (!state.applyRunning) showRunningApply(job);
      $("#applyProgress").max = Math.max(1, Number(job.total) || 1);
      $("#applyProgress").value = Math.min(Number(job.total) || 1, Number(job.completed) || 0);
      $("#applyCurrentName").textContent = job.current || "";
      $("#applyProgressText").textContent = t("apply.progress", { completed: job.completed, total: job.total });
      $("#applyPauseButton").textContent = t(job.state === "paused" ? "apply.resume" : "apply.pause");
      $("#applyPauseButton").disabled = job.state === "pausing";
      if (job.state === "running") setStatusKey("status.applyProgress", { completed: job.completed, total: job.total, current: job.current }, "running");
    } else if (isTerminalDetection(job, previous)) {
    await finishDetectionJob(job);
      if (job.state === "error") setStatus(jobError, "error");
      else if (job.state === "cancelled") setStatusKey("status.detectCancelled", { completed: job.completed });
      else setStatusKey("status.detectDone");
    }
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) setStatusKey("error.connectionLost", {}, "error");
  }
  })();
  try { return await state.pollInFlight; }
  finally { state.pollInFlight = null; scheduleJobPoll(); }
}
function scheduleJobPoll(immediate = false) {
  clearTimeout(state.jobPollTimer);
  const active = ["running", "pausing", "paused"].includes(state.job?.state);
  const delay = immediate ? 0 : document.visibilityState === "hidden" ? 10000 : state.pollFailures ? Math.min(15000, 2500 * (2 ** Math.min(state.pollFailures, 3))) : active ? 600 : 2500;
  state.jobPollTimer = setTimeout(() => { void pollJob(); }, delay);
}
