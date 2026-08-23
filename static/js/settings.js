function closeBatchMoreMenus() {
  for (const id of ["#batchMoreMenu", "#selectionActionsMenu"]) {
    const menu = $(id);
    if (menu.matches(":popover-open")) menu.hidePopover();
  }
}

function renderModelStatus() {
  const modelStatus = Object.entries(state.settingsStatus?.models || {});
  const activeModels = modelStatus.filter(([, model]) => model.required === true || model.enabled === true);
  const modelMessage = activeModels.length && activeModels.every(([, model]) => model.valid)
    ? ""
    : activeModels.map(([key, model]) => {
      const labelKey = {
        target_segmentation: "settings.targetModel",
        ntd11: "settings.ntd11Model",
        sensitive: "settings.sensitiveModel",
        hand_detection: "settings.handModel",
        hand_segmentation: "settings.handSegmentationModel",
        sam_checkpoint: "settings.samModel",
      }[key];
      return labelKey && model.reasonCode ? `${t(labelKey)}: ${t(`settings.modelStatus.${model.reasonCode}`)}` : "";
    }).filter(Boolean).join("\n");
  const gpuMessage = state.settingsStatus?.gpuDeviceReasonCode
    ? `${t("settings.gpu")}: ${t("settings.gpuUnsupported")}` : "";
  $("#settingsModelStatus").textContent = [modelMessage, gpuMessage].filter(Boolean).join("\n");
  renderSamVariantStatuses();
}

let samCheckpointPaths = { vit_b: "", vit_l: "", vit_h: "" };

function selectedSamType() { return $("#settingsSamType").value || "vit_b"; }

function storeSelectedSamPath() { samCheckpointPaths[selectedSamType()] = $("#settingsSamModel").value.trim(); }

function selectSamVariant(variant, refresh = false) {
  if (!Object.hasOwn(samCheckpointPaths, variant)) return;
  storeSelectedSamPath();
  $("#settingsSamType").value = variant;
  document.querySelectorAll('input[name="settingsSamVariant"]').forEach((radio) => { radio.checked = radio.value === variant; });
  $("#settingsSamModel").value = samCheckpointPaths[variant] || "";
  if (refresh) void refreshSettingsStatus();
}

function renderSamVariantStatuses() {
  const hasVariants = Boolean(state.settingsStatus && Object.hasOwn(state.settingsStatus, "samVariants"));
  const variants = state.settingsStatus?.samVariants;
  for (const output of document.querySelectorAll("[data-sam-status]")) {
    const row = output.closest(".sam-variant");
    if (!hasVariants || !variants || typeof variants !== "object") {
      output.textContent = "";
      output.removeAttribute("data-state");
      row?.classList.remove("unacquired");
      continue;
    }
    const variant = variants[output.dataset.samStatus];
    let key = "notAcquired"; let stateName = "empty";
    if (variant?.valid) { key = variant.managed ? "downloaded" : "external"; stateName = "ready"; }
    else if (variant?.reasonCode === "missing") { key = "missing"; stateName = "error"; }
    else if (variant?.reasonCode === "type_mismatch") { key = "typeMismatch"; stateName = "error"; }
    else if (variant?.reasonCode === "invalid_format") { key = "invalidFormat"; stateName = "error"; }
    output.textContent = t(`settings.samStatus.${key}`); output.dataset.state = stateName;
    row?.classList.toggle("unacquired", stateName === "empty");
  }
}

function gpuMemoryLabel(totalMemory) {
  const gib = Number(totalMemory) / (1024 ** 3);
  if (!Number.isFinite(gib) || gib <= 0) return "";
  const rounded = Math.round(gib);
  return Math.abs(gib - rounded) < 0.1 ? String(rounded) : gib.toFixed(1);
}

const MODEL_TOGGLE_IDS = { ntd11: "#settingsNtd11Toggle", sensitive: "#settingsSensitiveToggle", hand_detection: "#settingsHandToggle", hand_segmentation: "#settingsHandSegmentationToggle" };

function setModelCardEnabled(key, enabled) {
  const toggle = $(MODEL_TOGGLE_IDS[key]);
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

function setHandSegmentationAvailable(enabled) {
  const toggle = $(MODEL_TOGGLE_IDS.hand_segmentation);
  if (!enabled) setModelCardEnabled("hand_segmentation", false);
  toggle.disabled = !enabled;
  $("#settingsHandSegmentationModel").disabled = !enabled;
  document.querySelectorAll('[data-model-input="settingsHandSegmentationModel"]').forEach((button) => { button.disabled = !enabled; });
}

function modelCardEnabled(key) {
  return key === "hand_segmentation"
    ? modelCardEnabled("hand_detection") && Boolean($(MODEL_TOGGLE_IDS[key]).checked)
    : Boolean($(MODEL_TOGGLE_IDS[key]).checked);
}

function setPrecisionDetectionEnabled(enabled) {
  const toggle = $("#settingsPrecisionToggle");
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

function setFluidExclusionEnabled(enabled) {
  const toggle = $("#settingsFluidToggle");
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

const TOOL_POSITIONS = new Set(["left", "top", "right", "bottom"]);

function normaliseToolPosition(position) { return TOOL_POSITIONS.has(position) ? position : "left"; }
function toolRailItems() { return ["#brushTool", "#eraserTool", "#boundaryTool", "#fitButton", "#undoButton", "#redoButton", "#mosaicPreviewButton"].map($); }

function setToolRailTabStop(activeItem = null) {
  const items = toolRailItems().filter((item) => !item.disabled);
  if (!items.length) return;
  const selected = items.includes(activeItem) ? activeItem : items.find((item) => item.tabIndex === 0) || items[0];
  items.forEach((item) => { item.tabIndex = item === selected ? 0 : -1; });
}

function applyToolPosition(position) {
  const nextPosition = normaliseToolPosition(position);
  closeBoundaryModeMenu();
  stage.dataset.toolPosition = nextPosition;
  toolRail.setAttribute("aria-orientation", ["left", "right"].includes(nextPosition) ? "vertical" : "horizontal");
  setToolRailTabStop(document.activeElement);
}

function handleToolRailKeydown(event) {
  if ($("#boundaryModeMenu").contains?.(event.target)) return;
  const items = toolRailItems().filter((item) => !item.disabled);
  const current = items.indexOf(event.target);
  if (current < 0) return;
  const vertical = toolRail.getAttribute("aria-orientation") === "vertical";
  let next = current;
  if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = (current + 1) % items.length;
  else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = (current - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else return;
  event.preventDefault();
  setToolRailTabStop(items[next]);
  focusElement(items[next]);
}

function renderSettingsStatus(status) {
  state.settingsStatus = status;
  const gpuSelect = $("#settingsGpuDevice");
  const selected = gpuSelect.value || String(state.settings?.models?.gpu_device ?? 0);
  const configured = String(state.settings?.models?.gpu_device ?? 0);
  gpuSelect.textContent = "";
  const gpus = status?.gpus || [];
  if (!gpus.length) { const option = document.createElement("option"); option.value = configured; option.textContent = `GPU ${configured}`; option.disabled = true; gpuSelect.append(option); }
  else for (const gpu of gpus) {
    const option = document.createElement("option"); option.value = String(gpu.id);
    const memory = gpuMemoryLabel(gpu.totalMemory);
    option.textContent = `GPU ${gpu.id}: ${gpu.name}${memory ? ` / VRAM: ${memory} GB` : ""}${gpu.supported === false ? ` (${t("settings.gpuUnsupported")})` : ""}`;
    option.disabled = gpu.supported === false; gpuSelect.append(option);
  }
  if (![...gpuSelect.children].some((option) => option.value === selected)) {
    const option = document.createElement("option"); option.value = selected; option.textContent = `GPU ${selected}: ${t("settings.gpuUnavailable")}`; option.disabled = true; gpuSelect.append(option);
  }
  gpuSelect.value = selected;
  renderModelStatus();
}

function syncProviderSelection() {
  $("#settingsGpuDevice").disabled = $("#settingsProvider").value === "cpu";
}

function setSettingsForm(settings, status = null) {
  state.settings = settings;
  $("#settingsLanguage").value = settings.general.language;
  $("#settingsOpenBrowser").checked = settings.general.open_browser;
  $("#settingsPort").value = String(settings.general.port);
  $("#settingsImportParallelism").value = String(settings.importing?.parallelism || 3);
  $("#settingsSaveParallelism").value = String(settings.saving?.parallelism || 2);
  $("#settingsShortcutsEnabled").checked = settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled;
  renderOutputDirectory();
  setNavigationShortcutsEnabled(settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled);
  $("#settingsTargetModel").value = settings.models.target_segmentation;
  $("#settingsNtd11Model").value = settings.models.ntd11;
  setModelCardEnabled("ntd11", settings.models.ntd11_enabled);
  $("#settingsSensitiveModel").value = settings.models.sensitive;
  setModelCardEnabled("sensitive", settings.models.sensitive_enabled);
  $("#settingsHandModel").value = settings.models.hand_detection;
  setModelCardEnabled("hand_detection", settings.models.hand_detection_enabled);
  $("#settingsHandSegmentationModel").value = settings.models.hand_segmentation || "";
  setModelCardEnabled("hand_segmentation", settings.models.hand_segmentation_enabled);
  setHandSegmentationAvailable(settings.models.hand_detection_enabled);
  samCheckpointPaths = { vit_b: "", vit_l: "", vit_h: "", ...(settings.models.sam_checkpoints || {}) };
  setPrecisionDetectionEnabled(settings.detection.mode === "high_precision");
  setFluidExclusionEnabled(settings.detection.fluid_exclusion_enabled);
  $("#settingsExcludeForcedDefault").checked = settings.detection.exclude_forced_default !== false;
  $("#settingsSamType").value = settings.models.sam_model_type;
  document.querySelectorAll('input[name="settingsSamVariant"]').forEach((radio) => { radio.checked = radio.value === settings.models.sam_model_type; });
  $("#settingsSamModel").value = samCheckpointPaths[settings.models.sam_model_type] || settings.models.sam_checkpoint || "";
  $("#settingsProvider").value = settings.models.provider;
  syncProviderSelection();
  $("#settingsApplyColor").value = settings.display.apply_color;
  $("#settingsExcludeColor").value = settings.display.exclude_color;
  $("#settingsOpacity").value = settings.display.overlay_opacity;
  $("#settingsMosaicPreview").checked = settings.display.mosaic_preview;
  $("#settingsToolPosition").value = normaliseToolPosition(settings.display.tool_position);
  applyToolPosition(settings.display.tool_position);
  state.mosaicPreviewEnabled = settings.display.mosaic_preview;
  $("#mosaicPreviewButton").classList.toggle("active", state.mosaicPreviewEnabled);
  $("#mosaicPreviewButton").setAttribute("aria-pressed", String(state.mosaicPreviewEnabled));
  setDetectionConfidence(settings.detection.threshold);
  $("#detectParallelism").value = String(settings.detection.parallelism);
  setDetectionTargets(settings.detection.targets);
  $("#confirmClearMasks").checked = settings.confirmations?.clearMasks !== false;
  $("#confirmClearCatalog").checked = settings.confirmations?.clearCatalog !== false;
  $("#confirmRemoveImage").checked = settings.confirmations?.removeImage !== false;
  $("#confirmCandidateDelete").checked = settings.confirmations?.candidateDelete !== false;
  $("#confirmCandidateRoleDelete").checked = settings.confirmations?.candidateRoleDelete !== false;
  $("#confirmOverwriteSource").checked = settings.confirmations?.overwriteSource !== false;
  $("#confirmDeleteSourceAfterCopy").checked = settings.confirmations?.deleteSourceAfterCopy !== false;
  renderShortcutBindings(settings.shortcuts?.bindings || {}, settings.shortcuts?.actions || {});
  renderSettingsStatus(status);
}

const SHORTCUT_LABELS = { previous: "settings.shortcut.previous", next: "settings.shortcut.next", previousVisible: "settings.shortcut.previousVisible", nextVisible: "settings.shortcut.nextVisible", first: "settings.shortcut.first", last: "settings.shortcut.last", reviewAndNext: "settings.shortcut.reviewAndNext", toggleOverview: "settings.shortcut.toggleOverview", undo: "settings.shortcut.undo", redo: "settings.shortcut.redo" };
function renderShortcutBindings(bindings, actions) {
  const root = $("#shortcutBindings"); root.textContent = "";
  for (const [action, labelKey] of Object.entries(SHORTCUT_LABELS)) {
    const row = document.createElement("label"); row.className = "form-row"; const text = document.createElement("span"); text.textContent = t(labelKey);
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.dataset.shortcutEnabled = action; enabled.checked = actions[action] !== false;
    const input = document.createElement("input"); input.type = "text"; input.dataset.shortcutAction = action; input.value = bindings[action] || ""; input.autocomplete = "off";
    input.addEventListener("keydown", (event) => { event.preventDefault(); input.value = shortcutFromEvent(event); }); row.append(text, enabled, input); root.append(row);
  }
}
function shortcutFromEvent(event) { return `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${event.altKey ? "Alt+" : ""}${event.key.length === 1 ? event.key.toUpperCase() : event.key}`; }
function shortcutBindingsPayload() {
  const bindings = Object.fromEntries([...document.querySelectorAll("[data-shortcut-action]")].map((input) => [input.dataset.shortcutAction, input.value.trim()]));
  if (!Object.values(bindings).every(Boolean) || new Set(Object.values(bindings)).size !== Object.keys(bindings).length) throw new Error("ショートカットのキーは重複なく設定してください。");
  return bindings;
}
function shortcutActionsPayload() { return Object.fromEntries([...document.querySelectorAll("[data-shortcut-enabled]")].map((input) => [input.dataset.shortcutEnabled, input.checked])); }

function settingsPayload() {
  storeSelectedSamPath();
  return {
    general: { ...state.settings.general, language: $("#settingsLanguage").value, open_browser: $("#settingsOpenBrowser").checked, port: Number($("#settingsPort").value), shortcuts_enabled: $("#settingsShortcutsEnabled").checked },
    models: {
      target_segmentation: $("#settingsTargetModel").value.trim(), ntd11: $("#settingsNtd11Model").value.trim(), ntd11_enabled: modelCardEnabled("ntd11"),
      sensitive: $("#settingsSensitiveModel").value.trim(), sensitive_enabled: modelCardEnabled("sensitive"),
      hand_detection: $("#settingsHandModel").value.trim(), hand_detection_enabled: modelCardEnabled("hand_detection"),
      hand_segmentation: $("#settingsHandSegmentationModel").value.trim(), hand_segmentation_enabled: modelCardEnabled("hand_segmentation"),
      sam_checkpoints: { ...samCheckpointPaths }, sam_model_type: selectedSamType(), provider: $("#settingsProvider").value, gpu_device: Number($("#settingsGpuDevice").value),
    },
    display: {
      apply_color: $("#settingsApplyColor").value, exclude_color: $("#settingsExcludeColor").value,
      overlay_opacity: Number($("#settingsOpacity").value), mosaic_preview: $("#settingsMosaicPreview").checked,
      tool_position: $("#settingsToolPosition").value,
    },
    importing: { parallelism: normaliseImportParallelism($("#settingsImportParallelism").value) },
    detection: {
      threshold: normaliseDetectionConfidence($("#detectConfidenceNumber").value),
      parallelism: detectionParallelism(),
      mode: $("#settingsPrecisionToggle").checked ? "high_precision" : "standard",
      fluid_exclusion_enabled: $("#settingsFluidToggle").checked,
      exclude_forced_default: $("#settingsExcludeForcedDefault").checked, targets: detectionTargets(),
    },
    saving: {
      parallelism: Math.min(8, Math.max(1, Math.round(Number($("#settingsSaveParallelism").value) || 2))),
      default_output_directory: $("#settingsDefaultOutputDirectory").value.trim(),
    },
    shortcuts: { enabled: $("#settingsShortcutsEnabled").checked, bindings: shortcutBindingsPayload(), actions: shortcutActionsPayload() },
    confirmations: { clearMasks: $("#confirmClearMasks").checked, clearCatalog: $("#confirmClearCatalog").checked, removeImage: $("#confirmRemoveImage").checked, candidateDelete: $("#confirmCandidateDelete").checked, candidateRoleDelete: $("#confirmCandidateRoleDelete").checked, overwriteSource: $("#confirmOverwriteSource").checked, deleteSourceAfterCopy: $("#confirmDeleteSourceAfterCopy").checked },
  };
}

function selectSettingsTab(name) {
  const tabs = [...document.querySelectorAll(".settings-tab")];
  const nextTab = tabs.find((button) => button.dataset.settingsTab === name);
  if (!nextTab) return;
  const activeTab = tabs.find((button) => button.classList.contains("active"));
  const changed = activeTab && activeTab !== nextTab;
  tabs.forEach((button) => {
    const active = button.dataset.settingsTab === name;
    button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
  if (changed) { const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error"); }
}

function moveSettingsTab(event) {
  const tabs = [...document.querySelectorAll(".settings-tab")];
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0) return;
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  selectSettingsTab(tabs[next].dataset.settingsTab);
  focusElement(tabs[next]);
}

async function openSettings() {
  if (isBusy()) return;
  if (!state.settings) {
    try {
      const data = await api("/api/settings?status=0");
      setSettingsForm(data.settings);
      $("#settingsVersion").textContent = data.version;
    } catch (error) { setStatus(error.message, "error"); return; }
  }
  setSettingsForm(state.settings, state.settingsStatus);
  selectSettingsTab("general"); $("#settingsResult").textContent = ""; $("#settingsDialog").showModal();
  void refreshSettingsStatus();
}

async function saveSettings(event) {
  event.preventDefault();
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings?status=0", { method: "POST", body: JSON.stringify(settingsPayload()) });
    const languageChanged = state.settings?.general?.language !== data.settings.general.language;
    setSettingsForm(data.settings);
    $("#settingsVersion").textContent = data.version;
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    if (languageChanged) await loadTranslations();
    result.textContent = t("settings.saved");
    void refreshSettingsStatus();
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

async function resetSettings() {
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings/reset?status=0", { method: "POST", body: JSON.stringify({}) });
    setSettingsForm(data.settings);
    $("#settingsVersion").textContent = data.version;
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    await loadTranslations();
    result.textContent = t("settings.resetDone");
    void refreshSettingsStatus();
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

async function chooseSettingsOutputDirectory() {
  try {
    const directory = await pickOutputDirectory();
    if (directory) $("#settingsDefaultOutputDirectory").value = directory;
  } catch (error) {
    if (error?.name !== "AbortError") { $("#settingsResult").textContent = error.message; $("#settingsResult").classList.add("error"); }
  }
}

function samTypeFromPath(path) {
  const match = /(?:^|[_-])vit[_-]?([blh])(?:[_.-]|$)/i.exec(path.split(/[\\/]/).pop() || "");
  return match ? `vit_${match[1].toLowerCase()}` : null;
}

async function chooseSettingsModelFile(button) {
  const buttons = [...document.querySelectorAll("[data-model-picker]")];
  buttons.forEach((item) => { item.disabled = true; });
  try {
    const input = $(`#${button.dataset.modelInput}`);
    const data = await api("/api/model-file/pick", { method: "POST", body: JSON.stringify({ modelKey: button.dataset.modelPicker, currentPath: input.value }) });
    if (!data.cancelled && data.path) {
      if (button.dataset.modelPicker === "sam_checkpoint") {
        storeSelectedSamPath();
        const variant = samTypeFromPath(data.path) || selectedSamType();
        selectSamVariant(variant);
        samCheckpointPaths[variant] = data.path;
        $("#settingsSamModel").value = data.path;
      } else input.value = data.path;
      void refreshSettingsStatus();
    }
  } catch (error) {
    $("#settingsResult").textContent = error.message;
    $("#settingsResult").classList.add("error");
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
    setHandSegmentationAvailable(Boolean($(MODEL_TOGGLE_IDS.hand_detection).checked));
  }
}

let modelDownloadPoll = null;
let pendingModelDownloadKey = null;
let modelDownloadStatusRefreshPending = false;

function modelDownloadInput(settingKey) {
  return {
    target_segmentation: "#settingsTargetModel", sam_checkpoint: "#settingsSamModel",
    hand_detection: "#settingsHandModel", hand_segmentation: "#settingsHandSegmentationModel",
  }[settingKey];
}

function renderModelDownload(job) {
  const progress = $("#modelDownloadProgress"); const status = $("#modelDownloadStatus");
  const expected = Number(job.expected) || 1; const received = Number(job.received) || 0;
  progress.max = expected; progress.value = Math.min(received, expected);
  const labels = {
    target: t("settings.targetModel"), sam_vit_b: "SAM vit_b", sam_vit_l: "SAM vit_l", sam_vit_h: "SAM vit_h",
    hand_detection: t("settings.handModel"), hand_segmentation: t("settings.handSegmentationModel"),
  };
  $("#modelDownloadMessage").textContent = job.current ? t("modelDownload.current", { model: labels[job.current] || job.current, completed: job.completed || 0, total: job.total || 1 }) : "";
  if (job.state === "failed") { status.textContent = job.error || t("modelDownload.failed"); status.classList.add("error"); }
  else if (job.state === "cancelled") { status.textContent = t("modelDownload.cancelled"); status.classList.remove("error"); }
  else if (job.state === "complete") { status.textContent = t("modelDownload.complete"); status.classList.remove("error"); }
  else { status.textContent = ""; status.classList.remove("error"); }
  $("#modelDownloadCancel").hidden = !["running", "cancelling"].includes(job.state);
  $("#modelDownloadStart").hidden = true;
  $("#modelDownloadCommandWrap").hidden = true;
  $("#modelDownloadClose").disabled = ["running", "cancelling"].includes(job.state);
  for (const [settingKey, path] of Object.entries(job.paths || {})) {
    if (settingKey.startsWith("sam_vit_")) {
      const variant = settingKey.slice(4);
      samCheckpointPaths[variant] = path;
      if (selectedSamType() === variant) $("#settingsSamModel").value = path;
    } else {
      const selector = modelDownloadInput(settingKey); if (selector) $(selector).value = path;
    }
  }
  if (["complete", "failed", "cancelled", "idle"].includes(job.state) && modelDownloadPoll) {
    clearInterval(modelDownloadPoll); modelDownloadPoll = null;
  }
  if (job.state === "complete" && modelDownloadStatusRefreshPending) {
    modelDownloadStatusRefreshPending = false;
    void refreshSettingsStatus();
  }
}

function setModelDownloadGuide(command = "") {
  const commandWrap = $("#modelDownloadCommandWrap"); commandWrap.hidden = !command;
  $("#modelDownloadCommand").textContent = command; $("#modelDownloadCopyResult").textContent = "";
}

const MODEL_DOWNLOAD_INFO = {
  target: { name: "01miku/anime-nsfw-segm-yolo26 / NSFW Anime XL", target: "models\\ultralytics\\nsfw-anime-xl-x1280.onnx", source: "Hugging Face", url: "https://huggingface.co/01miku/anime-nsfw-segm-yolo26/tree/1697d5d1827b6a818b350b44bf3ec27f08837a2a" },
  hand_detection: { name: "deepghs/anime_hand_detection / hand_detect_v1.0_s", target: "models\\ultralytics\\anime-hand-v1.0-s.onnx", source: "Hugging Face", url: "https://huggingface.co/deepghs/anime_hand_detection/tree/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s" },
  hand_segmentation: { name: "HandSegNet anime SDXL", target: "models\\handsegnet\\handsegnet_vit_b_best.safetensors", source: "Hugging Face", url: "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/tree/77ff734683306141e56aef9d491958a82508b41a" },
  sam_vit_b: { name: "Meta Segment Anything (SAM) vit_b", target: "models\\sam_vit_b_01ec64.pth", source: "Meta", url: "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth" },
  sam_vit_l: { name: "Meta Segment Anything (SAM) vit_l", target: "models\\sam_vit_l_0b3195.pth", source: "Meta", url: "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_l_0b3195.pth" },
  sam_vit_h: { name: "Meta Segment Anything (SAM) vit_h", target: "models\\sam_vit_h_4b8939.pth", source: "Meta", url: "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth" },
  ntd11: { name: "Anime NSFW Detection / ADetailer All-in-One v5.0-variant1", target: "ntd11_anime_nsfw_segm_v5-variant1.onnx", source: "CivitAI", url: "https://civitai.com/models/1313556?modelVersionId=2350456" },
  sensitive: { name: "sugarknight/sensitive-detect / sensitive_detect_v07", target: "sensitive_detect_v07.pt → sensitive_detect_v07.onnx", source: "Hugging Face", url: "https://huggingface.co/sugarknight/sensitive-detect/tree/b7ec7a528841aac3d52411fb4d031d51a8225e40" },
};

function renderModelDownloadItems(keys) {
  const list = $("#modelDownloadItems"); list.textContent = "";
  for (const key of keys) {
    const info = MODEL_DOWNLOAD_INFO[key];
    const item = document.createElement("li"); item.className = "model-download-item";
    const name = document.createElement("strong"); name.textContent = info.name;
    const details = document.createElement("dl"); details.className = "model-download-details";
    const targetLabel = document.createElement("dt"); targetLabel.textContent = t("modelDownload.destination");
    const target = document.createElement("dd"); const code = document.createElement("code"); code.textContent = info.target; target.append(code);
    const sourceLabel = document.createElement("dt"); sourceLabel.textContent = t("modelDownload.source");
    const source = document.createElement("dd"); const link = document.createElement("a"); link.href = info.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = info.source; source.append(link);
    details.append(targetLabel, target, sourceLabel, source); item.append(name, details); list.append(item);
  }
}

async function refreshModelDownload() {
  try { renderModelDownload(await api("/api/model-download")); } catch (error) {
    if (modelDownloadPoll) { clearInterval(modelDownloadPoll); modelDownloadPoll = null; }
    $("#modelDownloadStatus").textContent = error.message; $("#modelDownloadStatus").classList.add("error");
    $("#modelDownloadCancel").hidden = true; $("#modelDownloadClose").disabled = false;
  }
}

function showUnsupportedModelDownload(key) {
  const sensitive = key === "sensitive";
  const source = key === "ntd11" ? "NTD11" : "Sensitive";
  $("#modelDownloadMessage").textContent = sensitive ? t("modelDownload.sensitive") : t("modelDownload.unsupported", { model: source });
  renderModelDownloadItems([key]);
  $("#modelDownloadProgress").value = 0; $("#modelDownloadProgress").max = 1;
  $("#modelDownloadStatus").textContent = sensitive ? "" : t("modelDownload.unsupportedSource", { source: "CivitAI" });
  setModelDownloadGuide(sensitive ? 'python -m pip install ultralytics\nyolo export model="C:\\...\\sensitive_detect_v07.pt" format=onnx imgsz=1024 simplify=False opset=17 end2end=False device=cpu' : "");
  $("#modelDownloadSecurity").hidden = true;
  $("#modelDownloadStart").hidden = true;
  $("#modelDownloadStatus").classList.remove("error"); $("#modelDownloadCancel").hidden = true; $("#modelDownloadClose").disabled = false;
  const dialog = $("#modelDownloadDialog"); if (!dialog.open) dialog.showModal();
}

function modelDownloadConfirmation(key) {
  const samType = selectedSamType();
  const samKey = `sam_${samType}`;
  const keys = key === "all" ? ["target", samKey, "hand_detection", "hand_segmentation"] : [key === "sam" ? samKey : key];
  pendingModelDownloadKey = key;
  $("#modelDownloadMessage").textContent = t(key === "all" ? "modelDownload.confirmAll" : "modelDownload.confirmOne");
  renderModelDownloadItems(keys);
  $("#modelDownloadSecurity").textContent = t("modelDownload.security"); $("#modelDownloadSecurity").hidden = false;
  setModelDownloadGuide();
  $("#modelDownloadProgress").value = 0; $("#modelDownloadProgress").max = 1;
  $("#modelDownloadStatus").textContent = ""; $("#modelDownloadStatus").classList.remove("error");
  $("#modelDownloadStart").hidden = false; $("#modelDownloadCancel").hidden = true; $("#modelDownloadClose").disabled = false;
  const dialog = $("#modelDownloadDialog"); if (!dialog.open) dialog.showModal();
}

function startModelDownload(key) {
  if (key === "ntd11" || key === "sensitive") return showUnsupportedModelDownload(key);
  modelDownloadConfirmation(key);
}

async function beginModelDownload() {
  const key = pendingModelDownloadKey;
  if (!key) return;
  $("#modelDownloadStatus").textContent = ""; $("#modelDownloadStatus").classList.remove("error");
  $("#modelDownloadProgress").value = 0; $("#modelDownloadProgress").max = 1;
  $("#modelDownloadStart").hidden = true; $("#modelDownloadSecurity").hidden = true;
  modelDownloadStatusRefreshPending = true;
  try {
    const modelKey = key === "sam" ? `sam_${selectedSamType()}` : key;
    const job = await api("/api/model-download/start", { method: "POST", body: JSON.stringify({ modelKey, samType: selectedSamType() }) });
    renderModelDownload(job);
    if (!modelDownloadPoll && ["running", "cancelling"].includes(job.state)) modelDownloadPoll = setInterval(() => { void refreshModelDownload(); }, 350);
  } catch (error) { $("#modelDownloadStatus").textContent = error.message; $("#modelDownloadStatus").classList.add("error"); }
}

async function cancelModelDownload() {
  try { renderModelDownload(await api("/api/model-download/cancel", { method: "POST", body: JSON.stringify({}) })); } catch (error) { $("#modelDownloadStatus").textContent = error.message; $("#modelDownloadStatus").classList.add("error"); }
}

let settingsStatusGeneration = 0;

function setSettingsGpuLoading(loading) {
  $("#settingsGpuLoading").hidden = !loading;
  if (loading) $("#settingsGpuDevice").setAttribute("aria-busy", "true");
  else $("#settingsGpuDevice").removeAttribute("aria-busy");
}

async function refreshSettingsStatus() {
  const generation = ++settingsStatusGeneration;
  const snapshot = JSON.stringify(settingsPayload());
  setSettingsGpuLoading(true);
  try {
    const data = await api("/api/settings/status", { method: "POST", body: snapshot });
    let currentSnapshot = null;
    try { currentSnapshot = JSON.stringify(settingsPayload()); } catch {}
    if (generation !== settingsStatusGeneration || snapshot !== currentSnapshot) return;
    renderSettingsStatus(data.status);
  } catch (error) {
    if (generation === settingsStatusGeneration) setStatus(error.message, "error");
  } finally {
    if (generation === settingsStatusGeneration) setSettingsGpuLoading(false);
  }
}

async function checkForUpdate({ silent = false } = {}) {
  const button = $("#checkUpdateButton"); const result = $("#updateStatus");
  if (!silent) { button.disabled = true; button.textContent = t("update.checking"); result.textContent = t("update.checking"); result.classList.remove("error"); }
  try {
    const update = await api("/api/update/status");
    $("#settingsVersion").textContent = update.current;
    button.textContent = update.available ? t("update.start") : t("update.check");
    button.classList.toggle("primary", update.available); button.dataset.available = String(update.available);
    $("#updateToast").hidden = !update.available;
    if (!silent) result.textContent = update.available ? t("update.available") : t("update.current", { version: update.current });
  } catch (error) {
    if (!silent) { result.textContent = t("update.checkFailed"); result.classList.add("error"); }
  } finally { if (!silent) button.disabled = false; }
}

async function startUpdate() {
  if ($("#checkUpdateButton").dataset.available !== "true") return checkForUpdate();
  if (!await confirmAction(t("update.title"), t("update.message"))) return;
  try { await api("/api/update/start", { method: "POST", body: JSON.stringify({}) }); } catch (error) { $("#settingsResult").textContent = error.message; }
}
