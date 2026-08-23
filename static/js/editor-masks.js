function renderCandidates() {
  const applyList = $("#candidateList");
  const excludeList = $("#exclusionList");
  applyList.textContent = ""; excludeList.textContent = "";
  if (!state.currentId) { updateCandidateBatchButtons(false); return; }
  const hasManualExclude = canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (!state.candidates.length && !state.manualMaskPresent && !hasManualExclude) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); applyList.append(empty); updateCandidateBatchButtons(undefined, undefined, hasManualExclude); return;
  }
  const appendEmpty = (list) => {
    if (list.children.length) return;
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty);
  };
  const appendManual = (list, role) => {
    const isApply = role === "apply";
    const exists = isApply ? state.manualMaskPresent : hasManualExclude;
    if (!exists) return;
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-manual ${isApply ? "candidate-row-manual-apply" : "candidate-row-manual-exclude"}`;
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = isApply ? state.manualEnabled : state.manualExclusionEnabled;
    enabled.setAttribute("aria-label", isApply ? t("candidates.manualToggle") : t("candidates.manualExcludeToggle"));
    enabled.addEventListener("change", () => {
      if (isBusy() || state.importing) { enabled.checked = isApply ? state.manualEnabled : state.manualExclusionEnabled; return; }
      if (isApply) state.manualEnabled = enabled.checked; else state.manualExclusionEnabled = enabled.checked;
      markMaskDirty();
      setReviewed(currentRecord(), false);
      resetHistoryToCurrentManualMask(); refreshCurrentReviewAndMask(); renderCandidates(); render();
    });
    const blinkId = `manual:${role}`;
    const blink = document.createElement("button"); blink.type = "button"; blink.className = `candidate-blink ${role}`;
    blink.textContent = "◉"; blink.title = t("candidates.blink"); blink.setAttribute("aria-label", blink.title);
    blink.classList.toggle("active", state.blinkCandidateIds.has(blinkId));
    blink.addEventListener("click", () => {
      if (state.blinkCandidateIds.has(blinkId)) state.blinkCandidateIds.delete(blinkId);
      else state.blinkCandidateIds.add(blinkId);
      renderCandidates(); render();
    });
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = isApply ? t("candidates.manual") : t("candidates.manualExclude");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×";
    remove.title = isApply ? t("candidates.deleteManual") : t("candidates.deleteManualExclude");
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", isApply ? deleteManualMask : deleteManualExclusion);
    if (!isApply) {
      const forced = document.createElement("input"); forced.type = "checkbox"; forced.checked = state.manualExclusionForced;
      forced.setAttribute("aria-label", t("candidates.forced"));
      forced.addEventListener("change", () => {
        if (isBusy() || state.importing) { forced.checked = state.manualExclusionForced; return; }
        state.manualExclusionForced = forced.checked; markMaskDirty(); saveDraft();
        setReviewed(currentRecord(), false); refreshCurrentReviewAndMask(); renderCandidates(); render();
      });
      const forcedLabel = document.createElement("label"); forcedLabel.className = "candidate-forced"; forcedLabel.append(forced, document.createTextNode(t("candidates.forced")));
      row.append(enabled, blink, label, forcedLabel, remove);
    } else row.append(enabled, blink, label, remove);
    list.append(row);
  };
  appendManual(applyList, "apply");
  appendManual(excludeList, "exclude");
  for (const candidate of state.candidates) {
    const key = candidateMutationKey(state.currentId, candidate.id);
    const deleting = state.candidateDeleting.has(key);
    const role = candidate.role === "exclude" ? "exclude" : "apply";
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-${role}`;
    if (state.blinkCandidateIds.has(candidate.id)) row.classList.add(`blink-${role}`);
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = candidate.enabled; enabled.disabled = deleting || state.candidateBatchPending.has(state.currentId);
    enabled.setAttribute("aria-label", t("candidates.toggle", { label: candidate.className }));
    enabled.addEventListener("change", async () => {
      if (isBusy() || state.importing) { enabled.checked = candidate.enabled; return; }
      const previousEnabled = candidate.enabled;
      const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
      candidate.enabled = enabled.checked;
      setReviewed(currentRecord(), false);
      syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); render(); await updateCandidate(candidate, previousEnabled, previousMaskStatus);
    });
    const blink = document.createElement("button"); blink.type = "button"; blink.className = `candidate-blink ${role}`;
    blink.textContent = "◉"; blink.title = t("candidates.blink"); blink.setAttribute("aria-label", blink.title);
    blink.classList.toggle("active", state.blinkCandidateIds.has(candidate.id));
    blink.addEventListener("click", () => {
      if (state.blinkCandidateIds.has(candidate.id)) state.blinkCandidateIds.delete(candidate.id);
      else state.blinkCandidateIds.add(candidate.id);
      renderCandidates(); render();
    });
    const label = document.createElement("span"); label.className = "candidate-label";
    const name = document.createElement("span"); name.className = "candidate-class"; name.textContent = candidate.className;
    const confidence = document.createElement("span"); confidence.className = "candidate-conf";
    confidence.textContent = Number.isFinite(candidate.confidence) ? `${Math.round(candidate.confidence * 100)}%` : "";
    label.append(name, confidence);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×"; remove.disabled = deleting || state.candidateBatchPending.has(state.currentId);
    const deleteLabel = t("candidates.delete", { label: candidate.className });
    remove.title = deleteLabel; remove.setAttribute("aria-label", deleteLabel);
    remove.addEventListener("click", () => deleteCandidate(candidate));
    if (role === "exclude") {
      const forced = document.createElement("input"); forced.type = "checkbox"; forced.checked = candidate.forced !== false;
      forced.disabled = deleting || state.candidateBatchPending.has(state.currentId);
      forced.setAttribute("aria-label", t("candidates.forced"));
      forced.addEventListener("change", async () => {
        if (isBusy() || state.importing) { forced.checked = candidate.forced !== false; return; }
        const previousForced = candidate.forced !== false;
        const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
        candidate.forced = forced.checked; setReviewed(currentRecord(), false);
        syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); render();
        await updateCandidate(candidate, candidate.enabled, previousMaskStatus, previousForced);
      });
      const forcedLabel = document.createElement("label"); forcedLabel.className = "candidate-forced"; forcedLabel.append(forced, document.createTextNode(t("candidates.forced")));
      row.append(enabled, blink, label, forcedLabel, remove);
    } else row.append(enabled, blink, label, remove);
    (role === "apply" ? applyList : excludeList).append(row);
  }
  appendEmpty(applyList); appendEmpty(excludeList);
  updateCandidateBatchButtons(undefined, undefined, hasManualExclude);
}

function candidateMutationKey(imageId, candidateId) { return `${imageId}:${candidateId}`; }
function clearCandidateMutationState(imageId) {
  state.candidateUpdateChains.delete(imageId);
  state.candidateBatchPending.delete(imageId);
  for (const key of state.candidateUpdateVersions.keys()) if (key.startsWith(`${imageId}:`)) state.candidateUpdateVersions.delete(key);
  for (const key of state.candidateDeleting) if (key.startsWith(`${imageId}:`)) state.candidateDeleting.delete(key);
}
function nextCandidateMutationVersion(key) {
  const version = (state.candidateUpdateVersions.get(key) || 0) + 1;
  state.candidateUpdateVersions.set(key, version);
  return version;
}
function enqueueCandidateMutation(imageId, send) {
  const previous = state.candidateUpdateChains.get(imageId) || Promise.resolve();
  const queued = previous.then(send, send);
  const tracked = queued.finally(() => {
    if (state.candidateUpdateChains.get(imageId) === tracked) state.candidateUpdateChains.delete(imageId);
    updateActionButtons();
  });
  state.candidateUpdateChains.set(imageId, tracked);
  updateActionButtons();
  return tracked;
}

async function waitForCandidateMutations() {
  while (state.candidateUpdateChains.size) {
    await Promise.allSettled([...state.candidateUpdateChains.values()]);
  }
}

async function updateCandidate(candidate, previousEnabled, previousMaskStatus, previousForced = candidate.forced) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  const targetCandidates = [...state.candidates];
  const mutationKey = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(mutationKey);
  const desired = candidate.enabled;
  const desiredForced = candidate.forced;
  const send = async () => {
    try {
      const result = await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, {
        method: "POST", body: JSON.stringify({ enabled: desired, color: candidate.color, ...(candidate.role === "exclude" ? { forced: desiredForced } : {}) }),
      });
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        const currentCandidate = state.candidates.find((item) => item.id === candidate.id);
        if (currentCandidate) { currentCandidate.enabled = desired; currentCandidate.forced = desiredForced; }
        retainCurrentCandidateBundle(imageId, result.candidateRevision);
        syncCurrentCandidateRecord(); refreshMaskStatus(true); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId, true); } catch { /* Keep the optimistic aggregate until a later refresh. */ }
        renderCatalogViews();
      }
    } catch (error) {
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        try {
          if (await reconcileCurrentCandidates(imageId, generation)) {
            setStatus(error.message, "error");
            return;
          }
        } catch {
          if (state.currentId === imageId && isCurrentGeneration(generation)) {
            candidate.enabled = previousEnabled; candidate.forced = previousForced; syncCurrentCandidateRecord(); refreshMaskStatus(true); renderCandidates(); render();
            setStatus(error.message, "error");
            return;
          }
        }
      }
      candidate.enabled = previousEnabled; candidate.forced = previousForced;
      syncCandidateRecord(imageId, targetCandidates);
      if (previousMaskStatus !== undefined) state.maskStatus.set(imageId, previousMaskStatus);
      try {
        await refreshCandidateRecord(imageId, true);
      } catch { /* The local rollback already removed the optimistic aggregate. */ }
      renderCatalogViews();
    }
  };
  return enqueueCandidateMutation(imageId, send);
}

async function deleteCandidate(candidate) {
  if (!state.currentId || isBusy() || state.importing) return;
  if (confirmationRequired("candidateDelete") && !await confirmAction(t("confirm.candidateDelete.title"), t("confirm.candidateDelete.message"), "candidateDelete")) return;
  const imageId = state.currentId;
  setReviewed(currentRecord(), false);
  const generation = state.imageGeneration;
  const mutationKey = candidateMutationKey(imageId, candidate.id);
  const version = nextCandidateMutationVersion(mutationKey);
  const remainingCandidates = state.candidates.filter((item) => item.id !== candidate.id);
  const remainingMaskStatus = maskStatusWithoutCandidate(candidate.id);
  state.candidateDeleting.add(mutationKey); renderCandidates();
  const send = async () => {
    try {
      const result = await api(`/api/candidate/${encodeURIComponent(imageId)}/${encodeURIComponent(candidate.id)}`, { method: "DELETE" });
      if (state.candidateUpdateVersions.get(mutationKey) !== version) return;
      syncCandidateRecord(imageId, remainingCandidates);
      state.maskStatus.set(imageId, remainingMaskStatus);
      if (state.currentId === imageId && isCurrentGeneration(generation)) {
        state.candidates = remainingCandidates;
        releaseCandidateBitmap(candidate.id);
        retainCurrentCandidateBundle(imageId, result.candidateRevision);
        updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
      } else {
        try { await refreshCandidateRecord(imageId, true); } catch { /* The known deletion is already reflected locally. */ }
      }
      renderCatalogViews();
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation) && state.candidateUpdateVersions.get(mutationKey) === version) {
        try { await reconcileCurrentCandidates(imageId, generation); } catch { /* Keep the existing coherent row. */ }
        setStatus(error.message, "error");
      }
    } finally {
      if (state.candidateUpdateVersions.get(mutationKey) === version) {
        state.candidateDeleting.delete(mutationKey);
        if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
      }
    }
  };
  return enqueueCandidateMutation(imageId, send);
}

function deleteManualMask() {
  if (!state.manualMaskPresent || isBusy() || state.importing) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true;
  state.blinkCandidateIds.delete("manual:apply");
  setReviewed(currentRecord(), false);
  resetHistoryToCurrentManualMask(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusion() {
  if (!canvasHasPixels(exclusionCtx, exclusionCanvas) || isBusy() || state.importing) return;
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  state.manualExclusionEnabled = true;
  state.blinkCandidateIds.delete("manual:exclude");
  setReviewed(currentRecord(), false);
  resetHistoryToCurrentManualMask(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

async function batchCandidateOperation(spec) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  if (!imageId || isBusy() || state.importing || state.candidateBatchPending.has(imageId)) return;
  const [role, operation] = spec.split(":");
  const manual = role === "apply" ? state.manualMaskPresent : canvasHasPixels(exclusionCtx, exclusionCanvas);
  if (operation === "blink") {
    const ids = state.candidates.filter((item) => item.role === role).map((item) => item.id);
    if (manual) ids.push(`manual:${role}`);
    const allActive = ids.length && ids.every((id) => state.blinkCandidateIds.has(id));
    ids.forEach((id) => allActive ? state.blinkCandidateIds.delete(id) : state.blinkCandidateIds.add(id));
    renderCandidates(); render(); return;
  }
  if (operation === "delete" && confirmationRequired("candidateRoleDelete") && !await confirmAction(t("confirm.candidateRoleDelete.title"), t("confirm.candidateRoleDelete.message"), "candidateRoleDelete")) return;
  if (state.currentId !== imageId || !isCurrentGeneration(generation) || state.candidateBatchPending.has(imageId)) return;
  const changed = state.candidates.filter((item) => item.role === role);
  state.candidateBatchPending.add(imageId);
  const send = async () => {
    try {
      const result = await api("/api/candidates/batch", { method: "POST", body: JSON.stringify({ imageId, role, operation }) });
      if (state.currentId !== imageId || !isCurrentGeneration(generation)) {
        await refreshCandidateRecord(imageId, true);
        renderCatalogViews();
        return;
      }
      if (operation === "delete") {
        changed.forEach((item) => releaseCandidateBitmap(item.id));
        state.candidates = state.candidates.filter((item) => item.role !== role);
        if (manual) role === "apply" ? deleteManualMask() : deleteManualExclusion();
      } else {
        changed.forEach((item) => { item.enabled = operation === "enable"; });
        if (manual) {
          if (role === "apply") state.manualEnabled = operation === "enable";
          else state.manualExclusionEnabled = operation === "enable";
          markMaskDirty();
        }
      }
      retainCurrentCandidateBundle(imageId, result.candidateRevision);
      setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); renderCandidates(); render();
    } catch (error) {
      if (state.currentId === imageId && isCurrentGeneration(generation)) setStatus(error.message, "error");
    } finally {
      state.candidateBatchPending.delete(imageId);
      if (state.currentId === imageId && isCurrentGeneration(generation)) renderCandidates();
      updateActionButtons();
    }
  };
  const queued = enqueueCandidateMutation(imageId, send);
  renderCandidates();
  return queued;
}

async function addBoundaryCandidate() {
  if (!canDetectBoundary()) return;
  const imageId = state.currentId;
  const viewGeneration = state.imageGeneration;
  const requests = boundaryRequests();
  let catalogChanged = false;
  state.boundaryPending = true; updateBoundaryActions(); updateActionButtons(); setStatusKey("status.boundaryDetecting", {}, "running");
  try {
    for (const request of requests) {
      const body = request.draft.type === "polygon"
        ? { imageId, points: request.draft.points.map((point) => ({ ...point })) }
        : { imageId, roi: request.draft.roi, point: request.draft.point || pointForRoi(request.draft.roi) };
      let data;
      try {
        data = await api("/api/boundary", { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error");
        break;
      }
      const created = Array.isArray(data.candidates) ? data.candidates : [];
      if (!created.length || !Number.isInteger(data.candidateRevision)) {
        if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(t("error.boundaryResponse"), "error");
        break;
      }
      const record = state.images.find((item) => item.id === imageId);
      if (record) {
        record.candidateCount = (record.candidateCount || 0) + created.length;
        record.enabledCandidateCount = (record.enabledCandidateCount || 0) + created.filter((candidate) => candidate.enabled && candidate.role !== "exclude").length;
        record.candidateRevision = data.candidateRevision;
        state.maskStatus.set(imageId, true);
      }
      state.boundaryDrafts = state.boundaryDrafts.filter((draft) => !request.draftIds.includes(draft.id));
      state.boundaryActiveId = state.boundaryDrafts.at(-1)?.id || null;
      invalidateCandidateBundles(imageId); catalogChanged = true;
    }
    if (catalogChanged) {
      markImagesUnreviewed([imageId], false);
      if (state.currentId === imageId && state.imageGeneration === viewGeneration) {
        await reconcileCurrentCandidates(imageId, viewGeneration);
        if (!state.boundaryDrafts.length) setStatusKey("status.boundaryDone");
      }
    }
  } catch (error) {
    if (state.currentId === imageId && state.imageGeneration === viewGeneration) setStatus(error.message, "error");
  } finally {
    state.boundaryPending = false;
    if (catalogChanged) renderCatalogViews();
    updateBoundaryActions(); updateActionButtons();
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left - state.view.x) / state.view.scale, y: (event.clientY - rect.top - state.view.y) / state.view.scale }; }
function clampPoint(point) {
  if (!state.currentImage) return point;
  return {
    x: Math.min(state.currentImage.width, Math.max(0, point.x)),
    y: Math.min(state.currentImage.height, Math.max(0, point.y)),
  };
}
function boundaryDragStarted(event) {
  return Boolean(state.boundaryStartClient) && Math.hypot(
    event.clientX - state.boundaryStartClient.x,
    event.clientY - state.boundaryStartClient.y,
  ) >= 3;
}
function polygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  return state.polygonPoints.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
}
function completedPolygonVertexAt(point) {
  const radius = Math.max(8, 12 / Math.max(state.view.scale, 0.1));
  for (const draft of [...state.boundaryDrafts].reverse()) {
    if (draft.type !== "polygon") continue;
    const index = draft.points.findIndex((vertex) => Math.hypot(vertex.x - point.x, vertex.y - point.y) <= radius);
    if (index >= 0) return { draft, index };
  }
  return null;
}
function rectangleDraftAt(point) {
  return [...state.boundaryDrafts].reverse().find((draft) => draft.type === "rectangle"
    && point.x >= draft.roi.left && point.x < draft.roi.right
    && point.y >= draft.roi.top && point.y < draft.roi.bottom) || null;
}
function cancelBoundary() {
  clearBoundaryInteraction(); render();
}
function copyCanvas(source, target) {
  target.width = source.width; target.height = source.height;
  target.getContext("2d").drawImage(source, 0, 0);
}

function updateHistoryButtons() {
  $("#undoButton").disabled = state.historyIndex <= 0;
  $("#redoButton").disabled = state.historyIndex >= state.history.length;
}

function resetHistoryToCurrentManualMask() {
  if (!state.currentImage) return;
  copyCanvas(addCanvas, historyAddCanvas); copyCanvas(exclusionCanvas, historyExclusionCanvas);
  state.history = []; state.historyIndex = 0; state.activeStroke = null; updateHistoryButtons();
}

function paintStrokeOnContexts(addContext, exclusionContext, from, to, erase, size) {
  const target = erase ? exclusionContext : addContext; const opposite = erase ? addContext : exclusionContext;
  if (erase || !state.manualExclusionForced) { opposite.save(); opposite.globalCompositeOperation = "destination-out"; opposite.lineWidth = size; opposite.lineCap = "round"; opposite.beginPath(); opposite.moveTo(from.x, from.y); opposite.lineTo(to.x, to.y); opposite.stroke(); opposite.restore(); }
  target.save(); target.globalCompositeOperation = "source-over"; target.strokeStyle = "#ffffff"; target.lineWidth = size; target.lineCap = "round"; target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke(); target.restore();
}

function paintStroke(from, to, erase, size) {
  paintStrokeOnContexts(addCtx, exclusionCtx, from, to, erase, size);
  markMaskDirty();
}

function fillAt(point) {
  if (!state.currentImage) return;
  const width = originalCanvas.width; const height = originalCanvas.height;
  const pixels = originalCtx.getImageData(0, 0, width, height).data;
  const x = Math.min(width - 1, Math.max(0, Math.floor(point.x))); const y = Math.min(height - 1, Math.max(0, Math.floor(point.y)));
  const tolerance = Math.max(0, Math.min(255, Number($("#bucketTolerance").value) || 0));
  const generation = state.imageGeneration; const epoch = state.catalogEpoch; const imageId = state.currentId; const record = currentRecord(); const version = imageAssetVersion(record); const revision = Number(record?.candidateRevision || 0);
  const apply = (spans) => {
    if (!catalogRecordMatches(record, epoch, { version, revision }) || !isCurrentGeneration(generation) || state.currentId !== imageId) { state.fillPending = false; return; }
    applyFillSpans(spans); state.history.splice(state.historyIndex); state.history.push({ tool: "bucket", spans }); trimHistory();
    state.historyIndex = state.history.length; state.manualMaskPresent = true; state.fillPending = false; setReviewed(currentRecord(), false); updateHistoryButtons(); refreshCurrentReviewAndMask(); renderCandidates(); render();
  };
  if (typeof Worker !== "function") { setStatus(t("error.requestFailed"), "error"); return; }
  state.fillWorker?.terminate?.(); state.fillPending = true;
  let worker;
  try { worker = state.fillWorker = new Worker("/js/flood-fill-worker.js"); }
  catch { state.fillPending = false; setStatus(t("error.requestFailed"), "error"); return; }
  worker.onmessage = ({ data }) => { if (state.fillWorker !== worker) return; state.fillWorker = null; worker.terminate(); apply(data.spans); };
  worker.onerror = () => { if (state.fillWorker === worker) { state.fillWorker = null; state.fillPending = false; setStatus(t("error.requestFailed"), "error"); } worker.terminate(); };
  worker.postMessage({ pixels: pixels.buffer, width, height, x, y, tolerance }, [pixels.buffer]);
}

function paintFillSpans(addContext, exclusionContext, spans) {
  addContext.save(); addContext.fillStyle = "#ffffff";
  if (!state.manualExclusionForced) exclusionContext.save();
  if (!state.manualExclusionForced) exclusionContext.globalCompositeOperation = "destination-out";
  for (let index = 0; index < spans.length; index += 3) { const row = spans[index]; const start = spans[index + 1]; const end = spans[index + 2]; addContext.fillRect(start, row, end - start, 1); if (!state.manualExclusionForced) exclusionContext.fillRect(start, row, end - start, 1); }
  addContext.restore(); if (!state.manualExclusionForced) exclusionContext.restore();
}

function applyFillSpans(spans) {
  paintFillSpans(addCtx, exclusionCtx, spans); markMaskDirty(); flushMaskComposition();
}

function drawStroke(from, to, erase, size = Number($("#brushSize").value)) {
  paintStroke(from, to, erase, size);
}

function beginManualStroke(point) {
  state.activeStroke = { tool: state.tool, size: Number($("#brushSize").value), points: [{ ...point }] };
  drawStroke(point, point, state.tool === "eraser", state.activeStroke.size);
}

function appendManualStrokePoint(point) {
  if (!state.activeStroke) return;
  const previous = state.activeStroke.points.at(-1);
  state.activeStroke.points.push({ ...point });
  drawStroke(previous, point, state.activeStroke.tool === "eraser", state.activeStroke.size);
}

function replayManualStroke(stroke, addContext = addCtx, exclusionContext = exclusionCtx) {
  if (stroke.tool === "bucket") { paintFillSpans(addContext, exclusionContext, stroke.spans); return; }
  const erase = stroke.tool === "eraser";
  const points = stroke.points;
  if (!points.length) return;
  paintStrokeOnContexts(addContext, exclusionContext, points[0], points[0], erase, stroke.size);
  for (let index = 1; index < points.length; index += 1) {
    paintStrokeOnContexts(addContext, exclusionContext, points[index - 1], points[index], erase, stroke.size);
  }
}

function historyWeight(stroke) { return stroke.spans?.byteLength || (stroke.spans?.length || 0) * 4 || (stroke.points?.length || 0) * 16; }
function trimHistory() {
  while (state.history.length > 12 || state.history.reduce((total, stroke) => total + historyWeight(stroke), 0) > 64 * 1024 * 1024) {
    replayManualStroke(state.history.shift(), historyAddCanvas.getContext("2d"), historyExclusionCanvas.getContext("2d"));
  }
}

function rebuildManualMaskFromHistory() {
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  addCtx.drawImage(historyAddCanvas, 0, 0); exclusionCtx.drawImage(historyExclusionCanvas, 0, 0);
  for (const stroke of state.history.slice(0, state.historyIndex)) replayManualStroke(stroke);
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  markMaskDirty();
  flushMaskComposition();
}

function completeManualStroke() {
  const stroke = state.activeStroke;
  state.activeStroke = null;
  if (!stroke?.points?.length) return;
  state.history.splice(state.historyIndex);
  state.history.push(stroke);
  trimHistory();
  state.historyIndex = state.history.length;
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates();
}

function restoreSnapshot(index) {
  if (isBusy() || state.importing || index < 0 || index > state.history.length) return;
  state.historyIndex = index;
  rebuildManualMaskFromHistory();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  flushMaskComposition();
  return combinedCanvas.toDataURL("image/png");
}
