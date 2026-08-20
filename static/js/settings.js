function closeBatchMoreMenus() {
  for (const id of ["#batchMoreMenu"]) {
    const menu = $(id);
    if (menu.matches(":popover-open")) menu.hidePopover();
  }
}

function renderModelStatus() {
  const modelStatus = Object.entries(state.settingsStatus?.models || {});
  const activeModels = modelStatus.filter(([, model]) => model.required === true || model.enabled === true);
  $("#settingsModelStatus").textContent = activeModels.length && activeModels.every(([, model]) => model.valid)
    ? ""
    : activeModels.map(([key, model]) => model.configured && model.detail ? `${key}: ${model.detail}` : "").filter(Boolean).join("\n");
}

const MODEL_TOGGLE_IDS = { ntd11: "#settingsNtd11Toggle", sensitive: "#settingsSensitiveToggle", hand_detection: "#settingsHandToggle" };

function setModelCardEnabled(key, enabled) {
  const toggle = $(MODEL_TOGGLE_IDS[key]);
  toggle.checked = Boolean(enabled);
  toggle.closest?.(".model-card")?.classList.toggle("active", Boolean(enabled));
  const stateLabel = toggle.parentElement?.querySelector?.("[data-switch-state]");
  if (stateLabel) stateLabel.textContent = t(enabled ? "settings.on" : "settings.off");
}

function modelCardEnabled(key) { return Boolean($(MODEL_TOGGLE_IDS[key]).checked); }

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

function setSettingsForm(settings, status = null) {
  state.settings = settings; state.settingsStatus = status;
  $("#settingsLanguage").value = settings.general.language;
  $("#settingsOpenBrowser").checked = settings.general.open_browser;
  $("#settingsPort").value = String(settings.general.port);
  $("#settingsImportParallelism").value = String(settings.importing?.parallelism || 3);
  $("#settingsSaveParallelism").value = String(settings.saving?.parallelism || 2);
  $("#settingsShortcutsEnabled").checked = settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled;
  renderOutputHandle();
  setNavigationShortcutsEnabled(settings.shortcuts?.enabled ?? settings.general.shortcuts_enabled);
  $("#settingsTargetModel").value = settings.models.target_segmentation;
  $("#settingsNtd11Model").value = settings.models.ntd11;
  setModelCardEnabled("ntd11", settings.models.ntd11_enabled);
  $("#settingsSensitiveModel").value = settings.models.sensitive;
  setModelCardEnabled("sensitive", settings.models.sensitive_enabled);
  $("#settingsHandModel").value = settings.models.hand_detection;
  setModelCardEnabled("hand_detection", settings.models.hand_detection_enabled);
  $("#settingsSamModel").value = settings.models.sam_checkpoint;
  setPrecisionDetectionEnabled(settings.detection.mode === "high_precision");
  setFluidExclusionEnabled(settings.detection.fluid_exclusion_enabled);
  $("#settingsSamType").value = settings.models.sam_model_type;
  $("#settingsProvider").value = settings.models.provider;
  const gpuSelect = $("#settingsGpuDevice"); gpuSelect.textContent = "";
  const gpus = status?.gpus || [];
  if (!gpus.length) { const option = document.createElement("option"); option.value = "0"; option.textContent = "GPU 0"; gpuSelect.append(option); }
  else for (const gpu of gpus) { const option = document.createElement("option"); option.value = String(gpu.id); option.textContent = `GPU ${gpu.id}: ${gpu.name}`; gpuSelect.append(option); }
  gpuSelect.value = String(settings.models.gpu_device || 0);
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
  renderModelStatus();
}

const SHORTCUT_LABELS = { previous: "←", next: "→", previousVisible: "↑", nextVisible: "↓", first: "Home", last: "End", nextUnreviewed: "次へ", reviewAndNext: "確認済にして次へ", toggleOverview: "一覧切替", undo: "Undo", redo: "Redo" };
function renderShortcutBindings(bindings, actions) {
  const root = $("#shortcutBindings"); root.textContent = "";
  for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
    const row = document.createElement("label"); row.className = "form-row"; const text = document.createElement("span"); text.textContent = label;
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
  return {
    general: { ...state.settings.general, language: $("#settingsLanguage").value, open_browser: $("#settingsOpenBrowser").checked, port: Number($("#settingsPort").value), shortcuts_enabled: $("#settingsShortcutsEnabled").checked },
    models: {
      target_segmentation: $("#settingsTargetModel").value.trim(), ntd11: $("#settingsNtd11Model").value.trim(), ntd11_enabled: modelCardEnabled("ntd11"),
      sensitive: $("#settingsSensitiveModel").value.trim(), sensitive_enabled: modelCardEnabled("sensitive"),
      hand_detection: $("#settingsHandModel").value.trim(), hand_detection_enabled: modelCardEnabled("hand_detection"),
      sam_checkpoint: $("#settingsSamModel").value.trim(), sam_model_type: $("#settingsSamType").value, provider: $("#settingsProvider").value, gpu_device: Number($("#settingsGpuDevice").value),
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
      fluid_exclusion_enabled: $("#settingsFluidToggle").checked, targets: detectionTargets(),
    },
    saving: { parallelism: Math.min(8, Math.max(1, Math.round(Number($("#settingsSaveParallelism").value) || 2))) },
    shortcuts: { enabled: $("#settingsShortcutsEnabled").checked, bindings: shortcutBindingsPayload(), actions: shortcutActionsPayload() },
    confirmations: { clearMasks: $("#confirmClearMasks").checked, clearCatalog: $("#confirmClearCatalog").checked, removeImage: $("#confirmRemoveImage").checked, candidateDelete: $("#confirmCandidateDelete").checked, candidateRoleDelete: $("#confirmCandidateRoleDelete").checked, overwriteSource: $("#confirmOverwriteSource").checked, deleteSourceAfterCopy: $("#confirmDeleteSourceAfterCopy").checked },
  };
}

function selectSettingsTab(name) {
  document.querySelectorAll(".settings-tab").forEach((button) => {
    const active = button.dataset.settingsTab === name;
    button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
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
  try {
    const data = await api("/api/settings");
    setSettingsForm(data.settings, data.status);
    selectSettingsTab("general"); $("#settingsResult").textContent = ""; $("#settingsDialog").showModal();
  } catch (error) { setStatus(error.message, "error"); }
}

async function saveSettings(event) {
  event.preventDefault();
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings", { method: "POST", body: JSON.stringify(settingsPayload()) });
    const languageChanged = state.settings?.general?.language !== data.settings.general.language;
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    if (languageChanged) await loadTranslations();
    result.textContent = t("settings.saved");
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

async function resetSettings() {
  const result = $("#settingsResult"); result.textContent = ""; result.classList.remove("error");
  try {
    const data = await api("/api/settings/reset", { method: "POST", body: JSON.stringify({}) });
    setSettingsForm(data.settings, data.status);
    setNavigationShortcutsEnabled(data.settings.general.shortcuts_enabled);
    setMosaicPreviewEnabled(data.settings.display.mosaic_preview);
    await loadTranslations();
    result.textContent = t("settings.resetDone");
  } catch (error) { result.textContent = error.message; result.classList.add("error"); }
}

async function chooseSettingsOutputDirectory() {
  try {
    await selectOutputDirectory();
  } catch (error) {
    if (error?.name !== "AbortError") { $("#settingsResult").textContent = error.message; $("#settingsResult").classList.add("error"); }
  }
}

async function checkForUpdate() {
  try {
    const update = await api("/api/update/status");
    $("#settingsVersion").textContent = update.current;
    const button = $("#checkUpdateButton"); button.textContent = update.available ? t("update.start") : t("update.check");
    button.classList.toggle("primary", update.available); button.dataset.available = String(update.available);
    $("#updateToast").hidden = !update.available;
  } catch { /* Offline update checks stay quiet. */ }
}

async function startUpdate() {
  if ($("#checkUpdateButton").dataset.available !== "true") return checkForUpdate();
  if (!await confirmAction(t("update.title"), t("update.message"))) return;
  try { await api("/api/update/start", { method: "POST", body: JSON.stringify({}) }); } catch (error) { $("#settingsResult").textContent = error.message; }
}

