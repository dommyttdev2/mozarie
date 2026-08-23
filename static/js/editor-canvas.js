function canvasSizeForImage(image) {
  for (const target of [addCanvas, exclusionCanvas, combinedCanvas, mosaicCanvas]) { target.width = image.width; target.height = image.height; }
  addCtx.clearRect(0, 0, image.width, image.height);
  exclusionCtx.clearRect(0, 0, image.width, image.height);
  state.maskDirty = true;
  state.manualMaskPresent = false;
  state.manualEnabled = true;
}

function clearEditor() {
  closeBoundaryModeMenu({ restoreFocus: true });
  cancelFillWork();
  state.history = []; state.historyIndex = 0; state.activeStroke = null; state.hover = null; clearBoundaryInteraction();
  state.manualMaskPresent = false; state.manualEnabled = true;
  state.maskDirty = false;
  addCanvas.width = exclusionCanvas.width = combinedCanvas.width = mosaicCanvas.width = historyAddCanvas.width = historyExclusionCanvas.width = 1;
  addCanvas.height = exclusionCanvas.height = combinedCanvas.height = mosaicCanvas.height = historyAddCanvas.height = historyExclusionCanvas.height = 1;
  $("#emptyState").hidden = false;
  $("#currentFileName").textContent = t("editor.none");
  $("#candidateStatus").textContent = t("candidates.unselected");
  renderCandidates(); updateHistoryButtons(); updateNavigationControls(); updateActionButtons(); render();
}

async function selectImage(imageId, force = false, { saveCurrentDraft = true } = {}) {
  if ((isBusy() || state.importing || isGestureActive() || state.candidateBatchPending.size) && !force) return;
  if (state.currentId === imageId && !force && state.pendingImageId !== imageId) return;
  if (saveCurrentDraft) saveDraft();
  cancelFillWork();
  abortCatalogLoads();
  const generation = ++state.imageGeneration;
  state.pendingImageId = imageId;
  closeBoundaryModeMenu();
  clearBoundaryInteraction();
  updateActionButtons();
  const record = state.images.find((image) => image.id === imageId);
  if (!record) {
    state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
    updateActionButtons();
    return;
  }
  state.pendingImageKey = imageCacheKey(record);
  state.pendingCandidateKey = candidateCacheKey(imageId, Number(record.candidateRevision || 0));
  const imageCached = state.imageCache.has(imageCacheKey(record));
  const candidatesCached = state.candidateBundleCache.has(candidateCacheKey(imageId, Number(record.candidateRevision || 0)));
  if (!imageCached || !candidatesCached) {
    clearTimeout(state.loadingDelay);
    state.loadingDelay = setTimeout(() => {
      if (state.pendingImageId === imageId && isCurrentGeneration(generation)) setStatusKey("status.loadingImages", {}, "running");
    }, 150);
  }
  try {
    const [image, candidateBundle] = await Promise.all([
      cachedImage(record),
      loadCandidateBundle(imageId, generation),
    ]);
    clearTimeout(state.loadingDelay); state.loadingDelay = null;
    syncCandidateRecord(imageId, candidateBundle.candidates);
    if (!isCurrentGeneration(generation)) return;
    releaseStaleImageVersions(imageId, imageCacheKey(record), candidateCacheKey(imageId, candidateBundle.candidateRevision));
    state.currentId = imageId;
    state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
    state.currentImage = image;
    state.candidates = candidateBundle.candidates;
    state.candidateImages = candidateBundle.candidateImages;
    state.imageCache.trim(); state.candidateBundleCache.trim();
    canvasSizeForImage(record); restoreDraft(imageId, generation); rebuildMosaicPreview(); fitImage();
    updateBlockSizeDisplay(); refreshMaskStatus();
    $("#emptyState").hidden = true;
    $("#currentFileName").textContent = record.relativePath;
    updateCandidateStatus();
    renderCandidates(); updateGalleryCurrent(); updateNavigationControls(); updateActionButtons(); render(); clearStatus();
    state.galleryNodes.get(imageId)?.scrollIntoView?.({ block: "nearest" });
    state.overviewNodes.get(imageId)?.scrollIntoView?.({ block: "nearest" });
    prefetchNeighbors(record);
  } catch (error) {
    if (isCurrentGeneration(generation)) {
      clearTimeout(state.loadingDelay); state.loadingDelay = null;
      state.pendingImageId = null; state.pendingImageKey = null; state.pendingCandidateKey = null;
      if (error.code === "stale_asset") invalidateStaleAsset(imageId);
      setStatus(error.message, "error");
    }
  }
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(t("error.imageLoad"))); image.src = source;
  });
}

function imageAssetVersion(record) { return typeof record?.assetVersion === "string" ? record.assetVersion : ""; }
function invalidateStaleAsset(imageId) {
  abortCatalogLoads();
  const bitmaps = new Set();
  for (const [key] of [...state.imageCache.items]) if (key.startsWith(`${imageId}:`)) bitmaps.add(state.imageCache.take(key));
  for (const [key] of [...state.candidateBundleCache.items]) {
    if (!key.startsWith(`${imageId}:`)) continue;
    for (const bitmap of state.candidateBundleCache.take(key)?.candidateImages?.values() || []) bitmaps.add(bitmap);
  }
  const gallery = state.galleryNodes.get(imageId)?.querySelector("img");
  const overview = state.overviewNodes.get(imageId)?.querySelector("img");
  forgetThumbnail(gallery); forgetThumbnail(overview);
  if (state.currentId === imageId) {
    bitmaps.add(state.currentImage);
    for (const bitmap of state.candidateImages.values()) bitmaps.add(bitmap);
  }
  for (const bitmap of bitmaps) closeBitmap(bitmap);
  if (state.currentId !== imageId) return;
  closeBoundaryModeMenu({ restoreFocus: true });
  state.currentId = null; state.currentImage = null; state.candidates = []; state.candidateImages = new Map();
  clearEditor(); updateGalleryCurrent();
}
function imageCacheKey(record) { return `${record.id}:${imageAssetVersion(record)}`; }
function candidateCacheKey(imageId, revision) { return `${imageId}:${revision}`; }

async function cachedImage(record) {
  const key = imageCacheKey(record);
  const epoch = state.catalogEpoch; const version = imageAssetVersion(record);
  const cached = state.imageCache.get(key);
  if (cached) return cached;
  const pending = state.imageInflight.get(key);
  if (pending) return pending;
  const controller = new AbortController(); state.catalogLoadControllers.add(controller);
  let request;
  request = fetchBitmap(imageUrl(record), controller.signal).then((image) => {
    if (controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) { image.close?.(); throw new DOMException("stale catalog", "AbortError"); }
    return state.imageCache.set(key, image, decodedImageWeight(image));
  }).finally(() => { if (state.imageInflight.get(key) === request) state.imageInflight.delete(key); });
  request.finally(() => state.catalogLoadControllers.delete(controller)).catch(() => {});
  state.imageInflight.set(key, request);
  return request;
}

function prefetchNeighbors(record) {
  const index = state.images.findIndex((item) => item.id === record.id);
  for (const neighbor of [state.images[index - 1], state.images[index + 1]]) {
    if (!neighbor) continue;
    schedulePrefetch(neighbor, 1);
  }
}

function releaseImageCaches(imageId = null) {
  const matches = (key) => !imageId || key.startsWith(`${imageId}:`);
  for (const [key] of state.imageCache.items) {
    if (!matches(key)) continue;
    state.imageCache.delete(key);
  }
  for (const [key] of state.candidateBundleCache.items) {
    if (!matches(key)) continue;
    state.candidateBundleCache.delete(key);
  }
  for (const key of state.imageInflight.keys()) if (matches(key)) state.imageInflight.delete(key);
  for (const key of state.candidateInflight.keys()) if (matches(key)) state.candidateInflight.delete(key);
}

function releaseStaleImageVersions(imageId, imageKey, candidateKey) {
  for (const [key] of state.imageCache.items) if (key.startsWith(`${imageId}:`) && key !== imageKey) state.imageCache.delete(key);
  for (const [key] of state.candidateBundleCache.items) if (key.startsWith(`${imageId}:`) && key !== candidateKey) state.candidateBundleCache.delete(key);
}

function releaseCandidateBundles(imageId) {
  for (const [key] of state.candidateBundleCache.items) if (key.startsWith(`${imageId}:`)) state.candidateBundleCache.delete(key);
  if (state.currentId === imageId) state.candidateImages = new Map();
}

function releaseCandidateBitmap(candidateId) {
  const image = state.candidateImages.get(candidateId);
  if (image) closeBitmap(image);
  state.candidateImages.delete(candidateId);
}

function invalidateCandidateBundles(imageId) {
  for (const [key, entry] of state.candidateBundleCache.items) {
    const bundle = entry.value;
    if (!key.startsWith(`${imageId}:`)) continue;
    if (bundle.candidateImages === state.candidateImages) continue;
    state.candidateBundleCache.delete(key);
  }
}

function retainCurrentCandidateBundle(imageId, revision) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  if (state.currentId !== imageId) { record.candidateRevision = Number(revision || 0); return; }
  const oldKey = candidateCacheKey(imageId, Number(record.candidateRevision || 0));
  const reusable = state.candidateBundleCache.take(oldKey);
  record.candidateRevision = Number(revision || 0);
  if (!reusable) return;
  reusable.candidates = state.candidates;
  reusable.candidateImages = state.candidateImages;
  reusable.candidateRevision = record.candidateRevision;
  state.candidateBundleCache.set(candidateCacheKey(imageId, record.candidateRevision), reusable, [...reusable.candidateImages.values()].reduce((total, image) => total + decodedImageWeight(image), 0));
}

async function loadCandidateBundle(imageId, generation, reconciled = false) {
  const record = state.images.find((image) => image.id === imageId);
  const epoch = state.catalogEpoch;
  const version = imageAssetVersion(record);
  const knownRevision = Number(record?.candidateRevision || 0);
  const knownKey = candidateCacheKey(imageId, knownRevision);
  const pending = state.candidateInflight.get(knownKey);
  if (pending) return pending;
  let request;
  request = (async () => {
    const controller = new AbortController(); state.catalogLoadControllers.add(controller);
    let candidateImages;
    try {
      const candidateData = await api(`/api/candidates/${encodeURIComponent(imageId)}`, { signal: controller.signal });
      if (!Array.isArray(candidateData.candidates) || !candidateData.candidates.every((candidate) => typeof candidate?.id === "string") || !Number.isInteger(candidateData.candidateRevision)
        || controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) throw new DOMException("stale catalog", "AbortError");
      const revision = Number(candidateData.candidateRevision);
      const cacheKey = candidateCacheKey(imageId, revision);
      if (state.pendingImageId === imageId) state.pendingCandidateKey = cacheKey;
      const cached = state.candidateBundleCache.get(cacheKey);
      if (cached) { record.candidateRevision = revision; return cached; }
      candidateImages = new Map();
      const pendingCandidates = [...candidateData.candidates];
      const workers = Array.from({ length: Math.min(4, pendingCandidates.length) }, async () => {
        while (pendingCandidates.length) {
          const candidate = pendingCandidates.shift();
          try { candidateImages.set(candidate.id, await fetchBitmap(maskUrl(imageId, candidate.id, revision), controller.signal)); }
          catch (error) { controller.abort(); throw error; }
        }
      });
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      if (controller.signal.aborted || !catalogRecordMatches(record, epoch, { version })) throw new DOMException("stale catalog", "AbortError");
      record.candidateRevision = revision;
      const bundle = { candidates: candidateData.candidates, candidateImages, candidateRevision: revision };
      const weight = [...candidateImages.values()].reduce((total, image) => total + decodedImageWeight(image), 0);
      candidateImages = null;
      return state.candidateBundleCache.set(cacheKey, bundle, weight);
    } catch (error) {
      if (candidateImages) releaseCandidateBitmapBundle({ candidateImages });
      if (error.status === 404 && !reconciled && isCurrentGeneration(generation)) {
        state.candidateInflight.delete(knownKey);
        return loadCandidateBundle(imageId, generation, true);
      }
      throw error;
    } finally { state.catalogLoadControllers.delete(controller); }
  })().finally(() => {
    if (state.candidateInflight.get(knownKey) === request) state.candidateInflight.delete(knownKey);
    state.imageCache.trim(); state.candidateBundleCache.trim();
  });
  state.candidateInflight.set(knownKey, request);
  return request;
}

async function reconcileCurrentCandidates(imageId, generation) {
  const bundle = await loadCandidateBundle(imageId, generation);
  if (state.currentId !== imageId || !isCurrentGeneration(generation)) return false;
  state.candidates = bundle.candidates;
  state.candidateImages = bundle.candidateImages;
  const record = state.images.find((image) => image.id === imageId);
  if (record) {
    record.candidateCount = bundle.candidates.length;
    record.enabledCandidateCount = bundle.candidates.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
    record.candidateRevision = bundle.candidateRevision;
  }
  invalidateCandidateBundles(imageId);
  refreshMaskStatus(true); updateCandidateStatus(); renderCandidates(); render();
  return true;
}


function canvasHasPixels(context, target) {
  const pixels = context.getImageData(0, 0, target.width, target.height).data;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) return true;
  return false;
}

function syncCandidateRecord(imageId, candidates) {
  const record = state.images.find((image) => image.id === imageId);
  if (!record) return;
  record.candidateCount = candidates.length;
  record.enabledCandidateCount = candidates.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
}

function syncCurrentCandidateRecord() { syncCandidateRecord(state.currentId, state.candidates); }

function syncStoredMaskStatus(imageId, candidates) {
  const draft = state.drafts.get(imageId);
  if (!Array.isArray(draft?.visibleCandidateIds)) return;
  const visibleCandidateIds = new Set(draft.visibleCandidateIds);
  const hasVisibleCandidate = candidates.some((candidate) => candidate.enabled && visibleCandidateIds.has(candidate.id));
  const hasManualMask = Boolean(draft.manualVisible && draft.manualEnabled !== false);
  state.maskStatus.set(imageId, hasVisibleCandidate || hasManualMask);
}

async function refreshCandidateRecord(imageId, syncMask = false) {
  const data = await api(`/api/candidates/${encodeURIComponent(imageId)}`);
  syncCandidateRecord(imageId, data.candidates);
  if (syncMask) syncStoredMaskStatus(imageId, data.candidates);
  return data.candidates;
}

function updateCandidateStatus() {
  const status = $("#candidateStatus");
  if (!state.currentId) { status.textContent = t("candidates.unselected"); return; }
  if (state.manualMaskPresent) {
    status.textContent = state.candidates.length
      ? t("candidates.countWithManual", { count: state.candidates.length })
      : t("candidates.manualOnly");
    return;
  }
  status.textContent = state.candidates.length ? t("candidates.count", { count: state.candidates.length }) : t("candidates.none");
}

function saveDraft() {
  if (!state.currentId || !state.currentImage) return;
  flushMaskComposition();
  const hasAdd = canvasHasPixels(addCtx, addCanvas);
  const hasExclusion = canvasHasPixels(exclusionCtx, exclusionCanvas);
  const defaultManualExclusionForced = state.settings?.detection?.exclude_forced_default !== false;
  if (!hasAdd && !hasExclusion && state.manualExclusionForced === defaultManualExclusionForced) {
    state.drafts.delete(state.currentId);
    return;
  }
  const visibility = captureCurrentMaskVisibility();
  state.drafts.set(state.currentId, {
    add: hasAdd ? addCanvas.toDataURL("image/png") : "",
    exclusion: hasExclusion ? exclusionCanvas.toDataURL("image/png") : "",
    manualEnabled: state.manualEnabled, manualExclusionEnabled: state.manualExclusionEnabled, manualMaskPresent: state.manualMaskPresent,
    manualExclusionForced: state.manualExclusionForced,
    visibleCandidateIds: visibility.candidateIds, manualVisible: visibility.manual,
  });
}

function restoreDraft(imageId, generation) {
  const draft = state.drafts.get(imageId);
  state.history = []; state.historyIndex = 0; state.activeStroke = null;
  state.manualEnabled = draft?.manualEnabled !== false;
  state.manualExclusionEnabled = draft?.manualExclusionEnabled !== false;
  state.manualExclusionForced = draft?.manualExclusionForced ?? draft?.forceExclusion ?? (state.settings?.detection?.exclude_forced_default !== false);
  state.manualMaskPresent = false;
  if (!draft) { resetHistoryToCurrentManualMask(); updateCandidateStatus(); renderCandidates(); return; }
  const addImagePromise = draft.add ? loadImage(draft.add) : Promise.resolve(null);
  const exclusionImagePromise = draft.exclusion ? loadImage(draft.exclusion) : Promise.resolve(null);
  const restoreToken = ++state.historyRestoreToken;
  Promise.all([addImagePromise, exclusionImagePromise]).then(([addImage, exclusionImage]) => {
    if (state.currentId !== imageId || state.imageGeneration !== generation || state.historyRestoreToken !== restoreToken) return;
    if (addImage) addCtx.drawImage(addImage, 0, 0);
    if (exclusionImage) exclusionCtx.drawImage(exclusionImage, 0, 0);
    state.manualMaskPresent = draft.manualMaskPresent ?? canvasHasPixels(addCtx, addCanvas);
    resetHistoryToCurrentManualMask();
    refreshMaskStatus(true); updateCandidateStatus(); renderCandidates(); render();
  });
}

function fitImage() {
  if (!state.currentImage) return;
  const inset = { left: 76, right: 20, top: 58, bottom: 62 };
  const width = Math.max(1, stage.clientWidth - inset.left - inset.right);
  const height = Math.max(1, stage.clientHeight - inset.top - inset.bottom);
  state.view.scale = Math.min(width / state.currentImage.width, height / state.currentImage.height);
  state.view.x = inset.left + (width - state.currentImage.width * state.view.scale) / 2;
  state.view.y = inset.top + (height - state.currentImage.height * state.view.scale) / 2;
  render();
}

function resizeRenderCanvas() {
  const width = stage.clientWidth; const height = stage.clientHeight; const dpr = window.devicePixelRatio || 1;
  if (renderedWidth === width && renderedHeight === height && canvas.width === Math.round(width * dpr)) return;
  renderedWidth = width; renderedHeight = height;
  canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
  layerCanvas.width = canvas.width; layerCanvas.height = canvas.height;
  boundaryOverlayCanvas.width = canvas.width; boundaryOverlayCanvas.height = canvas.height;
  render();
}

function setCssTransform(context) { const dpr = window.devicePixelRatio || 1; context.setTransform(dpr, 0, 0, dpr, 0, 0); }

function rebuildMosaicPreview() {
  if (!state.currentImage) return;
  originalCanvas.width = state.currentImage.width; originalCanvas.height = state.currentImage.height;
  originalCtx.clearRect(0, 0, originalCanvas.width, originalCanvas.height); originalCtx.drawImage(state.currentImage, 0, 0);
  const blockSize = calculatedBlockSize();
  mosaicSourceCanvas.width = Math.max(1, Math.ceil(state.currentImage.width / blockSize));
  mosaicSourceCanvas.height = Math.max(1, Math.ceil(state.currentImage.height / blockSize));
  mosaicSourceCtx.imageSmoothingEnabled = true;
  mosaicSourceCtx.clearRect(0, 0, mosaicSourceCanvas.width, mosaicSourceCanvas.height);
  mosaicSourceCtx.drawImage(state.currentImage, 0, 0, mosaicSourceCanvas.width, mosaicSourceCanvas.height);
  mosaicCtx.imageSmoothingEnabled = false;
  mosaicCtx.clearRect(0, 0, mosaicCanvas.width, mosaicCanvas.height);
  mosaicCtx.drawImage(mosaicSourceCanvas, 0, 0, mosaicCanvas.width, mosaicCanvas.height);
}

function composeCurrentMask() {
  if (!state.currentImage) return;
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) if (candidate.enabled && candidate.role === "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) if (candidate.enabled && candidate.role === "exclude" && candidate.forced) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  if (state.manualExclusionEnabled && state.manualExclusionForced) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  state.maskDirty = false;
}
function markMaskDirty() { state.maskDirty = true; }
function flushMaskComposition() { if (state.maskDirty) composeCurrentMask(); }

function sourceVisibleAfterExclusion(source) {
  combinedCtx.globalCompositeOperation = "source-over";
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  combinedCtx.drawImage(source, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) if (candidate.enabled && candidate.role === "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  return canvasHasPixels(combinedCtx, combinedCanvas);
}

function captureCurrentMaskVisibility() {
  const candidateIds = state.candidates
    .filter((candidate) => candidate.role !== "exclude")
    .filter((candidate) => {
      const image = state.candidateImages.get(candidate.id);
      return image && sourceVisibleAfterExclusion(image);
    })
    .map((candidate) => candidate.id);
  const manual = state.manualMaskPresent && sourceVisibleAfterExclusion(addCanvas);
  markMaskDirty(); flushMaskComposition();
  return { candidateIds, manual };
}

function maskStatusWithoutCandidate(candidateId) {
  combinedCtx.clearRect(0, 0, combinedCanvas.width, combinedCanvas.height);
  for (const candidate of state.candidates) {
    if (candidate.id !== candidateId && candidate.enabled && candidate.role !== "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  }
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) if (candidate.id !== candidateId && candidate.enabled && candidate.role === "exclude") combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  if (state.manualExclusionEnabled) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  if (state.manualEnabled) combinedCtx.drawImage(addCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "destination-out";
  for (const candidate of state.candidates) if (candidate.id !== candidateId && candidate.enabled && candidate.role === "exclude" && candidate.forced) combinedCtx.drawImage(state.candidateImages.get(candidate.id), 0, 0);
  if (state.manualExclusionEnabled && state.manualExclusionForced) combinedCtx.drawImage(exclusionCanvas, 0, 0);
  combinedCtx.globalCompositeOperation = "source-over";
  const hasMask = canvasHasPixels(combinedCtx, combinedCanvas);
  markMaskDirty(); flushMaskComposition();
  return hasMask;
}

function refreshMaskStatus(renderGalleryAfter = false) {
  if (!state.currentId || !state.currentImage) return;
  const record = currentRecord();
  const previous = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : Boolean(record && Number(record.enabledCandidateCount || 0) > 0);
  markMaskDirty(); flushMaskComposition();
  const current = canvasHasPixels(combinedCtx, combinedCanvas);
  state.maskStatus.set(state.currentId, current);
  if (renderGalleryAfter && previous !== current) renderCatalogViews();
  else updateActionButtons();
  return previous !== current;
}

function paintMosaicPreview() {
  if (!state.currentImage) return;
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(layerCtx); layerCtx.clearRect(0, 0, width, height);
  layerCtx.save(); layerCtx.translate(state.view.x, state.view.y); layerCtx.scale(state.view.scale, state.view.scale);
  layerCtx.drawImage(mosaicCanvas, 0, 0);
  layerCtx.globalCompositeOperation = "destination-in";
  layerCtx.drawImage(combinedCanvas, 0, 0);
  layerCtx.restore(); setCssTransform(ctx); ctx.drawImage(layerCanvas, 0, 0, width, height);
}

function drawBrushCursor() {
  if (!state.hover || !state.currentImage || !["brush", "eraser", "boundary_brush"].includes(state.tool)) return;
  const radius = Math.max(1, Number($("#brushSize").value) * state.view.scale / 2);
  const x = state.view.x + state.hover.x * state.view.scale;
  const y = state.view.y + state.hover.y * state.view.scale;
  ctx.save();
  if (state.tool === "eraser") ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = state.tool === "boundary_brush" ? "#50d589" : "#ffffff"; ctx.lineWidth = 3; ctx.stroke();
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.strokeStyle = "#111316"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function roiFromPoints(start, end) {
  const left = Math.floor(Math.min(start.x, end.x)); const top = Math.floor(Math.min(start.y, end.y));
  const right = Math.ceil(Math.max(start.x, end.x)); const bottom = Math.ceil(Math.max(start.y, end.y));
  return right - left >= 2 && bottom - top >= 2 ? { left, top, right, bottom } : null;
}

function boundaryDraftRoi() {
  return state.boundaryDragging && state.boundaryStart && state.boundaryPoint
    ? roiFromPoints(state.boundaryStart, state.boundaryPoint)
    : state.boundaryRoi;
}

function boundaryDraftId() { state.boundaryDraftSequence += 1; return `boundary-${state.boundaryDraftSequence}`; }
function pointForRoi(roi) { return { x: Math.round((roi.left + roi.right) / 2), y: Math.round((roi.top + roi.bottom) / 2) }; }

function polygonRoi(points) {
  if (!points.length) return null;
  return {
    left: Math.floor(Math.min(...points.map((point) => point.x))), right: Math.ceil(Math.max(...points.map((point) => point.x))),
    top: Math.floor(Math.min(...points.map((point) => point.y))), bottom: Math.ceil(Math.max(...points.map((point) => point.y))),
  };
}

function boundaryDraftBounds(draft) { return draft?.roi || polygonRoi(draft?.points || []); }

function addBoundaryDraft(draft) {
  const item = { id: boundaryDraftId(), ...draft };
  state.boundaryDrafts.push(item);
  state.boundaryActiveId = item.id;
  return item;
}

function activeBoundaryShape() {
  const rectangle = boundaryDraftRoi();
  if (rectangle) return { type: "rectangle", roi: rectangle, point: state.boundaryPromptPoint || pointForRoi(rectangle), transient: true };
  if (state.polygonPoints.length) return { type: "polygon", points: state.polygonPoints, transient: true };
  if (state.boundaryBrushStroke) return { ...state.boundaryBrushStroke, transient: true };
  return null;
}

function boundaryShapes() { return [...state.boundaryDrafts, ...[activeBoundaryShape()].filter(Boolean)]; }

function strokeRoi(points, radius) {
  if (!points.length) return null;
  const padding = Math.max(1, radius / 2);
  const image = state.currentImage;
  const clampX = (value) => Math.max(0, Math.min(image.width, value));
  const clampY = (value) => Math.max(0, Math.min(image.height, value));
  const roi = {
    left: Math.floor(clampX(Math.min(...points.map((point) => point.x)) - padding)),
    top: Math.floor(clampY(Math.min(...points.map((point) => point.y)) - padding)),
    right: Math.ceil(clampX(Math.max(...points.map((point) => point.x)) + padding)),
    bottom: Math.ceil(clampY(Math.max(...points.map((point) => point.y)) + padding)),
  };
  return roiFromPoints({ x: roi.left, y: roi.top }, { x: roi.right, y: roi.bottom });
}

function appendBoundaryBrushPoint(point) {
  const stroke = state.boundaryBrushStroke;
  if (!stroke) return;
  const previous = stroke.points.at(-1);
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) >= 0.5) stroke.points.push(point);
  stroke.roi = strokeRoi(stroke.points, stroke.radius);
}

function beginBoundaryBrushStroke(point) {
  state.boundaryBrushStroke = { type: "brush", points: [point], radius: Math.max(1, Number($("#brushSize").value)), roi: null };
  state.boundaryBrushStroke.roi = strokeRoi(state.boundaryBrushStroke.points, state.boundaryBrushStroke.radius);
}

function completeBoundaryBrushStroke() {
  const stroke = state.boundaryBrushStroke;
  state.boundaryBrushStroke = null;
  if (!stroke?.roi) return;
  addBoundaryDraft({ type: "brush", points: stroke.points.map((point) => ({ ...point })), radius: stroke.radius, roi: stroke.roi, point: pointForRoi(stroke.roi) });
  setStatusKey("status.boundaryReady");
}

function rectsTouch(first, second) {
  return first.left <= second.right + 1 && first.right + 1 >= second.left
    && first.top <= second.bottom + 1 && first.bottom + 1 >= second.top;
}

function joinRois(rois) {
  return {
    left: Math.min(...rois.map((roi) => roi.left)), right: Math.max(...rois.map((roi) => roi.right)),
    top: Math.min(...rois.map((roi) => roi.top)), bottom: Math.max(...rois.map((roi) => roi.bottom)),
  };
}

function boundaryRequests() {
  const requests = [];
  const brushGroups = [];
  state.boundaryDrafts.forEach((draft, index) => {
    if (draft.type !== "brush") {
      if (draft.type === "polygon" && !polygonPointsValid(draft.points || [])) return;
      requests.push({ firstIndex: index, draftIds: [draft.id], draft });
      return;
    }
    if (!draft.roi) return;
    let group = brushGroups.find((item) => rectsTouch(item.roi, draft.roi));
    if (!group) { brushGroups.push({ drafts: [draft], roi: { ...draft.roi }, firstIndex: index }); return; }
    group.drafts.push(draft); group.roi = joinRois(group.drafts.map((item) => item.roi));
    group.firstIndex = Math.min(group.firstIndex, index);
    for (let index = brushGroups.length - 1; index >= 0; index -= 1) {
      const other = brushGroups[index];
      if (other === group || !rectsTouch(group.roi, other.roi)) continue;
      group.drafts.push(...other.drafts); group.roi = joinRois(group.drafts.map((item) => item.roi)); group.firstIndex = Math.min(group.firstIndex, other.firstIndex); brushGroups.splice(index, 1);
    }
  });
  for (const group of brushGroups) requests.push({ firstIndex: group.firstIndex, draftIds: group.drafts.map((draft) => draft.id), draft: { type: "brush", roi: group.roi, point: pointForRoi(group.roi) } });
  return requests.sort((first, second) => first.firstIndex - second.firstIndex).map(({ draftIds, draft }) => ({ draftIds, draft }));
}

function boundaryPath(shape, context = ctx) {
  const roi = boundaryDraftBounds(shape);
  if (shape.type === "polygon" && shape.points?.length) {
    shape.points.forEach((point, index) => {
      const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    if (shape.points.length === 4) context.closePath();
    return;
  }
  if (shape.type === "brush" && shape.points?.length) {
    const points = shape.points;
    const first = points[0];
    context.moveTo(state.view.x + first.x * state.view.scale, state.view.y + first.y * state.view.scale);
    for (const point of points.slice(1)) context.lineTo(state.view.x + point.x * state.view.scale, state.view.y + point.y * state.view.scale);
    if (points.length === 1) context.lineTo(state.view.x + first.x * state.view.scale + 0.01, state.view.y + first.y * state.view.scale + 0.01);
    return;
  }
  if (roi) context.rect(state.view.x + roi.left * state.view.scale, state.view.y + roi.top * state.view.scale, (roi.right - roi.left) * state.view.scale, (roi.bottom - roi.top) * state.view.scale);
}

function drawBoundaryScrim(shapes) {
  if (!shapes.length || !state.currentImage) return;
  setCssTransform(boundaryOverlayCtx); boundaryOverlayCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  boundaryOverlayCtx.save();
  boundaryOverlayCtx.beginPath(); boundaryOverlayCtx.rect(state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale); boundaryOverlayCtx.clip();
  boundaryOverlayCtx.fillStyle = "rgba(8, 11, 14, 0.68)"; boundaryOverlayCtx.fillRect(state.view.x, state.view.y, state.currentImage.width * state.view.scale, state.currentImage.height * state.view.scale);
  boundaryOverlayCtx.globalCompositeOperation = "destination-out";
  for (const shape of shapes) {
    boundaryOverlayCtx.beginPath();
    boundaryPath(shape, boundaryOverlayCtx);
    if (shape.type === "brush") {
      boundaryOverlayCtx.lineWidth = Math.max(1, shape.radius * state.view.scale); boundaryOverlayCtx.lineCap = "round"; boundaryOverlayCtx.lineJoin = "round"; boundaryOverlayCtx.stroke();
    } else boundaryOverlayCtx.fill();
  }
  boundaryOverlayCtx.restore(); setCssTransform(ctx); ctx.drawImage(boundaryOverlayCanvas, 0, 0, stage.clientWidth, stage.clientHeight);
}

function drawBoundaryShape(shape) {
  const ready = shape.type !== "polygon" || polygonPointsValid(shape.points || []);
  ctx.save(); ctx.strokeStyle = ready ? "#50d589" : "#f0ba62"; ctx.lineWidth = 2;
  ctx.beginPath(); boundaryPath(shape);
  if (shape.type === "brush") { ctx.lineWidth = Math.max(2, shape.radius * state.view.scale); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(); }
  else ctx.stroke();
  if (shape.type === "polygon") for (const point of shape.points) {
    const x = state.view.x + point.x * state.view.scale; const y = state.view.y + point.y * state.view.scale;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = "#effff4"; ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawBoundaryRoi() {
  const shapes = boundaryShapes();
  if (!shapes.length) return;
  drawBoundaryScrim(shapes);
  shapes.forEach(drawBoundaryShape);
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - point.y * next.x;
  }, 0) / 2);
}

function polygonSegmentsIntersect(a, b, c, d) {
  const orient = (first, second, third) => (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const abC = orient(a, b, c); const abD = orient(a, b, d); const cdA = orient(c, d, a); const cdB = orient(c, d, b);
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function polygonPointsValid(points) {
  return points.length === 4
    && polygonArea(points) >= 16
    && !polygonSegmentsIntersect(points[0], points[1], points[2], points[3])
    && !polygonSegmentsIntersect(points[1], points[2], points[3], points[0]);
}

function polygonIsValid() { return polygonPointsValid(state.polygonPoints); }

function canDetectBoundary() {
  const constructing = state.boundaryDragging || state.polygonPoints.length > 0 || Boolean(state.boundaryBrushStroke);
  return Boolean(state.currentId && state.currentImage && boundaryRequests().length)
    && !constructing && !state.pendingImageId && !state.boundaryPending && !isBusy() && !state.importing;
}

function hasBoundaryDraft() {
  return Boolean(state.boundaryDrafts.length || activeBoundaryShape());
}

function boundaryActionAnchor() {
  const active = activeBoundaryShape() || state.boundaryDrafts.find((draft) => draft.id === state.boundaryActiveId) || state.boundaryDrafts.at(-1);
  const roi = boundaryDraftBounds(active);
  if (!roi) return null;
  return {
    left: state.view.x + roi.left * state.view.scale, right: state.view.x + roi.right * state.view.scale,
    top: state.view.y + roi.top * state.view.scale, bottom: state.view.y + roi.bottom * state.view.scale,
  };
}

function updateBoundaryActions() {
  const actions = $("#boundaryActions");
  if (!actions) return;
  const active = !state.boundaryPending && !state.pendingImageId && hasBoundaryDraft();
  const focusedAction = document.activeElement === $("#boundaryDetectButton") || document.activeElement === $("#boundaryCancelButton");
  actions.hidden = !active;
  $("#boundaryDetectButton").disabled = !canDetectBoundary();
  if (!active) {
    if (focusedAction) focusCanvas();
    return;
  }
  const anchor = boundaryActionAnchor();
  if (!anchor) return;
  const width = actions.offsetWidth || 142;
  const height = actions.offsetHeight || 38;
  const minLeft = 8; const maxLeft = Math.max(minLeft, stage.clientWidth - width - 8);
  const minTop = 8; const maxTop = Math.max(minTop, stage.clientHeight - height - 8);
  const horizontal = Math.max(minLeft, Math.min(maxLeft, anchor.left + (anchor.right - anchor.left - width) / 2));
  const below = anchor.bottom + 8;
  const vertical = Math.max(minTop, Math.min(maxTop, below + height <= stage.clientHeight - 8 ? below : anchor.top - height - 8));
  actions.style.left = `${Math.round(horizontal)}px`;
  actions.style.top = `${Math.round(vertical)}px`;
}

function drawPolygonBoundary() {
  // Polygon drawing is handled together with every selected boundary shape.
}

function drawCandidateBlinkOverlay() {
  if (!state.blinkCandidateIds.size || !state.currentImage || performance.now() % 400 > 200) return;
  blinkCanvas.width = state.currentImage.width; blinkCanvas.height = state.currentImage.height;
  blinkCtx.clearRect(0, 0, blinkCanvas.width, blinkCanvas.height);
  const settings = state.settings?.display || { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78 };
  const paintMask = (image, color) => {
    if (!image) return;
    blinkCtx.save();
    blinkCtx.drawImage(image, 0, 0);
    blinkCtx.globalCompositeOperation = "source-in";
    blinkCtx.fillStyle = color;
    blinkCtx.fillRect(0, 0, blinkCanvas.width, blinkCanvas.height);
    blinkCtx.restore();
  };
  if (state.blinkCandidateIds.has("manual:apply")) paintMask(addCanvas, settings.apply_color);
  if (state.blinkCandidateIds.has("manual:exclude")) paintMask(exclusionCanvas, settings.exclude_color);
  for (const candidate of state.candidates) {
    if (!state.blinkCandidateIds.has(candidate.id)) continue;
    const image = state.candidateImages.get(candidate.id);
    if (!image) continue;
    paintMask(image, candidate.role === "exclude" ? settings.exclude_color : settings.apply_color);
  }
  ctx.save(); ctx.globalAlpha = settings.overlay_opacity; ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale);
  ctx.drawImage(blinkCanvas, 0, 0); ctx.restore();
}

function renderNow() {
  const width = stage.clientWidth; const height = stage.clientHeight;
  setCssTransform(ctx); ctx.clearRect(0, 0, width, height);
  if (!state.currentImage) return;
  ctx.save(); ctx.translate(state.view.x, state.view.y); ctx.scale(state.view.scale, state.view.scale); ctx.drawImage(state.currentImage, 0, 0); ctx.restore();
  if (state.mosaicPreviewEnabled) paintMosaicPreview();
  drawCandidateBlinkOverlay();
  drawBoundaryRoi();
  drawPolygonBoundary();
  drawBrushCursor();
  updateBoundaryActions();
}
function render() {
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => { state.renderFrame = 0; flushMaskComposition(); renderNow(); });
}
function flushRender() {
  if (state.renderFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(state.renderFrame);
  state.renderFrame = 0; flushMaskComposition(); renderNow();
}
