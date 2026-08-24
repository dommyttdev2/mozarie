function setTool(tool) {
  if (isBusy() || state.importing) return;
  const focusedInBoundaryMenu = closeBoundaryModeMenu();
  const boundaryTools = new Set(["boundary", "polygon", "boundary_brush", "bucket", "exclude_bucket"]);
  if (!boundaryTools.has(tool)) clearBoundaryInteraction();
  else if (state.tool !== tool) clearBoundaryConstruction();
  state.tool = tool;
  for (const [id, name] of [["#brushTool", "brush"], ["#mosaicEraserTool", "mosaic_eraser"], ["#eraserTool", "eraser"], ["#excludeEraserTool", "exclude_eraser"], ["#rectangleTool", "boundary"], ["#polygonTool", "polygon"], ["#boundaryBrushTool", "boundary_brush"], ["#bucketTool", "bucket"], ["#excludeBucketTool", "exclude_bucket"]]) {
    const active = tool === name; $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("#boundaryTool").classList.toggle("active", boundaryTools.has(tool));
  $("#boundaryTool").setAttribute("aria-pressed", String(boundaryTools.has(tool)));
  $("#bucketToleranceControl").hidden = !["bucket", "exclude_bucket"].includes(tool);
  canvas.style.cursor = ["mosaic_eraser", "eraser", "exclude_eraser"].includes(tool) ? "cell" : "crosshair";
  updateBoundaryActions(); render();
  if (focusedInBoundaryMenu) focusCanvas();
}

function setBoundaryModeMenuOpen(open) {
  const menu = $("#boundaryModeMenu");
  menu.hidden = !open;
  $("#boundaryTool").setAttribute("aria-expanded", String(open));
}

function closeBoundaryModeMenu({ restoreFocus = false } = {}) {
  const menu = $("#boundaryModeMenu");
  const focusedInMenu = menu.contains?.(document.activeElement);
  setBoundaryModeMenuOpen(false);
  if (focusedInMenu && restoreFocus) focusElement($("#boundaryTool"));
  return Boolean(focusedInMenu);
}
function updateBrushSize(value) {
  if (isBusy() || state.importing) return;
  const input = $("#brushSize"); input.value = Math.min(500, Math.max(1, Math.round(value)));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render();
}
function updateBlockSizeDisplay() {
  const currentBlockSize = calculatedBlockSize(currentRecord(), mosaicDivisor());
  const applyBlockSize = calculatedBlockSize(currentRecord(), normaliseDivisor($("#applyDivisor").value));
  $("#blockSizeValue").textContent = currentBlockSize ? t("editor.calculatedPixels", { value: currentBlockSize }) : "";
  $("#applyBlockSize").textContent = applyBlockSize ? t("editor.calculatedPixels", { value: applyBlockSize }) : "";
}

function confirmAction(title, message, key = null) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  if (key && (newConfirmation.has(key) ? state.settings?.confirmations?.[key] !== true : state.settings?.confirmations?.[key] === false)) return Promise.resolve(true);
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  return new Promise((resolve) => {
    const finish = () => {
      const accepted = dialog.returnValue === "confirm";
      if (accepted && key && $("#confirmNeverShow").checked && state.settings) {
        state.settings.confirmations = { ...state.settings.confirmations, [key]: false };
        void api("/api/settings?status=0", { method: "POST", body: JSON.stringify(state.settings) }).then((data) => {
          state.settings = data.settings;
        }).catch(() => {});
      }
      $("#confirmNeverShow").checked = false; resolve(accepted);
    };
    dialog.addEventListener("close", finish, { once: true });
    dialog.showModal();
  });
}
function confirmationRequired(key) {
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  return newConfirmation.has(key) ? state.settings?.confirmations?.[key] === true : state.settings?.confirmations?.[key] !== false;
}

function resetCurrentDraft() {
  if (!state.currentImage) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
  resetHistoryToCurrentManualMask(); refreshMaskStatus(true); render();
}

async function clearMasks(imageIds, titleKey, messageKey) {
  if (!imageIds.length || isBusy() || state.importing) return;
  if (!await confirmAction(t(titleKey), t(messageKey), "clearMasks")) return;
  state.masksClearing = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await api("/api/masks/clear", { method: "POST", body: JSON.stringify({ imageIds }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    for (const imageId of imageIds) state.drafts.delete(imageId);
    for (const imageId of imageIds) releaseCandidateBundles(imageId);
    if (imageIds.includes(state.currentId)) {
      state.candidates = []; resetCurrentDraft();
      $("#candidateStatus").textContent = t("candidates.none"); renderCandidates();
    }
    const refreshed = await api("/api/images");
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = refreshed.images;
    state.images.forEach((image) => {
      if (imageIds.includes(image.id)) {
        image.candidateCount = 0;
        image.enabledCandidateCount = 0;
      }
    });
    imageIds.forEach((imageId) => state.maskStatus.delete(imageId));
    markImagesUnreviewed(imageIds, false);
    renderCatalogViews(); updateNavigationControls(); clearStatus();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.masksClearing = false; updateActionButtons(); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"), "clearCatalog")) return;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await api("/api/catalog/clear", { method: "POST", body: JSON.stringify({}) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    clearStoredCatalogState();
    resetCatalog([], "");
    clearStatus();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

function closeCatalogContextMenu() {
  const menu = $("#catalogContextMenu");
  if (menu.matches?.(":popover-open")) menu.hidePopover();
  state.contextMenuImageId = null;
  const origin = state.contextMenuOrigin;
  state.contextMenuOrigin = null;
  focusElement(origin);
}

function positionCatalogContextMenu(menu, clientX, clientY) {
  const padding = 8;
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement?.clientHeight || window.innerHeight;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(Math.max(padding, clientX), Math.max(padding, viewportWidth - width - padding))}px`;
  menu.style.top = `${Math.min(Math.max(padding, clientY), Math.max(padding, viewportHeight - height - padding))}px`;
}

function openCatalogContextMenu(event, imageId) {
  if (isBusy() || state.importing) return;
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  event.preventDefault();
  state.contextMenuImageId = imageId;
  state.contextMenuOrigin = event.currentTarget || document.activeElement;
  $("#toggleReviewMenuItem").textContent = t(isReviewed(image) ? "context.unreview" : "context.review");
  $("#removeImageMenuItem").textContent = t(isHidden(image) ? "editor.show" : "editor.hide");
  const menu = $("#catalogContextMenu");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.showPopover?.();
  positionCatalogContextMenu(menu, event.clientX, event.clientY);
  focusElement($("#toggleReviewMenuItem"));
  if (state.currentId !== imageId) void selectImage(imageId);
}

function clearReviewForRemovedImage(image) {
  const path = reviewPath(image);
  state.reviewedPaths.delete(path);
  const key = reviewStorageKey(image);
  if (key) try { localStorage.removeItem(key); } catch { /* Session state is already cleared. */ }
}

async function removeImageFromCatalog(imageId = state.contextMenuImageId) {
  if (!imageId || isBusy() || state.importing) return;
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  if (!await confirmAction(t("confirm.removeImage.title"), t("confirm.removeImage.message"), "removeImage")) return;

  closeCatalogContextMenu();
  const index = state.images.findIndex((item) => item.id === imageId);
  const nextImageId = state.images[index + 1]?.id || state.images[index - 1]?.id || null;
  const removingCurrent = state.currentId === imageId || state.pendingImageId === imageId;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    const data = await api(`/api/catalog/image/${encodeURIComponent(imageId)}`, { method: "DELETE" });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    state.images = data.images;
    state.selectedImageIds.delete(imageId);
    if (!state.images.length) { state.batchMode = false; clearBatchSelection(); }
    releaseImageCaches(imageId);
    state.sourceAccess.delete(imageId);
    state.drafts.delete(imageId);
    state.maskStatus.delete(imageId);
    clearReviewForRemovedImage(image);
    if (removingCurrent) {
      state.currentId = null; state.currentImage = null; state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
      state.candidates = []; state.candidateImages = new Map(); clearEditor();
    }
    renderCatalogViews(); updateSelectionActionBar();
    if (removingCurrent && nextImageId && state.images.some((item) => item.id === nextImageId)) {
      await selectImage(nextImageId, true, { saveCurrentDraft: false });
    } else {
      updateNavigationControls(); updateActionButtons();
      clearStatus();
    }
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) setStatus(error.message, "error"); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

async function runSelectionAction(action) {
  const images = selectedImages(); if (!images.length || isBusy() || state.importing) return;
  closeBatchMoreMenus();
  const ids = images.map((image) => image.id);
  if (action === "hide" || action === "show") { images.forEach((image) => setHidden(image, action === "hide")); return; }
  if (action === "reviewed" || action === "unreviewed") { images.forEach((image) => setReviewed(image, action === "reviewed")); renderCatalogViews(); return; }
  if (action === "detect") return openDetectionDialog(ids);
  if (action === "clear") return clearMasks(ids, "confirm.clearAllMasks.title", "confirm.clearAllMasks.message");
  if (action === "remove") {
    for (const image of [...images]) await removeImageFromCatalog(image.id);
    state.batchMode = false; clearBatchSelection(); updateSelectionActionBar();
    renderOverview();
  }
}

function droppedFile(file, relativePath = file.name, fileHandle = null, parentHandle = null) {
  return { file, relativePath, fileHandle, parentHandle };
}

async function directFilesFromDrop(dataTransfer) {
  const handles = [...dataTransfer.items]
    .map((item) => item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null)
    .filter(Boolean);
  if (handles.length) {
    const entries = [];
    async function collectHandle(handle, parent = "", parentHandle = null) {
      if (!handle) return;
      const relativePath = parent ? `${parent}/${handle.name}` : handle.name;
      if (handle.kind === "file") entries.push({ handle, relativePath, parentHandle });
      else for await (const entry of handle.values()) await collectHandle(entry, relativePath, handle);
    }
    for (const handlePromise of handles) {
      const handle = await handlePromise;
      if (handle) await collectHandle(handle);
    }
    return { handleEntries: entries };
  }
  const entries = [...dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const files = [];
    async function collectEntry(entry, parent = "") {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isFile) files.push({ name: entry.name, relativePath, getFile: () => new Promise((resolve, reject) => entry.file(resolve, reject)), fileHandle: null, parentHandle: null });
      else if (entry.isDirectory) {
        const reader = entry.createReader(); const children = [];
        while (true) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          children.push(...batch);
        }
        for (const child of children) await collectEntry(child, relativePath);
      }
    }
    for (const entry of entries) await collectEntry(entry);
    return files;
  }
  return [...dataTransfer.files].map((file) => droppedFile(file));
}

function isSupportedImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function newClientKey() {
  return globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pruneSourceAccess() {
  const imageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.sourceAccess.keys()) if (!imageIds.has(imageId)) state.sourceAccess.delete(imageId);
}

function rememberImportedSource(result) {
  for (const imported of result.data.imported || []) {
    if (imported.clientKey !== result.clientKey || !result.entry.fileHandle || !imported.imageId) continue;
    state.sourceAccess.set(imported.imageId, {
      fileHandle: result.entry.fileHandle, parentHandle: result.entry.parentHandle || null,
      name: result.entry.file.name, size: result.entry.file.size, lastModified: result.entry.file.lastModified,
    });
  }
}

async function importFiles(files) {
  const session = arguments.length > 1 ? arguments[1] : beginImportSession();
  if (!session || state.importSession !== session) return;
  const supportedFiles = [...files]
    .map((entry) => entry.file || entry.getFile ? entry : { file: entry, relativePath: entry.webkitRelativePath || entry.name, fileHandle: null, parentHandle: null })
    .filter((entry) => isSupportedImageFile(entry.file || { name: entry.name || entry.relativePath }));
  if (!supportedFiles.length) { finishImportSession(session); return; }
  try {
    session.total = supportedFiles.length; session.completed = 0; session.paused = false; session.cancelled = false;
    showProcessing({ kind: "import", state: "running", total: session.total, completed: 0, current: "" });
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
        if (session.cancelled) return;
        const index = nextIndex; nextIndex += 1;
        if (index >= supportedFiles.length) return;
        const descriptor = supportedFiles[index]; const clientKey = newClientKey();
        const file = descriptor.file || await descriptor.getFile();
        if (session.cancelled || state.importSession !== session) return;
        if (!isSupportedImageFile(file)) continue;
        const entry = { ...descriptor, file, relativePath: descriptor.relativePath || file.webkitRelativePath || file.name };
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
        const data = await importSingleFile(entry, clientKey);
        const result = { entry, clientKey, data };
        // Keep source access for each committed upload, including a later
        // cancellation or an unrelated upload failure.
        rememberImportedSource(result);
        session.completed += 1;
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
      }
    };
    const workerCount = Math.min(supportedFiles.length, importParallelism());
    const workers = Array.from({ length: workerCount }, worker);
    try {
      await Promise.all(workers);
    } catch (error) {
      // Do not schedule more files after an upload failure.  Wait for the
      // in-flight requests so the server can discard their temporary files.
      session.cancelled = true;
      await Promise.allSettled(workers);
      throw error;
    }
    if (!isCurrentCatalogEpoch(session.epoch) || state.importSession !== session) return;
    const latest = await api("/api/images");
    state.images = latest.images;
    if (session.cancelled) {
      pruneSourceAccess(); renderCatalogViews();
      setStatusKey("status.importCancelled", { completed: session.completed });
      return;
    }
    pruneSourceAccess(); renderCatalogViews(); setStatusKey("gallery.imported", { count: supportedFiles.length });
  } catch (error) {
    try {
      const latest = await api("/api/images");
      if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) { state.images = latest.images; renderCatalogViews(); }
    } catch { /* Keep the import failure visible. */ }
    if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) setStatus(error.message, "error");
  }
  finally { finishImportSession(session); }
}

async function importSingleFile(entry, clientKey) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  const response = await fetch("/api/import/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mozarie-Token": token,
      "X-Mozarie-Name": encodeURIComponent(entry.file.name),
      "X-Mozarie-Relative-Path": encodeURIComponent(entry.relativePath),
      "X-Mozarie-Client-Key": encodeURIComponent(clientKey),
    },
    body: entry.file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || t("error.requestFailed"));
    error.status = response.status;
    throw error;
  }
  return data;
}

function beginImportSession() {
  if (isBusy() || state.importing) return null;
  const session = { id: newClientKey(), epoch: beginCatalogEpoch(), paused: false, cancelled: false, completed: 0, total: 0 };
  state.importing = true; state.importSession = session;
  updateActionButtons();
  return session;
}

function finishImportSession(session) {
  if (state.importSession !== session) return;
  state.importSession = null; state.importing = false;
  closeProcessing();
  updateActionButtons();
}

async function waitForImportSession(session) {
  while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
  return !session.cancelled && state.importSession === session;
}

async function importHandleEntries(entries, session) {
  await importFiles(entries.map((entry) => ({
    ...entry, name: entry.handle.name, getFile: () => entry.handle.getFile(), fileHandle: entry.handle,
  })), session);
}

async function importFileHandles(handles, session = beginImportSession()) {
  if (!session) return;
  await importHandleEntries(handles.map((handle) => ({ handle, relativePath: handle.name, parentHandle: null })), session);
}

async function importDirectoryHandle(directoryHandle, session = beginImportSession()) {
  if (!session) return;
  const entries = [];
  showProcessing({ kind: "import", state: "running", total: 1, completed: 0, current: directoryHandle.name || "" });
  async function collect(handle, relativePath = "", parentHandle = null) {
    if (!await waitForImportSession(session)) return;
    const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
    if (handle.kind === "file") entries.push({ handle, relativePath: path, parentHandle });
    else for await (const child of handle.values()) await collect(child, path, handle);
  }
  for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
  if (!await waitForImportSession(session)) return finishImportSession(session);
  await importHandleEntries(entries, session);
}

async function pickImageFiles() {
  $("#pickerMenu").hidePopover();
  if (typeof window.showOpenFilePicker !== "function") return $("#importImagesInput").click();
  const session = beginImportSession(); if (!session) return;
  try { await importFileHandles(await window.showOpenFilePicker({ multiple: true, types: [{ description: "Images", accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] } }] }), session); }
  catch (error) { if (error?.name !== "AbortError") setStatus(error.message, "error"); finishImportSession(session); }
}

async function pickImageDirectory() {
  $("#pickerMenu").hidePopover();
  if (typeof window.showDirectoryPicker !== "function") return $("#importFolderInput").click();
  const session = beginImportSession(); if (!session) return;
  try { await importDirectoryHandle(await window.showDirectoryPicker({ mode: "readwrite", id: "mozarie-source" }), session); }
  catch (error) { if (error?.name !== "AbortError") setStatus(error.message, "error"); finishImportSession(session); }
}

async function importDroppedFiles(event) {
  event.preventDefault();
  event.stopPropagation();
  setGalleryDropOverlay(false);
  const session = beginImportSession();
  if (!session) return;
  try {
    const dropped = await directFilesFromDrop(event.dataTransfer);
    if (dropped?.handleEntries) await importHandleEntries(dropped.handleEntries, session);
    else await importFiles(dropped, session);
  } catch (error) { setStatus(error.message, "error"); }
  finally { finishImportSession(session); setGalleryDropOverlay(false); }
}

function setGalleryDropOverlay(visible) {
  $("#galleryDropOverlay").hidden = !visible;
}

function handleEditorKeydown(event) {
  if (isBusy() || state.importing || isEditableTarget(document.activeElement) || hasOpenDialog()) return false;
  if (state.viewMode !== "edit") return false;
  const binding = shortcutFromEvent(event);
  const shortcuts = state.settings?.shortcuts?.bindings || { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const enabled = state.settings?.shortcuts?.actions || {};
  if ((binding === shortcuts.undo && enabled.undo !== false) || (binding === shortcuts.redo && enabled.redo !== false)) {
    event.preventDefault();
    void restoreSnapshot(binding === shortcuts.redo ? state.historyIndex + 1 : state.historyIndex - 1);
    return true;
  }
  return false;
}

function navigationShortcutAction(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || isEditableTarget(document.activeElement) || hasOpenDialog()) return null;
  const binding = shortcutFromEvent(event);
  const bindings = state.settings?.shortcuts?.bindings || { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", reviewAndNext: "Enter", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const actionForBinding = Object.entries(bindings).find(([, value]) => value === binding)?.[0];
  if (!actionForBinding || state.settings?.shortcuts?.actions?.[actionForBinding] === false) return null;
  if (actionForBinding === "toggleOverview") return "toggleOverview";
  if (state.viewMode !== "edit") return null;
  return actionForBinding;
}

function handleNavigationKeydown(event) {
  const action = navigationShortcutAction(event);
  if (!action) return false;
  event.preventDefault();
  if (action === "toggleOverview") setViewMode(state.viewMode === "overview" ? "edit" : "overview");
  else if (action === "previous") moveCurrentBy(-1);
  else if (action === "next") moveCurrentBy(1);
  else if (action === "previousVisible") moveCurrentBy(-1);
  else if (action === "nextVisible") moveCurrentBy(1);
  else if (action === "first" && state.images[0]) void selectImage(state.images[0].id);
  else if (action === "last" && state.images.at(-1)) void selectImage(state.images.at(-1).id);
  else if (action === "reviewAndNext") reviewAndMoveNext();
  else if (action === "undo") void restoreSnapshot(state.historyIndex - 1);
  else if (action === "redo") void restoreSnapshot(state.historyIndex + 1);
  return true;
}

function handleWindowKeydown(event) {
  if (handleEditorKeydown(event)) return;
  handleNavigationKeydown(event);
}
