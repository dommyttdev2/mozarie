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
  $("#chooseOutputDirectoryButton").disabled = state.applyRunning || state.saveStarting;
  const outputDirectory = state.outputDirectoryHandle;
  $("#applyOutputDirectoryStatus").textContent = outputDirectory
    ? t("apply.outputDirectorySelected", { name: outputDirectory.name })
    : t("apply.outputDirectorySelected", { name: "Mozarie/output" });
  $("#deleteOriginal").disabled = !canDelete || state.applyRunning;
  if (!canDelete) $("#deleteOriginal").checked = false;
  $("#removeAfterSave").disabled = state.applyRunning;
  $("#applyOverwriteMode").disabled = !canOverwrite || state.applyRunning;
  $("#applyOverwriteRow").classList.toggle("muted", !canOverwrite);
  const restriction = applyRestrictionMessage();
  const capabilityNote = !canOverwrite
    ? t("apply.overwriteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanOverwrite(state.images.find((image) => image.id === imageId))).length })
    : (!canDelete ? t("apply.deleteUnavailable", { count: state.applyTargetIds.filter((imageId) => !sourceCanDelete(state.images.find((image) => image.id === imageId))).length }) : "");
  $("#applyTemporarySourceNote").textContent = restriction || capabilityNote || t("apply.handleSource");
  $("#applyTemporarySourceNote").hidden = !restriction && !capabilityNote;
  $("#applyStartButton").disabled = Boolean(restriction) || state.applyRunning;
}

async function openApplyDialog(imageIds) {
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (!imageIds.length || isBusy() || state.importing) return;
  saveDraft();
  state.applyTargetIds = imageIds;
  state.applyRunning = false;
  $("#applyTargetCount").textContent = t("apply.target", { count: imageIds.length });
  $("#applyDivisor").value = $("#divisor").value;
  updateBlockSizeDisplay();
  $("#applyProgressPanel").hidden = true;
  $("#applyStartButton").hidden = false;
  $("#applyCloseButton").hidden = false;
  $("#applyPauseButton").hidden = true;
  $("#applyCancelButton").hidden = true;
  $("#applySettings").disabled = false;
  setApplyResult(""); syncApplyMode();
  $("#applyDialog").showModal();
}

function draftPayload(imageIds) {
  const drafts = {};
  for (const imageId of imageIds) {
    const draft = state.drafts.get(imageId);
    if (draft) drafts[imageId] = {
      add: draft.manualEnabled === false ? "" : draft.add,
      exclusion: draft.exclusion,
    };
  }
  return drafts;
}

const OUTPUT_HANDLE_DB = "mozarie-output";
const OUTPUT_HANDLE_STORE = "handles";
const OUTPUT_HANDLE_KEY = "default";

function outputHandleDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTPUT_HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(OUTPUT_HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readOutputHandle() {
  const database = await outputHandleDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTPUT_HANDLE_STORE, "readonly").objectStore(OUTPUT_HANDLE_STORE).get(OUTPUT_HANDLE_KEY);
    request.onsuccess = () => { database.close(); resolve(request.result || null); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function storeOutputHandle(handle) {
  const database = await outputHandleDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(OUTPUT_HANDLE_STORE, "readwrite").objectStore(OUTPUT_HANDLE_STORE).put(handle, OUTPUT_HANDLE_KEY);
    request.onsuccess = () => { database.close(); resolve(); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function ensureOutputHandlePermission(handle) {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error(t("error.directoryPermissionDenied"));
  return handle;
}

function renderOutputHandle() {
  const label = state.outputDirectoryHandle?.name || "Mozarie/output";
  $("#settingsDefaultOutputDirectory").textContent = label;
  syncApplyMode();
}

async function selectOutputDirectory() {
  if (typeof window.showDirectoryPicker !== "function") throw new Error(t("error.directoryPickerUnsupported"));
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "mozarie-output" });
  await ensureOutputHandlePermission(handle);
  await storeOutputHandle(handle);
  state.outputDirectoryHandle = handle;
  renderOutputHandle();
  return handle;
}

async function outputDirectoryForSave() {
  if (state.outputDirectoryHandle) return ensureOutputHandlePermission(state.outputDirectoryHandle);
  return selectOutputDirectory();
}

async function pickOutputDirectory() {
  return selectOutputDirectory();
}

async function chooseOutputDirectory() {
  if (state.applyRunning || state.saveStarting) return;
  try { await selectOutputDirectory(); setApplyResult(""); }
  catch (error) { if (error?.name !== "AbortError") setApplyResult(error.message, true); }
}

async function restoreOutputDirectory() {
  try {
    const handle = await readOutputHandle();
    if (!handle || await handle.queryPermission({ mode: "readwrite" }) !== "granted") return;
    state.outputDirectoryHandle = handle;
    renderOutputHandle();
  } catch { /* The save picker remains available even when browser storage is unavailable. */ }
}

async function waitForBrowserSave(save) {
  while (save.paused && !save.cancelled) await new Promise((resolve) => setTimeout(resolve, 100));
  return !save.cancelled;
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
    const hasVisibleManualAdd = Boolean(draft.add)
      && draft.manualEnabled !== false
      && draft.manualVisible !== false;
    if (hasVisibleManualAdd) {
      state.maskStatus.set(image.id, true);
      continue;
    }
    if (!draft.exclusion) {
      state.maskStatus.delete(image.id);
      continue;
    }
    const excludesAllCandidates = Array.isArray(draft.visibleCandidateIds) && draft.visibleCandidateIds.length === 0;
    if (Number(image.enabledCandidateCount || 0) === 0 || excludesAllCandidates) {
      state.maskStatus.set(image.id, false);
    }
  }
}

function reconcileBrowserSaveState() {
  reconcileStoredMaskStatuses();
  if (state.currentId && !state.images.some((image) => image.id === state.currentId)) {
    state.currentId = null;
    state.currentImage = null;
    state.candidates = [];
    state.candidateImages.clear();
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

async function writeSourceHandle(access, bytes) {
  const stream = await access.fileHandle.createWritable({ keepExistingData: false });
  try {
    await stream.write(bytes);
    await stream.close();
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
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    state.candidateUpdateChains.delete(imageId);
    state.candidateUpdateVersions.delete(imageId);
    state.candidateDeleting.delete(imageId);
    const image = recordsById.get(imageId);
    if (image) clearReviewForRemovedImage(image);
  }

  if (currentId && removedIds.has(currentId)) {
    state.currentId = null;
    state.currentImage = null;
    state.pendingImageId = null;
    state.candidates = [];
    state.candidateImages.clear();
    clearEditor();
  }
  pruneSourceAccess();
  renderCatalogViews();

  if (currentId && removedIds.has(currentId)) {
    const survivors = new Set(state.images.map((image) => image.id));
    const nextId = [...initialOrder.slice(currentIndex + 1), ...initialOrder.slice(0, currentIndex).reverse()]
      .find((imageId) => survivors.has(imageId));
    if (nextId) await selectImage(nextId, true, { saveCurrentDraft: false });
    else updateNavigationControls();
  }
  updateActionButtons();
}

async function uniqueOutputFileHandle(rootHandle, relativePath, suffix) {
  const parts = String(relativePath).split("/").filter(Boolean);
  const sourceName = parts.pop();
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const extension = dot > 0 ? sourceName.slice(dot) : "";
  let directory = rootHandle;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  for (let index = 1; index < 10000; index += 1) {
    const name = `${stem}${suffix}${index === 1 ? "" : `_${index}`}${extension}`;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
      return { directory, name, fileHandle: await directory.getFileHandle(name, { create: true }) };
    }
  }
  throw new Error(t("error.outputNameExhausted"));
}

async function writeCopyOutput(rootHandle, entry, suffix, bytes) {
  const output = await uniqueOutputFileHandle(rootHandle, entry.relativePath, suffix);
  const fileHandle = output.fileHandle;
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try { await writable.write(bytes); await writable.close(); }
  catch (error) {
    try { await writable.abort?.(); } catch { /* Continue with best-effort cleanup below. */ }
    try { await output.directory.removeEntry(output.name); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

async function runBrowserSave(directory, imageIds, suffix, deleteOriginal, mode = "copy", removeAfterSave = false) {
  const result = await api("/api/save/prepare", {
    method: "POST",
    body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, deleteOriginal: false }),
  });
  const save = {
    directory, entries: result.entries, completed: 0, stale: 0, paused: false, cancelled: false, removeAfterSave,
    removableImageIds: new Set(), initialOrder: state.images.map((image) => image.id), recordsById: new Map(state.images.map((image) => [image.id, image])),
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
    await navigator.locks.request("mozarie-output", { mode: "exclusive" }, async () => {
      const saveEntry = async (entry) => {
        showBrowserSaveProgress(save, entry);
        const draft = draftPayload([entry.imageId])[entry.imageId] || null;
        const response = await fetch("/api/save/render", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mozarie-Token": document.querySelector('meta[name="mozarie-token"]')?.content || "",
          },
          body: JSON.stringify({ imageId: entry.imageId, candidateRevision: entry.candidateRevision, divisor: Number($("#applyDivisor").value), draft }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || t("error.requestFailed"));
        }
        const saveToken = response.headers?.get("X-Mozarie-Save-Token") || "";
        const bytes = await response.arrayBuffer();
        const sourceImage = state.images.find((image) => image.id === entry.imageId);
        const access = sourceAccessFor(entry.imageId);
        let sourceAction = "keep";
        if (mode === "copy") {
          await writeCopyOutput(directory, entry, suffix, bytes);
          if (deleteOriginal) {
            if (access?.fileHandle) await removeSourceHandle(access);
            sourceAction = "deleted";
          }
        } else if (access?.fileHandle) {
          await writeSourceHandle(access, bytes);
          sourceAction = "overwrite";
        } else if (sourceImage?.sourceKind === "filesystem") {
          sourceAction = "overwrite";
        } else {
          throw new Error(t("apply.overwriteUnavailable", { count: 1 }));
        }
        const committed = await commitBrowserSaveWithRetry({
          imageId: entry.imageId, candidateRevision: entry.candidateRevision, deleteOriginal, sourceAction, saveToken,
        });
        if (committed.cleared) {
          state.drafts.delete(entry.imageId);
          if (state.currentId === entry.imageId) {
            state.candidates = [];
            state.candidateImages.clear();
            state.manualMaskPresent = false;
            state.manualEnabled = true;
            resetCurrentDraft();
          }
        }
        if (save.removeAfterSave && committed.cleared && !committed.stale) save.removableImageIds.add(entry.imageId);
        if (committed.stale) save.stale += 1;
        state.images = committed.images;
        if (sourceAction === "overwrite" && state.currentId === entry.imageId) save.reloadCurrent = true;
        pruneSourceAccess();
        save.completed += 1;
        showBrowserSaveProgress(save, entry);
      };
      let nextEntry = 0;
      const parallelism = Math.min(save.entries.length, Math.max(1, Math.round(Number(state.settings?.saving?.parallelism) || 1)));
      await Promise.all(Array.from({ length: parallelism }, async () => {
        while (true) {
          // Cancellation is observed only before an entry starts. Once an output or source has
          // changed, commit that entry so browser files and catalog state remain consistent.
          if (!await waitForBrowserSave(save)) return;
          const entry = save.entries[nextEntry++];
          if (!entry) return;
          await saveEntry(entry);
        }
      }));
    });
    const cancelled = save.cancelled;
    setApplyResult(cancelled
      ? t("apply.cancelled", { completed: save.completed })
      : (save.stale ? t("apply.completeWithStale", { completed: save.completed, stale: save.stale }) : t("apply.complete", { completed: save.completed })));
  } finally {
    state.saving = false;
    state.applyRunning = false;
    state.browserSave = null;
    state.job = { kind: "idle", state: "idle" };
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    try {
      await removeCompletedImagesFromCatalog([...save.removableImageIds], save.initialOrder, save.recordsById);
    } catch (error) {
      setApplyResult(error.message, true);
    }
    reconcileBrowserSaveState();
    if (save.reloadCurrent && state.currentId && state.images.some((image) => image.id === state.currentId)) {
      await selectImage(state.currentId, true, { saveCurrentDraft: false });
    }
    updateActionButtons();
  }
}

async function commitBrowserSaveWithRetry(payload) {
  const delays = [0, 150, 300, 600, 1000, 1500, 2000, 2000, 2000, 2000, 2000, 2000];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await api("/api/save/commit", { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      lastError = error;
      if (error?.status && ![408, 429].includes(error.status) && error.status < 500) throw error;
    }
  }
  throw lastError || new Error(t("error.requestFailed"));
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
  updateActionButtons();
  if (copy && !state.outputDirectoryHandle) {
    try {
      await api("/api/apply", { method: "POST", body: JSON.stringify({ imageIds, divisor: Number($("#applyDivisor").value), suffix, drafts: draftPayload(imageIds), removeAfterSave: $("#removeAfterSave").checked, copyToDefault: true }) });
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
  let outputDirectory = null;
  if (copy) {
    try {
      // An existing tab-scoped handle is reused. The picker only opens on the
      // first copy save or after the user explicitly changes the destination.
      outputDirectory = await outputDirectoryForSave();
      if (!outputDirectory) return finishSaveStart();
    } catch (error) {
      setApplyResult(error.message, true);
      return finishSaveStart();
    }
  }
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (state.importing) return finishSaveStart();
  try {
    state.saveStarting = false;
    await runBrowserSave(outputDirectory, imageIds, suffix, copy && $("#deleteOriginal").checked, mode, $("#removeAfterSave").checked);
  } catch (error) {
    setApplyResult(error.message, true);
    state.saving = false;
    state.applyRunning = false;
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
  if (!dialog.open) dialog.showModal();
}

async function finishApplyJob(job) {
  if (state.applyFinishing) return;
  state.applyFinishing = true;
  let reconciled = false;
  const generation = ++state.imageGeneration;
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
    if (!isCurrentGeneration(generation)) return;
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
    if (job.removeAfterSave && completedImageIds.length) {
      await removeCompletedImagesFromCatalog(completedImageIds, previousOrder, previousImagesById);
    }
    const removedAfterSave = Boolean(job.removeAfterSave && completedImageIds.length);
    if (removedAfterSave) {
      // removeCompletedImagesFromCatalog already selects the next surviving image.
    } else if (reloadCurrent) {
      state.candidates = [];
      state.candidateImages.clear();
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
    state.applyRunning = false;
    $("#applyPauseButton").hidden = true;
    $("#applyCancelButton").hidden = true;
    $("#applyCloseButton").hidden = false;
    if (job.state === "complete") setApplyResult(t("apply.complete", { completed: job.completed }));
    else if (job.state === "cancelled") setApplyResult(t("apply.cancelled", { completed: job.completed }));
    else setApplyResult(t("apply.error", { error: job.error || t("error.background") }), true);
    reconciled = true;
  } finally {
    if (reconciled && job.startedAt != null) state.handledApplyStartedAt = job.startedAt;
    state.applyFinishing = false;
  }
}

function isTerminalDetection(job, previous) {
  if (job.kind !== "detect" || !["complete", "cancelled"].includes(job.state) || job.startedAt == null || state.handledDetectionStartedAt === job.startedAt) return false;
  const observedRunning = previous?.kind === "detect" && previous?.startedAt === job.startedAt && ["running", "paused"].includes(previous.state);
  return observedRunning || Number(job.startedAt) >= state.pageLoadedAt;
}

async function finishDetectionJob(job) {
  const generation = ++state.imageGeneration;
  const keepCurrent = state.currentId;
  const requestedIds = Array.isArray(job.imageIds) && job.imageIds.length ? job.imageIds : state.detectionTargetIds;
  const targetIds = Array.isArray(job.completedImageIds) && job.completedImageIds.length
    ? job.completedImageIds
    : (job.state === "complete" ? requestedIds : []);
  const data = await api("/api/images");
  if (!isCurrentGeneration(generation)) return;
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
  if (state.browserSave) return;
  if (state.pollInFlight) return state.pollInFlight;
  state.pollInFlight = (async () => {
  try {
    const job = await api("/api/job"); const previous = state.job; state.job = job; state.pollFailures = 0; updateProgress(job);
    const terminalApply = isTerminalApply(job);
    if (terminalApply) {
      await finishApplyJob(job);
      if (job.state === "complete") setStatusKey("status.applyDone");
      else if (job.state === "cancelled") setStatusKey("status.applyCancelled");
      else if (job.error) setStatus(job.error, "error");
      else setStatusKey("error.background", {}, "error");
    } else if (job.kind === "apply" && ["running", "paused"].includes(job.state)) {
      if (!state.applyRunning) showRunningApply(job);
      $("#applyProgress").max = Math.max(1, Number(job.total) || 1);
      $("#applyProgress").value = Math.min(Number(job.total) || 1, Number(job.completed) || 0);
      $("#applyCurrentName").textContent = job.current || "";
      $("#applyProgressText").textContent = t("apply.progress", { completed: job.completed, total: job.total });
      $("#applyPauseButton").textContent = t(job.state === "paused" ? "apply.resume" : "apply.pause");
      if (job.state === "running") setStatusKey("status.applyProgress", { completed: job.completed, total: job.total, current: job.current }, "running");
    } else if (job.kind === "detect" && job.state === "error" && previous?.state !== "error") {
      state.detectCancelRequested = false;
      await finishDetectionJob(job);
      if (job.error) setStatus(job.error, "error");
      else setStatusKey("error.background", {}, "error");
  } else if (isTerminalDetection(job, previous)) {
    await finishDetectionJob(job);
      if (job.state === "cancelled") setStatusKey("status.detectCancelled", { completed: job.completed });
      else setStatusKey("status.detectDone");
    }
  } catch (error) {
    state.pollFailures += 1;
    if (state.pollFailures >= 3) setStatusKey("error.connectionLost", {}, "error");
  }
  })();
  try { return await state.pollInFlight; }
  finally { state.pollInFlight = null; }
}

