function setTool(tool) {
  if (isBusy() || state.importing || (catalogStagingEditsActive() && ["boundary", "polygon", "boundary_brush"].includes(tool))) return;
  const previousTool = state.tool;
  const toggleTolerance = fillToleranceToggleRequest === tool;
  fillToleranceToggleRequest = null;
  const focusedInBoundaryMenu = closeBoundaryModeMenu();
  const boundaryTools = new Set(["boundary", "polygon", "boundary_brush"]);
  if (!boundaryTools.has(tool)) clearBoundaryInteraction();
  else if (state.tool !== tool) clearBoundaryConstruction();
  state.tool = tool;
  for (const [id, name] of [["#brushTool", "brush"], ["#bucketTool", "bucket"], ["#mosaicEraserTool", "mosaic_eraser"], ["#eraserTool", "eraser"], ["#excludeBucketTool", "exclude_bucket"], ["#excludeEraserTool", "exclude_eraser"], ["#rectangleTool", "boundary"], ["#polygonTool", "polygon"], ["#boundaryBrushTool", "boundary_brush"]]) {
    const active = tool === name; $(id).classList.toggle("active", active); $(id).setAttribute("aria-pressed", String(active));
  }
  $("#boundaryTool").classList.toggle("active", boundaryTools.has(tool));
  $("#boundaryTool").setAttribute("aria-pressed", String(boundaryTools.has(tool)));
  const toleranceAnchor = tool === "bucket" ? $("#bucketToolAnchor") : (tool === "exclude_bucket" ? $("#excludeBucketToolAnchor") : null);
  if (toleranceAnchor && previousTool === tool && (toggleTolerance || (fillToleranceSession?.anchor === toleranceAnchor && $("#bucketToleranceControl").matches?.(":popover-open")))) closeFillToleranceControl({ focus: true });
  else if (toleranceAnchor) openFillToleranceControl(toleranceAnchor);
  else closeFillToleranceControl();
  const toleranceOpen = $("#bucketToleranceControl").matches?.(":popover-open") === true;
  $("#bucketTool").setAttribute("aria-expanded", String(toleranceOpen && tool === "bucket"));
  $("#excludeBucketTool").setAttribute("aria-expanded", String(toleranceOpen && tool === "exclude_bucket"));
  canvas.style.cursor = "default";
  updateBoundaryActions(); render(); updateBrushCursor();
  if (focusedInBoundaryMenu) focusCanvas();
}

let fillToleranceSession = null;
let fillToleranceToggleRequest = null;

function rememberFillToleranceTrigger(tool) {
  const anchor = tool === "bucket" ? $("#bucketToolAnchor") : $("#excludeBucketToolAnchor");
  fillToleranceToggleRequest = state.tool === tool && fillToleranceSession?.anchor === anchor && $("#bucketToleranceControl").matches?.(":popover-open") ? tool : null;
}

function positionFillToleranceControl(anchor) {
  const panel = $("#bucketToleranceControl");
  const anchorRect = anchor.getBoundingClientRect(); const panelRect = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - panelRect.width - 8, anchorRect.left));
  const below = anchorRect.bottom + 5;
  const top = below + panelRect.height <= window.innerHeight - 8 ? below : Math.max(8, anchorRect.top - panelRect.height - 5);
  panel.style.left = `${left}px`; panel.style.top = `${top}px`;
}

function openFillToleranceControl(anchor) {
  const panel = $("#bucketToleranceControl");
  if (panel.matches?.(":popover-open") && fillToleranceSession?.anchor === anchor) return;
  if (fillToleranceSession) closeFillToleranceControl();
  fillToleranceSession = { anchor };
  panel.showPopover(); positionFillToleranceControl(anchor);
}

function closeFillToleranceControl({ focus = false } = {}) {
  const session = fillToleranceSession;
  if (!session) return;
  fillToleranceSession = null;
  const panel = $("#bucketToleranceControl");
  if (panel.matches?.(":popover-open")) panel.hidePopover();
  $("#bucketTool").setAttribute("aria-expanded", "false");
  $("#excludeBucketTool").setAttribute("aria-expanded", "false");
  if (focus && session.anchor?.isConnected) session.anchor.querySelector("button")?.focus();
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
  const input = $("#brushSize"); input.value = Math.max(1, Math.round(value));
  $("#brushSizeValue").textContent = t("editor.pixels", { value: input.value }); render(); updateBrushCursor();
}
function updateBlockSizeDisplay() {
  const currentBlockSize = calculatedBlockSize(currentRecord(), mosaicDivisor());
  const applyBlockSize = calculatedBlockSize(currentRecord(), normaliseDivisor($("#applyDivisor").value));
  $("#blockSizeValue").textContent = currentBlockSize ? t("editor.calculatedPixels", { value: currentBlockSize }) : "";
  $("#applyBlockSize").textContent = applyBlockSize ? t("editor.calculatedPixels", { value: applyBlockSize }) : "";
}

function confirmAction(title, message, key = null) {
  const alwaysConfirm = key === "sourceDelete";
  if (alwaysConfirm) key = null;
  const newConfirmation = new Set(["candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy"]);
  if (key && (newConfirmation.has(key) ? state.settings?.confirmations?.[key] !== true : state.settings?.confirmations?.[key] === false)) return Promise.resolve(true);
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmNeverShow").closest("label").hidden = alwaysConfirm;
  return new Promise((resolve) => {
    const finish = () => {
      const accepted = dialog.returnValue === "confirm";
      if (accepted && key && $("#confirmNeverShow").checked && state.settings) {
        state.settings.confirmations = { ...state.settings.confirmations, [key]: false };
        void api("/api/settings?status=0", { method: "POST", body: JSON.stringify(state.settings) }).then((data) => {
          state.settings = data.settings;
        }).catch(() => {});
      }
      $("#confirmNeverShow").checked = false; $("#confirmNeverShow").closest("label").hidden = false; resolve(accepted);
    };
    dialog.addEventListener("close", finish, { once: true });
    showModalFromInvoker(dialog);
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
  state.manualMaskPresent = false; state.manualExclusionPresent = false; state.manualExclusionErasePresent = false; state.manualEnabled = true; state.manualExclusionEnabled = true; state.manualExclusionEraseEnabled = true;
  state.maskDirty = true; flushMaskComposition();
  resetHistoryToCurrentManualMask(); refreshMaskStatus(true); render();
}

async function clearMasks(imageIds, titleKey, messageKey, expectedImageId = null, expectedGeneration = null) {
  const ids = new Set(processableImages().map((image) => image.id));
  imageIds = [...new Set(imageIds)].filter((imageId) => ids.has(imageId));
  if (!imageIds.length || isBusy() || state.importing || catalogStagingEditsActive() || currentImageActionPending()) return;
  if (!await confirmAction(t(titleKey, { count: imageIds.length }), t(messageKey, { count: imageIds.length }), "clearMasks")) return;
  if (expectedImageId && (state.currentId !== expectedImageId || !isCurrentGeneration(expectedGeneration) || currentImageActionPending())) return;
  state.masksClearing = true;
  let catalogEpoch = null;
  updateActionButtons();
  try {
    await flushAllImageMutations();
    await Promise.all([...new Set(imageIds)].map(flushWorkspaceDraft));
    if (expectedImageId && (state.currentId !== expectedImageId || !isCurrentGeneration(expectedGeneration) || currentImageActionPending())) return;
    catalogEpoch = beginCatalogEpoch();
    await api("/api/masks/clear", { method: "POST", body: JSON.stringify({ imageIds }) });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    const capturedProjectId = state.project?.id || null; const capturedCatalogGeneration = state.serverCatalogGeneration;
    const refreshed = await api("/api/images");
    const replaced = reconcileCatalogSnapshot(refreshed, capturedProjectId, capturedCatalogGeneration);
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    if (!replaced) await refreshWorkspaceImages(refreshed, imageIds, { clearWorkspace: true });
    clearStatus();
  } catch (error) { if (catalogEpoch === null || isCurrentCatalogEpoch(catalogEpoch)) showUserError(error); }
  finally { state.masksClearing = false; updateActionButtons(); }
}

async function clearCatalog() {
  if (!state.images.length || isBusy() || state.importing || catalogStagingEditsActive()) return;
  if (!await confirmAction(t("confirm.clearCatalog.title"), t("confirm.clearCatalog.message"), "clearCatalog")) return;
  state.catalogMutation = true;
  const catalogEpoch = beginCatalogEpoch();
  ++state.imageGeneration;
  updateActionButtons();
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    await catalogApi("/api/catalog/clear", {}, { method: "POST" });
    if (!isCurrentCatalogEpoch(catalogEpoch)) return;
    clearStoredCatalogState();
    resetCatalog([], "");
    state.project = null;
    state.projectReadOnly = false;
    state.missingNativeSources = [];
    renderProjectCurrent();
    clearStatus();
  } catch (error) { if (isCurrentCatalogEpoch(catalogEpoch)) showUserError(error); }
  finally { state.catalogMutation = false; updateActionButtons(); }
}

function closeCatalogContextMenu({ restoreFocus = true } = {}) {
  const menu = $("#catalogContextMenu");
  if (menu.matches?.(":popover-open")) menu.hidePopover();
  state.contextMenuImageId = null;
  state.contextMenuScroll = null;
  const origin = state.contextMenuOrigin;
  state.contextMenuOrigin = null;
  if (restoreFocus) focusElement(origin);
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
  const keyboardEvent = event.type === "keydown";
  state.contextMenuOrigin = keyboardEvent ? event.currentTarget : document.activeElement;
  state.contextMenuScroll = { gallery: $("#gallery").scrollTop, overview: $("#overviewGrid").scrollTop };
  $("#toggleReviewMenuItem").textContent = t(isReviewed(image) ? "context.unreview" : "context.review");
  $("#copyImagePathMenuItem").hidden = !image.sourcePath;
  $("#removeImageMenuItem").textContent = t(isHidden(image) ? "editor.show" : "editor.hide");
  const menu = $("#catalogContextMenu");
  const cardRect = state.contextMenuOrigin?.getBoundingClientRect?.();
  const clientX = !keyboardEvent && Number.isFinite(event.clientX) ? event.clientX : (cardRect ? cardRect.left + Math.min(24, cardRect.width / 2) : 8);
  const clientY = !keyboardEvent && Number.isFinite(event.clientY) ? event.clientY : (cardRect ? cardRect.top + Math.min(24, cardRect.height / 2) : 8);
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.showPopover?.();
  positionCatalogContextMenu(menu, clientX, clientY);
  if (keyboardEvent) focusElement($("#toggleReviewMenuItem"));
}

async function copyContextMenuImagePath() {
  const image = state.images.find((item) => item.id === state.contextMenuImageId);
  const origin = state.contextMenuOrigin;
  closeCatalogContextMenu();
  if (!image?.sourcePath) return;
  try {
    await navigator.clipboard.writeText(image.sourcePath);
    setStatusKey("status.pathCopied");
  } catch {
    showUserError({ code: "clipboard_write_failed" }, origin);
  }
}

function clearReviewForRemovedImage(image) {
  state.reviewedImageIds.delete(image.id);
  state.hiddenImageIds.delete(image.id);
}
function deletionSelectionSnapshot(imageIds, visibleImages) {
  const pendingImageId = state.pendingImageId;
  const currentImageId = state.currentId;
  return {
    currentImageId,
    pendingImageId,
    visibleImages,
    anchorImageId: imageIds.has(pendingImageId) ? pendingImageId : currentImageId,
    removesSelection: imageIds.has(currentImageId) || imageIds.has(pendingImageId),
  };
}
function invalidatePendingImage() {
  if (!state.pendingImageId) return;
  ++state.imageGeneration;
  state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
  updateActionButtons();
}
async function restoreDeletionSelection(snapshot, imageIds) {
  const availableIds = new Set(state.images.map((image) => image.id));
  const removedIds = new Set([...imageIds].filter((imageId) => !availableIds.has(imageId)));
  const target = snapshot.removesSelection && removedIds.size
    ? nextVisibleImage(snapshot.visibleImages, snapshot.anchorImageId, { excludedImageIds: removedIds, fallback: true })
    : null;
  const imageId = [target?.id, snapshot.pendingImageId, snapshot.currentImageId].find((id) => availableIds.has(id));
  if (!imageId) clearCurrentImageSelection();
  else if (!(state.currentId === imageId && state.currentImage)) await selectImage(imageId, true, { saveCurrentDraft: false });
}
async function preflightBrowserSourceDelete(images) {
  const ready = []; const failed = [];
  for (const image of images) {
    if (image.sourceKind === "filesystem") { ready.push(image); continue; }
    const access = sourceAccessFor(image.id);
    try {
      if (!sourceCanDelete(image)) throw codedError("source_action_unavailable");
      await ensureHandlePermission(access, true);
      const directoryOptions = { mode: "readwrite" };
      let directoryPermission = await access.parentHandle.queryPermission?.(directoryOptions);
      if (directoryPermission !== "granted") directoryPermission = await access.parentHandle.requestPermission?.(directoryOptions);
      if (directoryPermission && directoryPermission !== "granted") throw codedError("source_permission_denied");
      const resolved = await access.parentHandle.getFileHandle(access.fileHandle.name || access.name);
      if (resolved.isSameEntry && !await resolved.isSameEntry(access.fileHandle)) throw codedError("stale_asset");
      const file = await access.fileHandle.getFile();
      if (file.size !== image.sizeBytes || file.lastModified * 1_000_000 !== image.mtimeNs) throw codedError("stale_asset");
      ready.push(image);
    } catch (error) { failed.push({ imageId: image.id, reason: error?.code || "source_delete_failed" }); }
  }
  return { ready, failed };
}

async function deleteBrowserSources(images, onDeleted = null) {
  const deleted = []; const failed = [];
  for (const image of images) {
    if (image.sourceKind === "filesystem") continue;
    try {
      await removeSourceHandle(sourceAccessFor(image.id)); deleted.push(image.id);
      if (onDeleted) { try { await onDeleted(image.id, deleted); } catch { /* The in-flight commit still completes below. */ } }
    }
    catch (error) { failed.push({ imageId: image.id, reason: error?.code || "source_delete_failed" }); }
  }
  return { deleted, failed };
}

async function commitSourceDeleteWithRetry(payload) {
  try { return await catalogApi("/api/catalog/delete-source", payload); }
  catch (error) {
    if (error?.code !== "connection_lost") throw error;
    // The source may already be gone while only the response was lost.  The
    // server keeps this token's receipt, so repeating it is safe.
    return catalogApi("/api/catalog/delete-source", payload);
  }
}

async function resumePendingSourceDeletes() {
  for (const pending of await pendingSourceDeletes()) {
    try {
      const status = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      if (status.state === "prepared" && (pending.browserDeletedImageIds || []).length) {
        await commitSourceDeleteWithRetry({ imageIds: pending.imageIds, deleteToken: pending.deleteToken,
          browserDeletedImageIds: pending.browserDeletedImageIds });
      } else if (status.state === "prepared") {
        await api("/api/catalog/delete-source/cancel", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      }
      const settled = await api("/api/catalog/delete-source/status", { method: "POST", body: JSON.stringify({ deleteToken: pending.deleteToken }), resyncOnStale: false });
      if (settled.state !== "prepared") await forgetPendingSourceDelete(pending.deleteToken);
    } catch { /* Keep the token until the next startup or reconnect. */ }
  }
  await resyncCatalog().catch(() => null);
}

async function permanentlyDeleteImages(images, visibleImages) {
  if (!images.length || isBusy() || state.importing) return;
  const ids = images.map((image) => image.id);
  const title = ids.length === 1 ? t("confirm.removeImage.title") : t("confirm.removeImages.title");
  const message = ids.length === 1 ? t("confirm.removeImage.message") : t("confirm.removeImages.message", { count: ids.length });
  if (!await confirmAction(title, message, "sourceDelete")) return;
  const imageIds = new Set(ids);
  const selection = deletionSelectionSnapshot(imageIds, visibleImages);
  const token = crypto.randomUUID();
  state.catalogMutation = true; invalidatePendingImage(); updateActionButtons();
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    const local = await preflightBrowserSourceDelete(images);
    if (!local.ready.length) throw codedError(local.failed[0]?.reason || "source_action_unavailable");
    const prepared = await catalogApi("/api/catalog/delete-source/prepare", { imageIds: local.ready.map((image) => image.id), deleteToken: token });
    await rememberPendingSourceDelete({ deleteToken: token, imageIds: local.ready.map((image) => image.id), browserDeletedImageIds: [] });
    const preparedIds = new Set(prepared.preparedImageIds || []);
    const preparedImages = local.ready.filter((image) => preparedIds.has(image.id));
    const browser = await deleteBrowserSources(preparedImages, async (_imageId, deleted) => {
      await rememberPendingSourceDelete({ deleteToken: token, imageIds: preparedImages.map((image) => image.id), browserDeletedImageIds: deleted });
    });
    await rememberPendingSourceDelete({ deleteToken: token, imageIds: preparedImages.map((image) => image.id), browserDeletedImageIds: browser.deleted });
    const browserDeleted = new Set(browser.deleted);
    const commitImages = preparedImages.filter((image) => image.sourceKind === "filesystem" || browserDeleted.has(image.id));
    let data = { images: state.images, removedImageIds: [], failed: [] };
    if (commitImages.length) data = await commitSourceDeleteWithRetry({
      imageIds: commitImages.map((image) => image.id), deleteToken: token, browserDeletedImageIds: browser.deleted,
    });
    const removed = new Set(data.removedImageIds || []);
    for (const image of images.filter((item) => removed.has(item.id))) {
      releaseImageCaches(image.id); state.sourceAccess.delete(image.id); state.drafts.delete(image.id); state.maskStatus.delete(image.id); clearReviewForRemovedImage(image);
      state.selectedImageIds.delete(image.id);
    }
    state.images = data.images || state.images;
    if (state.project?.id && removed.size) await forgetProjectImageSources(state.project.id, [...removed]);
    loadReviewedPaths(); pruneSourceAccess();
    if (!state.images.length) { state.batchMode = false; clearBatchSelection(); }
    if (selection.removesSelection) clearCurrentImageSelection();
    renderCatalogViews(); updateSelectionActionBar();
    await restoreDeletionSelection(selection, imageIds);
    const failed = [...local.failed, ...(prepared.failed || []), ...browser.failed, ...(data.failed || [])];
    const failureDetails = failed.map((failure) => `${failure.relativePath || failure.imageId}: ${failure.reason}`).join("、");
    setStatus(`元画像を${removed.size}件削除しました。${failed.length ? `失敗${failed.length}件: ${failureDetails}` : ""}`, failed.length ? "warning" : "success");
    if (failed.length) showUserError(codedError(failed[0].reason));
    if (data.state !== "cleanup_pending") await forgetPendingSourceDelete(token);
  } catch (error) {
    await restoreDeletionSelection(selection, imageIds);
    showUserError(error);
  } finally { state.catalogMutation = false; updateActionButtons(); }
}

async function removeImageFromCatalog(imageId = state.contextMenuImageId) {
  if (!canRemoveCurrentImage() || imageId !== state.currentId) return;
  const image = state.images.find((item) => item.id === imageId);
  if (image) await permanentlyDeleteImages([image], galleryFilteredImages());
}

async function runSelectionAction(action) {
  const images = selectedImages(); if (!images.length || isBusy() || state.importing) return;
  if (catalogStagingEditsActive() && !["hide", "show", "reviewed", "unreviewed"].includes(action)) return;
  closeBatchMoreMenus();
  const ids = images.map((image) => image.id);
  if (["hide", "show", "reviewed", "unreviewed"].includes(action)) {
    const flags = action === "hide" ? { hidden: true } : action === "show" ? { hidden: false }
      : { reviewed: action === "reviewed" };
    const epoch = state.catalogEpoch; state.catalogMutation = true; updateActionButtons();
    try {
      await flushAllImageMutations();
      await flushAllWorkspaceMutations();
      const data = await api("/api/workspace/images", { method: "POST", body: JSON.stringify({ imageIds: ids, ...flags }) });
      if (!isCurrentCatalogEpoch(epoch)) return;
      for (const image of images) publishWorkspaceFlags(image.id, data.flags?.[image.id] || flags);
      preserveCatalogScroll(renderCatalogViews); updateSelectionActionBar(); updateNavigationControls();
    } catch (error) { if (isCurrentCatalogEpoch(epoch)) showUserError(error); }
    finally { state.catalogMutation = false; updateActionButtons(); }
    return;
  }
  if (action === "detect") return openDetectionDialog(images.filter(isProcessableImage).map((image) => image.id));
  if (action === "clear") return clearMasks(images.filter(isProcessableImage).map((image) => image.id), "confirm.clearAllMasks.title", "confirm.clearAllMasks.message");
  if (action === "remove") {
    await permanentlyDeleteImages(images, overviewImages());
  }
}

function droppedFile(file, relativePath = file.name, fileHandle = null, parentHandle = null) {
  return { file, relativePath, fileHandle, parentHandle };
}

async function directFilesFromDrop(dataTransfer) {
  const handles = await Promise.all([...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFileSystemHandle()));
  const entries = [];
  async function collectHandle(handle, parent = "", parentHandle = null) {
    const relativePath = parent ? `${parent}/${handle.name}` : handle.name;
    if (handle.kind === "file") entries.push({ handle, relativePath, parentHandle });
    else for await (const entry of handle.values()) await collectHandle(entry, relativePath, handle);
  }
  for (const handle of handles) if (handle) await collectHandle(handle);
  return { handleEntries: entries };
}

function isSupportedImageFile(file) {
  return /\.(png|jpe?g|webp)$/i.test(file.name);
}

function newClientKey() {
  return crypto.randomUUID();
}

function pruneSourceAccess() {
  const imageIds = new Set(state.images.map((image) => image.id));
  for (const imageId of state.sourceAccess.keys()) if (!imageIds.has(imageId)) state.sourceAccess.delete(imageId);
  for (const [sourceId, source] of state.projectlessDirectorySources) {
    source.imageIds = new Set([...source.imageIds].filter((imageId) => imageIds.has(imageId)));
    if (!source.imageIds.size) state.projectlessDirectorySources.delete(sourceId);
  }
}

async function rememberImportedSource(result, session) {
  for (const imported of result.data.imported || []) {
    if (imported.clientKey !== result.clientKey || !result.entry.fileHandle || !imported.imageId) continue;
    state.sourceAccess.set(imported.imageId, {
      fileHandle: result.entry.fileHandle, parentHandle: result.entry.parentHandle || null,
      name: result.entry.file.name, size: result.entry.file.size, lastModified: result.entry.file.lastModified,
      sourceId: result.sourceId, clientKey: result.clientKey, relativePath: result.entry.relativePath, sourceKind: session.sourceKind,
    });
    if (session.sourceKind === "browser-directory") {
      const source = state.projectlessDirectorySources.get(result.sourceId);
      if (source) source.imageIds.add(imported.imageId);
      continue;
    }
    if (state.project?.id) await rememberProjectSource(state.project.id, result.entry.fileHandle, imported.imageId, result.sourceId, result.clientKey, result.entry.relativePath);
  }
}

async function importFiles(files) {
  const session = arguments.length > 1 ? arguments[1] : beginImportSession();
  if (!session || state.importSession !== session) return false;
  if (session.sourceKind === "browser-files") session.sourceId ||= crypto.randomUUID();
  const supportedFiles = [...files]
    .map((entry) => entry.file || entry.getFile ? entry : { file: entry, relativePath: entry.name, fileHandle: null, parentHandle: null })
    .filter((entry) => isSupportedImageFile(entry.file || { name: entry.name || entry.relativePath }));
  if (!supportedFiles.length) { finishImportSession(session); return true; }
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    session.total = supportedFiles.length; session.completed = 0; session.paused = false; session.cancelled = false;
    showProcessing({ kind: "import", state: "running", total: session.total, completed: 0, current: "" });
    session.requestedParallelism = importParallelism();
    const workerCount = Math.min(supportedFiles.length, session.requestedParallelism);
    session.parallelism = workerCount;
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        while (session.paused && !session.cancelled) await new Promise((resolve) => setTimeout(resolve, 80));
        if (session.cancelled) return;
        const index = nextIndex; nextIndex += 1;
        if (index >= supportedFiles.length) return;
        const descriptor = supportedFiles[index]; const clientKey = descriptor.clientKey || newClientKey();
        let file;
        try { file = descriptor.file || await descriptor.getFile(); }
        catch (error) {
          if (session.catalogId && descriptor.fileHandle && error?.name === "NotFoundError") {
            session.missingFileHandles = true;
            session.completed += 1;
            showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: descriptor.relativePath || descriptor.fileHandle.name });
            continue;
          }
          throw error;
        }
        if (session.cancelled || state.importSession !== session) return;
        if (!isSupportedImageFile(file)) continue;
        const entry = { ...descriptor, file, relativePath: descriptor.relativePath || file.name };
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
        const stagedSource = Boolean(session.catalogId && session.sourceKind === "browser-files" && entry.fileHandle);
        if (stagedSource) await rememberProjectSource(session.catalogId, entry.fileHandle, null, session.sourceId, clientKey, entry.relativePath);
        let data;
        try { data = await importSingleFile(entry, clientKey, session.catalogId, session.sourceId, session.sourceKind, session.importIntent, session); }
        catch (error) {
          if (stagedSource && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
            await forgetPendingProjectSource(session.catalogId, session.sourceId, clientKey);
          }
          throw error;
        }
        if (!session.catalogId && data.catalogId) session.catalogId = data.catalogId;
        const result = { entry, clientKey, data, sourceId: session.sourceId };
        // Keep source access for each committed upload, including a later
        // cancellation or an unrelated upload failure.
        await rememberImportedSource(result, session);
        session.completed += 1;
        showProcessing({ kind: "import", state: "running", total: session.total, completed: session.completed, current: entry.relativePath });
      }
    };
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
    if (!isCurrentCatalogEpoch(session.epoch) || state.importSession !== session) return false;
    if (session.cancelled) { setStatusKey("status.importCancelled", { completed: session.completed }); return false; }
    const capturedProjectId = state.project?.id || null;
    const capturedCatalogGeneration = state.serverCatalogGeneration;
    const latest = await api("/api/images");
    reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration);
    state.images = latest.images;
    loadReviewedPaths();
    if (session.missingFileHandles) showUserError({ code: "project_source_unavailable" });
    pruneSourceAccess(); renderCatalogViews(); setStatusKey("gallery.imported", { count: supportedFiles.length });
    return !session.missingFileHandles;
  } catch (error) {
    session.failed = true;
    try {
      const capturedProjectId = state.project?.id || null;
      const capturedCatalogGeneration = state.serverCatalogGeneration;
      const latest = await api("/api/images");
      reconcileCatalogSnapshot(latest, capturedProjectId, capturedCatalogGeneration);
      if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) { state.images = latest.images; loadReviewedPaths(); renderCatalogViews(); }
    } catch { /* Keep the import failure visible. */ }
    if (isCurrentCatalogEpoch(session.epoch) && state.importSession === session) showUserError(error);
    return false;
  } finally {
    await finishImportServerSession(session);
    finishImportSession(session);
  }
}

async function importSingleFile(entry, clientKey, catalogId = null, sourceId = null, sourceKind = null, importIntent = "add", session = null) {
  const token = document.querySelector('meta[name="mozarie-token"]')?.content || "";
  const response = await fetch("/api/import/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mozarie-Token": token,
      "X-Mozarie-Name": encodeURIComponent(entry.file.name),
      "X-Mozarie-Relative-Path": encodeURIComponent(entry.relativePath),
      "X-Mozarie-Client-Key": encodeURIComponent(clientKey),
      "X-Mozarie-File-Mtime": String(Math.max(0, Number(entry.file.lastModified || 0))),
      "X-Mozarie-File-Size": String(Math.max(0, Number(entry.file.size || 0))),
      ...(sourceId ? { "X-Mozarie-Source-Id": encodeURIComponent(sourceId) } : {}),
      ...(sourceKind ? { "X-Mozarie-Source-Kind": sourceKind } : {}),
      "X-Mozarie-Import-Intent": importIntent,
      "X-Mozarie-Import-Session": session?.id || "",
      "X-Mozarie-Import-Parallelism": String(session?.requestedParallelism || 1),
      "X-Mozarie-Import-Target-Count": String(session?.total || 1),
      ...(catalogId ? { "X-Mozarie-Catalog-Id": encodeURIComponent(catalogId) } : {}),
      "X-Mozarie-Expected-Project-Id": encodeURIComponent(session?.expectedProjectId ?? state.project?.id ?? ""),
      ...(Number.isSafeInteger(session?.expectedCatalogGeneration) ? { "X-Mozarie-Expected-Catalog-Generation": String(session.expectedCatalogGeneration) } : {}),
    },
    body: entry.file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = responseError(response, data);
    await resyncAfterStaleCatalog(error);
    throw error;
  }
  applyCatalogGeneration(data);
  return data;
}

function beginImportSession({ allowDuringCatalogTransition = false } = {}) {
  if (isBusy() || state.importing || (state.catalogTransition && !allowDuringCatalogTransition)) {
    setStatusKey("status.importUnavailable");
    return null;
  }
  const session = { id: newClientKey(), epoch: state.catalogTransition?.epoch || beginCatalogEpoch(), expectedProjectId: state.project?.id || "", expectedCatalogGeneration: state.serverCatalogGeneration, paused: false, cancelled: false, failed: false, completed: 0, total: 0, catalogId: null, sourceId: null, sourceKind: "browser-files", importIntent: "add" };
  state.importing = true; state.importSession = session;
  updateActionButtons();
  return session;
}

async function finishImportServerSession(session) {
  if (!session?.id || !Number.isSafeInteger(session.expectedCatalogGeneration)) return;
  try {
    await api("/api/import/finish", { method: "POST", body: JSON.stringify({
      sessionId: session.id,
      expectedProjectId: session.expectedProjectId,
      expectedCatalogGeneration: session.expectedCatalogGeneration,
      completed: session.completed,
      failed: Boolean(session.failed),
      cancelled: Boolean(session.cancelled),
    }) });
  } catch {
    // The next claimed import expires an abandoned batch after its short TTL.
  }
}

function remapImportedImageIds(imageIds) {
  const map = new Map(Object.entries(imageIds).filter(([from, to]) => from && to && from !== to));
  if (!map.size) return;
  const remapMap = (source) => new Map([...source].map(([id, value]) => [map.get(id) || id, value]));
  state.sourceAccess = remapMap(state.sourceAccess);
  state.drafts = remapMap(state.drafts);
  state.maskStatus = remapMap(state.maskStatus);
  for (const [sourceId, source] of state.projectlessDirectorySources) {
    source.imageIds = new Set([...source.imageIds].map((id) => map.get(id) || id));
    if (!source.imageIds.size) state.projectlessDirectorySources.delete(sourceId);
  }
  state.selectedImageIds = new Set([...state.selectedImageIds].map((id) => map.get(id) || id));
  if (state.currentId) state.currentId = map.get(state.currentId) || state.currentId;
  if (state.pendingImageId) state.pendingImageId = map.get(state.pendingImageId) || state.pendingImageId;
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
  return importFiles(entries.map((entry) => ({
    ...entry, name: entry.handle.name, getFile: () => entry.handle.getFile(), fileHandle: entry.handle,
  })), session);
}

async function importFileHandles(handles, session = beginImportSession()) {
  if (!session) return false;
  session.sourceId ||= crypto.randomUUID();
  session.sourceKind = "browser-files";
  return importHandleEntries(handles.map((item) => {
    const handle = item?.handle || item;
    return { handle, clientKey: item?.clientKey || null, relativePath: item?.relativePath || handle.name, parentHandle: null };
  }), session);
}

async function importDirectoryHandle(directoryHandle, session = beginImportSession()) {
  if (!session) return;
  await flushAllImageMutations();
  await flushAllWorkspaceMutations();
  session.catalogId = await catalogForDirectoryHandle(directoryHandle);
  session.sourceId = await rememberProjectSource(session.catalogId, directoryHandle, null, state.pendingDirectorySourceId || session.sourceId);
  session.sourceKind = "browser-directory";
  state.pendingDirectorySourceId = null;
  const projectlessSource = !session.catalogId
    ? { handle: directoryHandle, imageIds: new Set() }
    : null;
  if (projectlessSource) state.projectlessDirectorySources.set(session.sourceId, projectlessSource);
  const entries = [];
  try {
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
  finally {
    if (projectlessSource && !projectlessSource.imageIds.size) state.projectlessDirectorySources.delete(session.sourceId);
  }
}

async function importProjectDirectoryHandle(directoryHandle, projectId, sourceId = null, importIntent = "add") {
  const session = beginImportSession({ allowDuringCatalogTransition: true }); if (!session) return;
  try {
    await flushAllImageMutations();
    await flushAllWorkspaceMutations();
    session.catalogId = projectId;
    session.sourceId = await rememberProjectSource(projectId, directoryHandle, null, sourceId);
    session.sourceKind = "browser-directory";
    session.importIntent = importIntent;
    const entries = [];
    showProcessing({ kind: "import", state: "running", total: 1, completed: 0, current: directoryHandle.name || "" });
    async function collect(handle, relativePath = "", parentHandle = null) {
      if (!await waitForImportSession(session)) return;
      const path = relativePath ? `${relativePath}/${handle.name}` : handle.name;
      if (handle.kind === "file") entries.push({ handle, relativePath: path, parentHandle });
      else for await (const child of handle.values()) await collect(child, path, handle);
    }
    for await (const handle of directoryHandle.values()) await collect(handle, "", directoryHandle);
    if (await waitForImportSession(session) && !await importHandleEntries(entries, session)) throw codedError("project_source_unavailable");
  } finally { finishImportSession(session); }
}

async function importProjectFileHandles(sources, projectId) {
  // File handles are stored one row per image.  Restore them in their original
  // source groups so their durable image IDs, masks, and history are reused.
  const groups = new Map();
  for (const source of sources) {
    const handle = source?.handle || source;
    if (!handle) continue;
    const sourceId = source?.sourceId || crypto.randomUUID();
    const handles = groups.get(sourceId) || [];
    handles.push({ handle, clientKey: source?.clientKey || null, relativePath: source?.relativePath || handle.name }); groups.set(sourceId, handles);
  }
  const failures = [];
  for (const [sourceId, handles] of groups) {
    const session = beginImportSession({ allowDuringCatalogTransition: true }); if (!session) return failures;
    try {
      await flushAllWorkspaceMutations();
      session.catalogId = projectId;
      session.sourceId = sourceId;
      session.sourceKind = "browser-files";
      session.importIntent = "restore";
      if (!await importFileHandles(handles, session)) failures.push(...handles);
    } catch (error) { failures.push(...handles); }
    finally { finishImportSession(session); }
  }
  return failures;
}

async function pickImageFiles() {
  $("#pickerMenu").hidePopover();
  const session = beginImportSession(); if (!session) return;
  try { await importFileHandles(await window.showOpenFilePicker({ multiple: true, types: [{ description: "Images", accept: { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"] } }] }), session); }
  catch (error) { if (error?.name !== "AbortError") showUserError(error); finishImportSession(session); }
}

async function pickImageDirectory() {
  $("#pickerMenu").hidePopover();
  const session = beginImportSession(); if (!session) return;
  try { await importDirectoryHandle(await window.showDirectoryPicker({ mode: "read", id: "mozarie-source" }), session); }
  catch (error) {
    if (error?.name === "AbortError") setStatusKey("status.folderPickerCancelled");
    else { setStatusKey("status.folderPickerFailed"); showUserError(error); }
  } finally { finishImportSession(session); }
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
  } catch (error) { showUserError(error); }
  finally { finishImportSession(session); setGalleryDropOverlay(false); }
}

function setGalleryDropOverlay(visible) {
  $("#galleryDropOverlay").hidden = !visible;
}

function handleEditorKeydown(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || isTextEditableTarget(document.activeElement) || hasOpenDialog()) return false;
  if (state.viewMode !== "edit") return false;
  const binding = shortcutFromEvent(event);
  const shortcuts = state.settings?.shortcuts?.bindings || { undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const enabled = state.settings?.shortcuts?.actions || {};
  if (!currentImageActionPending() && !state.projectReadOnly && currentRecord() && !currentRecord()?.sourceDimensionsChanged
    && ((binding === shortcuts.undo && enabled.undo !== false) || (binding === shortcuts.redo && enabled.redo !== false))) {
    event.preventDefault();
    if (hasDurableHistory()) void restoreProjectHistory(binding === shortcuts.redo ? "redo" : "undo");
    else void restoreSnapshot(binding === shortcuts.redo ? state.historyIndex + 1 : state.historyIndex - 1);
    return true;
  }
  return false;
}

function navigationShortcutAction(event) {
  if (isBusy() || state.importing || isGestureActive() || !state.navigationShortcutsEnabled || hasOpenDialog()) return null;
  const binding = shortcutFromEvent(event);
  const bindings = state.settings?.shortcuts?.bindings || { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", reviewAndNext: "Enter", removeImage: "Delete", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" };
  const actionForBinding = Object.entries(bindings).find(([, value]) => value === binding)?.[0];
  if (!actionForBinding || state.settings?.shortcuts?.actions?.[actionForBinding] === false) return null;
  const currentGalleryItem = document.activeElement?.matches("button.gallery-item.current") && document.activeElement.dataset.id === state.currentId;
  if (isEditableTarget(document.activeElement) && !(actionForBinding === "removeImage" && currentGalleryItem)) return null;
  if (actionForBinding === "toggleOverview") return "toggleOverview";
  if (state.viewMode !== "edit") return null;
  if (actionForBinding === "removeImage" && event.repeat) return "removeImageRepeat";
  if (actionForBinding === "removeImage" && !canRemoveCurrentImage()) return null;
  if ((currentImageActionPending() || state.projectReadOnly || currentRecord()?.sourceDimensionsChanged
    || (!currentRecord() && ["undo", "redo"].includes(actionForBinding)))
    && ["reviewAndNext", "undo", "redo"].includes(actionForBinding)) return null;
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
  else if (action === "first" && galleryFilteredImages()[0]) void selectImage(galleryFilteredImages()[0].id);
  else if (action === "last" && galleryFilteredImages().at(-1)) void selectImage(galleryFilteredImages().at(-1).id);
  else if (action === "reviewAndNext") void reviewAndMoveNext();
  else if (action === "removeImage") void removeImageFromCatalog(state.currentId);
  else if (action === "undo") { if (hasDurableHistory()) void restoreProjectHistory("undo"); else void restoreSnapshot(state.historyIndex - 1); }
  else if (action === "redo") { if (hasDurableHistory()) void restoreProjectHistory("redo"); else void restoreSnapshot(state.historyIndex + 1); }
  return true;
}

function handleWindowKeydown(event) {
  if (handleEditorKeydown(event)) return;
  handleNavigationKeydown(event);
}
