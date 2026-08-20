function detectionParallelism() {
  const value = Number($("#detectParallelism").value);
  return Number.isFinite(value) ? Math.min(4, Math.max(1, Math.round(value))) : 2;
}
function detectionTargets(prefix = "detectTarget") {
  const selected = ["penis", "pussy"].filter((name) => $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked === true);
  return selected.length ? selected : (state.settings?.detection?.targets || ["penis", "pussy"]);
}
function setDetectionTargets(targets, prefix = "detectTarget") {
  const selected = new Set(targets || ["penis", "pussy"]);
  for (const name of ["penis", "pussy"]) $(`#${prefix}${name[0].toUpperCase()}${name.slice(1)}`).checked = selected.has(name);
}

function normaliseImportParallelism(value) {
  if (String(value ?? "").trim() === "") return 3;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(10, Math.max(1, Math.round(number))) : 3;
}

function importParallelism() {
  return normaliseImportParallelism(state.settings?.importing?.parallelism);
}

function openDetectionDialog(imageIds) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.pendingDetectionTargetIds = [...imageIds];
  setDetectionConfidence(detectionConfidence());
  $("#detectParallelism").value = String(detectionParallelism());
  setDetectionTargets(state.settings?.detection?.targets, "dialogTarget");
  $("#detectTargetCount").textContent = t("detectDialog.target", { count: imageIds.length });
  $("#detectDialog").showModal();
}

async function runDetection(imageIds, confidence = detectionConfidence(), parallelism = 1, targetClasses = detectionTargets()) {
  if (!imageIds.length || isBusy() || state.importing) return;
  state.detectionStarting = true;
  updateActionButtons();
  try {
    if (!targetClasses.length) throw new Error("penis または pussy を選択してください。");
    await api("/api/detect", { method: "POST", body: JSON.stringify({ imageIds, confidence, parallelism: Math.min(4, Math.max(1, Math.round(parallelism))), targetClasses }) });
    state.detectionTargetIds = [...imageIds];
    state.detectCancelRequested = false;
    state.job = { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "" };
    showProcessing(state.job);
    updateProgress(state.job); setStatusKey("status.detectStarted", {}, "running");
  } catch (error) { updateProgress({ state: "idle" }); setStatus(error.message, "error"); }
  finally { state.detectionStarting = false; updateActionButtons(); }
}

async function startDetectionFromDialog(event) {
  event.preventDefault();
  const imageIds = state.pendingDetectionTargetIds;
  if (!imageIds.length) return;
  const confidence = normaliseDetectionConfidence($("#detectConfidenceNumber").value);
  const parallelism = detectionParallelism();
  const targetClasses = detectionTargets("dialogTarget");
  setDetectionConfidence(confidence);
  $("#detectDialog").close();
  state.pendingDetectionTargetIds = [];
  if (state.settings) {
    state.settings.detection = { ...state.settings.detection, threshold: confidence, parallelism, targets: targetClasses };
    try { await api("/api/settings", { method: "POST", body: JSON.stringify(state.settings) }); }
    catch (error) { setStatus(error.message, "error"); return; }
  }
  await runDetection(imageIds, confidence, parallelism, targetClasses);
}

async function cancelDetection() {
  if (!activeDetection() || state.detectCancelRequested) return;
  state.detectCancelRequested = true;
  updateActionButtons();
  setStatusKey("status.detectCancelling", {}, "running");
  try { await api("/api/job/cancel", { method: "POST", body: JSON.stringify({}) }); }
  catch (error) { state.detectCancelRequested = false; updateActionButtons(); setStatus(error.message, "error"); }
}

async function saveCurrent() {
  const imageId = state.currentId;
  if (isBusy() || state.importing || !imageId) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  const record = state.images.find((image) => image.id === imageId);
  if (isBusy() || state.importing || state.currentId !== imageId || !record || !imageHasMask(record)) return;
  await openApplyDialog([imageId]);
}

async function saveAll() {
  if (isBusy() || state.importing) return;
  if (state.candidateUpdateChains.size) await waitForCandidateMutations();
  if (isBusy() || state.importing) return;
  saveDraft(); refreshMaskStatus();
  const imageIds = saveTargets();
  if (imageIds.length) await openApplyDialog(imageIds);
}

