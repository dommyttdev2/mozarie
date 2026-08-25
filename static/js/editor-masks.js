function renderCandidates() {
  const applyList = $("#candidateList");
  const excludeList = $("#exclusionList");
  applyList.textContent = ""; excludeList.textContent = "";
  if (!state.currentId) { syncCandidateDisplayButtons(); updateCandidateBatchButtons(false); return; }
  const hasManualExclude = canvasHasPixels(exclusionCtx, exclusionCanvas);
  const hasManualExclusionErase = canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas);
  if (!state.candidates.length && !state.manualMaskPresent && !hasManualExclude && !hasManualExclusionErase) {
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); applyList.append(empty); syncCandidateDisplayButtons(); updateCandidateBatchButtons(undefined, undefined, hasManualExclude); return;
  }
  const appendEmpty = (list) => {
    if (list.children.length) return;
    const empty = document.createElement("p"); empty.className = "candidate-empty"; empty.textContent = t("candidates.none"); list.append(empty);
  };
  const makeToggle = (enabled, label, onChange, disabled = false) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "candidate-toggle";
    button.disabled = disabled; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", String(enabled));
    button.textContent = t(enabled ? "settings.on" : "settings.off");
    button.addEventListener("click", onChange); return button;
  };
  const makeForceToggle = (forced, onChange, disabled = false) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "candidate-forced";
    const text = `${t("candidates.forced")} ${t(forced ? "settings.on" : "settings.off")}`;
    button.disabled = disabled; button.setAttribute("aria-pressed", String(forced)); button.setAttribute("aria-label", text);
    button.textContent = text; button.addEventListener("click", onChange); return button;
  };
  const makeDisplay = (id) => candidateDisplayToggle(id);
  const appendManual = (list, role) => {
    const isApply = role === "apply";
    const exists = isApply ? state.manualMaskPresent : hasManualExclude;
    if (!exists) return;
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-manual ${isApply ? "candidate-row-manual-apply" : "candidate-row-manual-exclude"}`;
    const isEnabled = isApply ? state.manualEnabled : state.manualExclusionEnabled;
    row.classList.toggle("enabled", isEnabled);
    const enabled = makeToggle(isEnabled, isApply ? t("candidates.manualToggle") : t("candidates.manualExcludeToggle"), () => {
      if (isBusy() || state.importing) return;
      if (isApply) state.manualEnabled = !state.manualEnabled; else state.manualExclusionEnabled = !state.manualExclusionEnabled;
      markMaskDirty(); saveDraft();
      setReviewed(currentRecord(), false);
      refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
    });
    const blinkId = `manual:${role}`;
    const blink = makeDisplay(blinkId);
    row.dataset.candidateBlinkId = blinkId; row.dataset.candidateBlinkRole = role;
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = isApply ? t("candidates.manual") : t("candidates.manualExclude");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×";
    remove.title = isApply ? t("candidates.deleteManual") : t("candidates.deleteManualExclude");
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", isApply ? deleteManualMask : deleteManualExclusion);
    if (!isApply) {
      const forced = makeForceToggle(state.manualExclusionForced, () => {
        if (isBusy() || state.importing) return;
        state.manualExclusionForced = !state.manualExclusionForced; markMaskDirty(); saveDraft();
        setReviewed(currentRecord(), false); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
      });
      row.append(label, blink, forced, enabled, remove);
    } else row.append(label, blink, candidateEffectiveToggle(blinkId), enabled, remove);
    list.append(row);
  };
  appendManual(applyList, "apply");
  appendManual(excludeList, "exclude");
  if (hasManualExclusionErase) {
    const blinkId = "manual:excludeErase";
    const row = document.createElement("div"); row.className = "candidate-row candidate-row-manual candidate-row-manual-exclude-erase";
    row.classList.toggle("enabled", state.manualExclusionEraseEnabled);
    const enabled = makeToggle(state.manualExclusionEraseEnabled, t("candidates.manualExcludeEraseToggle"), () => {
      if (isBusy() || state.importing) return;
      state.manualExclusionEraseEnabled = !state.manualExclusionEraseEnabled; markMaskDirty();
      saveDraft();
      setReviewed(currentRecord(), false); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
    });
    const blink = makeDisplay(blinkId);
    row.dataset.candidateBlinkId = blinkId; row.dataset.candidateBlinkRole = "exclude";
    const label = document.createElement("span"); label.className = "candidate-label"; label.textContent = t("candidates.manualExcludeErase");
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "candidate-delete"; remove.textContent = "×";
    remove.title = t("candidates.deleteManualExcludeErase"); remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", deleteManualExclusionErase);
    row.append(label, blink, enabled, remove); excludeList.append(row);
  }
  for (const candidate of state.candidates) {
    if (state.removedCandidateIds.has(candidate.id)) continue;
    const key = candidateMutationKey(state.currentId, candidate.id);
    const deleting = state.candidateDeleting.has(key);
    const role = candidate.role === "exclude" ? "exclude" : "apply";
    const row = document.createElement("div"); row.className = `candidate-row candidate-row-${role}`;
    row.classList.toggle("enabled", candidate.enabled);
    const enabled = makeToggle(candidate.enabled, t("candidates.toggle", { label: candidate.className }), async () => {
      if (isBusy() || state.importing) return;
      const previousEnabled = candidate.enabled;
      const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
      candidate.enabled = !candidate.enabled;
      markMaskDirty();
      setReviewed(currentRecord(), false);
      syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render(); await updateCandidate(candidate, previousEnabled, previousMaskStatus);
    }, deleting || state.candidateBatchPending.has(state.currentId));
    const blink = makeDisplay(candidate.id);
    row.dataset.candidateBlinkId = candidate.id; row.dataset.candidateBlinkRole = role;
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
      const forced = makeForceToggle(candidate.forced !== false, async () => {
        if (isBusy() || state.importing) return;
        const previousForced = candidate.forced !== false;
        const previousMaskStatus = state.maskStatus.has(state.currentId) ? state.maskStatus.get(state.currentId) : imageHasMask(currentRecord());
        candidate.forced = !previousForced; setReviewed(currentRecord(), false);
        markMaskDirty();
        syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); render();
        await updateCandidate(candidate, candidate.enabled, previousMaskStatus, previousForced);
      }, deleting || state.candidateBatchPending.has(state.currentId));
      row.append(label, blink, forced, enabled, remove);
    } else row.append(label, blink, candidateEffectiveToggle(candidate.id), enabled, remove);
    (role === "apply" ? applyList : excludeList).append(row);
  }
  appendEmpty(applyList); appendEmpty(excludeList);
  syncCandidateDisplayButtons(); updateCandidateBatchButtons(undefined, undefined, hasManualExclude || hasManualExclusionErase);
}

function candidateDisplayMode(id) {
  return state.blinkModes.get(id) || (state.blinkCandidateIds.has(id) ? "normal" : "off");
}

function candidateDisplayIdsForRole(role) {
  const ids = state.candidates.filter((candidate) => candidate.role === role && !state.removedCandidateIds.has(candidate.id)).map((candidate) => candidate.id);
  if (role === "apply" && state.manualMaskPresent) ids.push("manual:apply");
  if (role === "exclude" && canvasHasPixels(exclusionCtx, exclusionCanvas)) ids.push("manual:exclude");
  if (role === "exclude" && canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas)) ids.push("manual:excludeErase");
  return ids;
}

function syncCandidateDisplayButtons() {
  document.querySelectorAll("[data-candidate-display-toggle]").forEach((button) => {
    const ids = candidateDisplayIdsForRole(button.dataset.candidateDisplayToggle);
    const normalCount = ids.filter((id) => candidateDisplayMode(id) === "normal").length;
    button.setAttribute("aria-pressed", normalCount === ids.length && ids.length ? "true" : normalCount ? "mixed" : "false");
  });
  document.querySelectorAll("[data-candidate-effective-toggle]").forEach((button) => {
    const ids = candidateDisplayIdsForRole(button.dataset.candidateEffectiveToggle);
    const effectiveCount = ids.filter((id) => candidateDisplayMode(id) === "effective").length;
    button.setAttribute("aria-pressed", effectiveCount === ids.length && ids.length ? "true" : effectiveCount ? "mixed" : "false");
  });
  document.querySelectorAll("[data-candidate-display-id]").forEach((button) => {
    button.setAttribute("aria-pressed", String(candidateDisplayMode(button.dataset.candidateDisplayId) === "normal"));
  });
  document.querySelectorAll("[data-candidate-effective-id]").forEach((button) => {
    button.setAttribute("aria-pressed", String(candidateDisplayMode(button.dataset.candidateEffectiveId) === "effective"));
  });
  const pane = $("#candidatePane");
  pane.classList.toggle("blink-active", state.blinkCandidateIds.size > 0);
  pane.classList.toggle("blink-phase", state.blinkPhase);
  document.querySelectorAll("[data-candidate-blink-id]").forEach((row) => row.classList.toggle("blink-selected", candidateDisplayMode(row.dataset.candidateBlinkId) !== "off"));
}

function clearCandidateBlink() {
  state.blinkCandidateIds.clear(); state.blinkModes.clear(); state.blinkPhase = false;
  if (state.blinkTimer) { clearInterval(state.blinkTimer); state.blinkTimer = null; }
  $("#candidatePane")?.classList.remove("blink-active", "blink-phase");
}

function syncCandidateBlinkTimer() {
  if (!state.blinkCandidateIds.size) { clearCandidateBlink(); return; }
  if (!state.blinkTimer) {
    state.blinkPhase = true;
    state.blinkTimer = setInterval(() => { state.blinkPhase = !state.blinkPhase; syncCandidateDisplayButtons(); render(); }, 200);
  }
}

function setCandidateDisplayMode(ids, mode) {
  ids.forEach((id) => {
    if (mode === "off") { state.blinkCandidateIds.delete(id); state.blinkModes.delete(id); }
    else { state.blinkCandidateIds.add(id); state.blinkModes.set(id, mode); }
  });
  syncCandidateBlinkTimer(); syncCandidateDisplayButtons(); render();
}

function toggleCandidateDisplay(role) {
  const ids = candidateDisplayIdsForRole(role);
  if (!ids.length) return;
  const active = ids.every((id) => candidateDisplayMode(id) === "normal");
  setCandidateDisplayMode(ids, active ? "off" : "normal");
}

function toggleCandidateEffective(role) {
  const ids = candidateDisplayIdsForRole(role);
  if (!ids.length) return;
  const active = ids.every((id) => candidateDisplayMode(id) === "effective");
  setCandidateDisplayMode(ids, active ? "off" : "effective");
}

function candidateDisplayToggle(id) {
  const button = document.createElement("button"); button.type = "button"; button.className = "candidate-display-toggle";
  button.dataset.candidateDisplayId = id;
  button.textContent = t("candidates.show"); button.title = t("candidates.displayHelp"); button.setAttribute("aria-label", t("candidates.displayHelp")); button.setAttribute("aria-pressed", String(candidateDisplayMode(id) === "normal"));
  button.addEventListener("click", () => setCandidateDisplayMode([id], candidateDisplayMode(id) === "normal" ? "off" : "normal"));
  return button;
}

function candidateEffectiveToggle(id) {
  const button = document.createElement("button"); button.type = "button"; button.className = "candidate-effective-toggle";
  button.dataset.candidateEffectiveId = id;
  button.textContent = t("candidates.applied"); button.title = t("candidates.displayEffective"); button.setAttribute("aria-label", t("candidates.displayEffective")); button.setAttribute("aria-pressed", String(candidateDisplayMode(id) === "effective"));
  button.addEventListener("click", () => setCandidateDisplayMode([id], candidateDisplayMode(id) === "effective" ? "off" : "effective"));
  return button;
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
        syncCurrentCandidateRecord(); refreshMaskStatus(true); requestMosaicPreview(); renderCandidates(); render();
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
            candidate.enabled = previousEnabled; candidate.forced = previousForced; syncCurrentCandidateRecord(); refreshMaskStatus(true); requestMosaicPreview(); renderCandidates(); render();
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
  state.removedCandidateIds.add(candidate.id);
  recordHistoryOperation({ kind: "removeCandidates", ids: [candidate.id] });
  markMaskDirty(); setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); saveDraft(); renderCandidates(); render(); renderCatalogViews();
}

function deleteManualMask() {
  if (!state.manualMaskPresent || isBusy() || state.importing) return;
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  state.manualMaskPresent = false; state.manualEnabled = true;
  setCandidateDisplayMode(["manual:apply"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "apply" }); markMaskDirty(); markDraftDirty("add"); saveDraft(); requestMosaicPreview(); updateCandidateStatus(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusion() {
  if (!canvasHasPixels(exclusionCtx, exclusionCanvas) || isBusy() || state.importing) return;
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  state.manualExclusionEnabled = true;
  setCandidateDisplayMode(["manual:exclude"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "exclude" }); markMaskDirty(); markDraftDirty("exclusion"); saveDraft(); requestMosaicPreview(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function deleteManualExclusionErase() {
  if (!canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas) || isBusy() || state.importing) return;
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  state.manualExclusionEraseEnabled = true;
  setCandidateDisplayMode(["manual:excludeErase"], "off");
  setReviewed(currentRecord(), false);
  recordHistoryOperation({ kind: "clearManual", role: "excludeErase" }); markMaskDirty(); markDraftDirty("exclusionErase"); saveDraft(); requestMosaicPreview(); refreshCurrentReviewAndMask(); renderCandidates(); render();
}

function shouldBlinkNewManual(role) {
  const ids = state.candidates.filter((candidate) => candidate.role === role && !state.removedCandidateIds.has(candidate.id)).map((candidate) => candidate.id);
  return ids.length > 0 && ids.every((id) => state.blinkCandidateIds.has(id));
}

async function batchCandidateOperation(spec) {
  const imageId = state.currentId;
  const generation = state.imageGeneration;
  if (!imageId || isBusy() || state.importing || state.candidateBatchPending.has(imageId)) return;
  let [role, operation] = spec.split(":");
  const manual = role === "apply" ? state.manualMaskPresent : canvasHasPixels(exclusionCtx, exclusionCanvas);
  const manualErase = role === "exclude" && canvasHasPixels(exclusionEraseCtx, exclusionEraseCanvas);
  if (operation === "toggle") {
    const enabled = state.candidates.filter((item) => item.role === role && !state.removedCandidateIds.has(item.id)).map((item) => item.enabled);
    if (manual) enabled.push(role === "apply" ? state.manualEnabled : state.manualExclusionEnabled);
    if (manualErase) enabled.push(state.manualExclusionEraseEnabled);
    operation = enabled.length && enabled.every(Boolean) ? "disable" : "enable";
  }
  if (operation === "delete" && confirmationRequired("candidateRoleDelete") && !await confirmAction(t("confirm.candidateRoleDelete.title"), t("confirm.candidateRoleDelete.message"), "candidateRoleDelete")) return;
  if (state.currentId !== imageId || !isCurrentGeneration(generation) || state.candidateBatchPending.has(imageId)) return;
  const changed = state.candidates.filter((item) => item.role === role && !state.removedCandidateIds.has(item.id));
  if (operation === "delete") {
    const ids = changed.map((item) => item.id);
    ids.forEach((id) => state.removedCandidateIds.add(id));
    if (ids.length) recordHistoryOperation({ kind: "removeCandidates", ids });
    markMaskDirty(); setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); saveDraft(); renderCandidates(); render(); renderCatalogViews();
    return;
  }
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
        markMaskDirty();
        if (manual) {
          if (role === "apply") state.manualEnabled = operation === "enable";
          else state.manualExclusionEnabled = operation === "enable";
          markMaskDirty();
        }
        if (manualErase) { state.manualExclusionEraseEnabled = operation === "enable"; markMaskDirty(); }
        if (manual || manualErase) saveDraft();
      }
      retainCurrentCandidateBundle(imageId, result.candidateRevision);
      setReviewed(currentRecord(), false); syncCurrentCandidateRecord(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
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
  const createdCandidateIds = [];
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
      createdCandidateIds.push(...created.map((candidate) => candidate.id));
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
        if (createdCandidateIds.length) { recordHistoryOperation({ kind: "addCandidates", ids: createdCandidateIds }); saveDraft(); }
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
  copyCanvas(addCanvas, historyAddCanvas); copyCanvas(exclusionCanvas, historyExclusionCanvas); copyCanvas(exclusionEraseCanvas, historyExclusionEraseCanvas);
  state.historyRemovedCandidateIds = new Set(state.removedCandidateIds || []);
  state.historyCandidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  state.historyBaseDirty = true;
  state.history = []; state.historyIndex = 0; state.activeStroke = null; updateHistoryButtons();
}

function strokeLine(context, from, to, size, operation = "source-over") {
  context.save(); context.globalCompositeOperation = operation; context.strokeStyle = "#ffffff"; context.lineWidth = size; context.lineCap = "round";
  context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke(); context.restore();
}

function paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, from, to, tool, size) {
  if (tool === "mosaic_eraser") { strokeLine(addContext, from, to, size + 2, "destination-out"); return; }
  if (tool === "exclude_eraser") { strokeLine(exclusionEraseContext, from, to, size); return; }
  if (tool === "eraser") {
    strokeLine(exclusionContext, from, to, size);
    strokeLine(exclusionEraseContext, from, to, size, "destination-out");
    return;
  }
  strokeLine(addContext, from, to, size);
  if (!state.manualExclusionForced) strokeLine(exclusionContext, from, to, size, "destination-out");
}

function paintStroke(from, to, tool, size) {
  paintStrokeOnContexts(addCtx, exclusionCtx, exclusionEraseCtx, from, to, tool, size);
  markMaskDirty();
  if (tool === "brush" || tool === "mosaic_eraser") markDraftDirty("add");
  if (tool === "eraser") markDraftDirty("exclusion", "exclusionErase");
  if (tool === "exclude_eraser") markDraftDirty("exclusionErase");
}

function fillAt(point, tool = state.tool) {
  if (!state.currentImage) return;
  const width = originalCanvas.width; const height = originalCanvas.height;
  const pixels = originalCtx.getImageData(0, 0, width, height).data;
  const x = Math.min(width - 1, Math.max(0, Math.floor(point.x))); const y = Math.min(height - 1, Math.max(0, Math.floor(point.y)));
  const tolerance = Math.max(0, Math.min(255, Number($("#bucketTolerance").value) || 0));
  const generation = state.imageGeneration; const epoch = state.catalogEpoch; const imageId = state.currentId; const record = currentRecord(); const version = imageAssetVersion(record); const revision = Number(record?.candidateRevision || 0);
  const apply = (spans) => {
    if (!catalogRecordMatches(record, epoch, { version, revision }) || !isCurrentGeneration(generation) || state.currentId !== imageId) { state.fillPending = false; return; }
    applyFillSpans(spans, tool); state.history.splice(state.historyIndex); state.history.push({ tool, spans }); trimHistory();
    state.historyIndex = state.history.length; state.manualMaskPresent = true; state.fillPending = false; if (state.workspacePersistence) scheduleManualWorkspaceSave(); setReviewed(currentRecord(), false); updateHistoryButtons(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
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

function paintFillSpans(addContext, exclusionContext, exclusionEraseContext, spans, tool = "bucket") {
  const target = tool === "exclude_eraser" ? exclusionEraseContext : (tool === "eraser" || tool === "exclude_bucket" ? exclusionContext : addContext);
  target.save(); target.globalCompositeOperation = "source-over"; target.fillStyle = "#ffffff";
  if ((tool === "eraser" || tool === "exclude_bucket") || (!state.manualExclusionForced && tool === "bucket")) exclusionEraseContext.save();
  if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.globalCompositeOperation = "destination-out";
  else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.save(), exclusionContext.globalCompositeOperation = "destination-out";
  for (let index = 0; index < spans.length; index += 3) {
    const row = spans[index]; const start = spans[index + 1]; const width = spans[index + 2] - start;
    target.fillRect(start, row, width, 1);
    if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.fillRect(start, row, width, 1);
    else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.fillRect(start, row, width, 1);
  }
  target.restore();
  if (tool === "eraser" || tool === "exclude_bucket") exclusionEraseContext.restore();
  else if (!state.manualExclusionForced && tool === "bucket") exclusionContext.restore();
  if (tool === "bucket") markDraftDirty("add", ...(state.manualExclusionForced ? [] : ["exclusion"]));
  if (tool === "eraser" || tool === "exclude_bucket") markDraftDirty("exclusion", "exclusionErase");
  if (tool === "exclude_eraser") markDraftDirty("exclusionErase");
}

function applyFillSpans(spans, tool = "bucket") {
  paintFillSpans(addCtx, exclusionCtx, exclusionEraseCtx, spans, tool); markMaskDirty(); flushMaskComposition();
}

function drawStroke(from, to, tool, size = Number($("#brushSize").value)) {
  paintStroke(from, to, tool, size);
}

function beginManualStroke(point) {
  state.activeStroke = { tool: state.tool, size: Number($("#brushSize").value), points: [{ ...point }] };
  if (state.tool === "brush" && shouldBlinkNewManual("apply")) setCandidateDisplayMode(["manual:apply"], "normal");
  if (state.tool === "eraser" && shouldBlinkNewManual("exclude")) setCandidateDisplayMode(["manual:exclude"], "normal");
  drawStroke(point, point, state.tool, state.activeStroke.size);
}

function appendManualStrokePoint(point) {
  if (!state.activeStroke) return;
  const previous = state.activeStroke.points.at(-1);
  state.activeStroke.points.push({ ...point });
  drawStroke(previous, point, state.activeStroke.tool, state.activeStroke.size);
}

function replayManualStroke(stroke, addContext = addCtx, exclusionContext = exclusionCtx, exclusionEraseContext = exclusionEraseCtx) {
  if (stroke.kind === "removeCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.add(id)); return; }
  if (stroke.kind === "restoreCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.delete(id)); return; }
  if (stroke.kind === "addCandidates") { stroke.ids.forEach((id) => state.removedCandidateIds.delete(id)); return; }
  if (stroke.kind === "clearManual") { const target = stroke.role === "apply" ? addContext : (stroke.role === "exclude" ? exclusionContext : exclusionEraseContext); target.clearRect(0, 0, target.canvas.width, target.canvas.height); return; }
  if (["bucket", "exclude_bucket"].includes(stroke.tool)) { paintFillSpans(addContext, exclusionContext, exclusionEraseContext, stroke.spans, stroke.tool); return; }
  const points = stroke.points;
  if (!points.length) return;
  paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, points[0], points[0], stroke.tool, stroke.size);
  for (let index = 1; index < points.length; index += 1) {
    paintStrokeOnContexts(addContext, exclusionContext, exclusionEraseContext, points[index - 1], points[index], stroke.tool, stroke.size);
  }
}

function historyWeight(stroke) { return stroke.spans?.byteLength || (stroke.spans?.length || 0) * 4 || (stroke.points?.length || 0) * 16; }
function trimHistory() {
  while (state.history.length > 12 || state.history.reduce((total, stroke) => total + historyWeight(stroke), 0) > 64 * 1024 * 1024) {
    const operation = state.history.shift();
    replayManualStroke(operation, historyAddCanvas.getContext("2d"), historyExclusionCanvas.getContext("2d"), historyExclusionEraseCanvas.getContext("2d"));
    if (operation.kind === "removeCandidates") operation.ids.forEach((id) => state.historyRemovedCandidateIds.add(id));
    if (operation.kind === "restoreCandidates") operation.ids.forEach((id) => state.historyRemovedCandidateIds.delete(id));
    if (operation.kind === "addCandidates") operation.ids.forEach((id) => { state.historyCandidateIds.add(id); state.historyRemovedCandidateIds.delete(id); });
    state.historyBaseDirty = true;
  }
}

function recordHistoryOperation(operation) {
  state.history.splice(state.historyIndex);
  state.history.push(operation); trimHistory(); state.historyIndex = state.history.length;
  updateHistoryButtons();
}

function rebuildManualMaskFromHistory() {
  addCtx.clearRect(0, 0, addCanvas.width, addCanvas.height);
  exclusionCtx.clearRect(0, 0, exclusionCanvas.width, exclusionCanvas.height);
  exclusionEraseCtx.clearRect(0, 0, exclusionEraseCanvas.width, exclusionEraseCanvas.height);
  addCtx.drawImage(historyAddCanvas, 0, 0); exclusionCtx.drawImage(historyExclusionCanvas, 0, 0); exclusionEraseCtx.drawImage(historyExclusionEraseCanvas, 0, 0);
  state.removedCandidateIds = new Set(state.historyRemovedCandidateIds || []);
  for (const candidate of state.candidates) if (!(state.historyCandidateIds || new Set()).has(candidate.id)) state.removedCandidateIds.add(candidate.id);
  for (const stroke of state.history.slice(0, state.historyIndex)) replayManualStroke(stroke);
  state.manualMaskPresent = canvasHasPixels(addCtx, addCanvas);
  markMaskDirty(); markDraftDirty("add", "exclusion", "exclusionErase");
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
  if (state.workspacePersistence) scheduleManualWorkspaceSave();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates();
}

function restoreSnapshot(index) {
  if (isBusy() || state.importing || index < 0 || index > state.history.length) return;
  state.historyIndex = index;
  rebuildManualMaskFromHistory();
  if (state.workspacePersistence) scheduleManualWorkspaceSave();
  setReviewed(currentRecord(), false);
  updateHistoryButtons(); updateCandidateStatus(); refreshCurrentReviewAndMask(); requestMosaicPreview(); renderCandidates(); render();
}

function buildCombinedMask() {
  if (!state.currentImage) return null;
  flushMaskComposition();
  return combinedCanvas.toDataURL("image/png");
}
