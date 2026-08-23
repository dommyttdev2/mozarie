const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==", "base64");

function startFixtureServer() {
  const detectRequests = [];
  const applyRequests = [];
  const settingsRequests = [];
  const settingsActions = [];
  const settingsStatusRequests = [];
  const updateRequests = [];
  const modelPickerRequests = [];
  const modelDownloadRequests = [];
  let modelDownloadJobs = 0;
  let modelDownloadPolls = 0;
  let modelDownloadJob = { state: "idle", paths: {} };
  let failModelDownloadStatus = false;
  let cancelRequests = 0;
  let holdDetection = false;
  let cancelShouldFail = false;
  let releaseFullSettings = null;
  let deferFullSettings = false;
  let currentJob = { kind: "idle", state: "idle" };
  const settings = {
    general: { language: "ja", open_browser: false, port: 8766, shortcuts_enabled: true },
    models: { target_segmentation: "", ntd11: "", ntd11_enabled: false, sensitive: "", sensitive_enabled: false, hand_detection: "", hand_detection_enabled: false, sam_checkpoint: "", sam_model_type: "vit_b", provider: "gpu", gpu_device: 0 },
    display: { apply_color: "#ff3d4d", exclude_color: "#28d3ff", overlay_opacity: 0.78, mosaic_preview: true, tool_position: "left" },
    importing: { parallelism: 3 }, saving: { parallelism: 2 },
    detection: { mode: "standard", fluid_exclusion_enabled: true, exclude_forced_default: true, threshold: 0.5, parallelism: 2, targets: ["penis", "pussy"] },
    shortcuts: {
      enabled: true,
      bindings: { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", reviewAndNext: "Enter", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" },
      actions: {},
    }, confirmations: {},
  };
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    if (requestPath === "/api/settings/reset" && request.method === "POST") {
      settingsActions.push({ path: requestPath, method: request.method });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ settings, version: "v1.0.0" }));
      return;
    }
    if (requestPath === "/api/settings") {
      settingsRequests.push(requestUrl.search);
      if (request.method === "POST") settingsActions.push({ path: requestPath, method: request.method });
      const reply = () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ settings, version: "v1.0.0", status: { models: {}, gpus: [] } })); };
      if (!requestUrl.search && deferFullSettings) { await new Promise((resolve) => { releaseFullSettings = () => { reply(); resolve(); }; }); return; }
      reply();
      return;
    }
    if (requestPath === "/api/settings/status" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const submittedSettings = JSON.parse(body);
      settingsStatusRequests.push(submittedSettings);
      const reply = () => {
        const gpus = submittedSettings.models.target_segmentation === "gpu-options.onnx"
          ? [{ id: 3, name: "RTX Test", supported: true }, { id: 4, name: "Legacy Test", supported: false }]
          : [{ id: settingsStatusRequests.length, name: submittedSettings.models.target_segmentation || "default" }];
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: { models: {}, gpus } }));
      };
      if (deferFullSettings) { await new Promise((resolve) => { releaseFullSettings = () => { reply(); resolve(); }; }); return; }
      reply();
      return;
    }
    if (requestPath === "/api/images") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        images: [
          { id: "sample", relativePath: "sample.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
          { id: "sample-two", relativePath: "sample-two.png", sourceKind: "filesystem", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 },
        ],
        root: "G:/fixture",
      }));
      return;
    }
    if (requestPath === "/api/job") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(currentJob));
      return;
    }
    if (requestPath === "/api/update/status") {
      updateRequests.push(requestUrl.search);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ current: "v1.0.0", latest: "v1.0.0", available: false }));
      return;
    }
    if (requestPath === "/api/model-file/pick" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      modelPickerRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(modelPickerRequests.length === 1 ? { path: "C:\\models\\sam_vit_l_0b3195.pth" } : { cancelled: true }));
      return;
    }
    if (requestPath === "/api/model-download" && request.method === "GET") {
      modelDownloadPolls += 1;
      if (failModelDownloadStatus) {
        response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "fixture status unavailable" }));
        return;
      }
      if (modelDownloadJob.state === "running") {
        const paths = modelDownloadJob.key === "all"
          ? { target_segmentation: "C:\\Mozarie\\models\\ultralytics\\nsfw-anime-xl-x1280.onnx", sam_checkpoint: `C:\\Mozarie\\models\\sam_vit_${modelDownloadJob.samType}_checkpoint.pth`, hand_detection: "C:\\Mozarie\\models\\ultralytics\\anime-hand-v1.0-s.onnx", hand_segmentation: "C:\\Mozarie\\models\\handsegnet\\handsegnet_vit_b_best.safetensors" }
          : { target_segmentation: "C:\\Mozarie\\models\\ultralytics\\nsfw-anime-xl-x1280.onnx" };
        modelDownloadJob = { ...modelDownloadJob, state: "complete", current: "", completed: modelDownloadJob.total, received: modelDownloadJob.expected, paths };
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/model-download/start" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); modelDownloadRequests.push(payload);
      if (payload.modelKey === "hand_detection") {
        modelDownloadJob = { state: "failed", paths: {}, error: "fixture download failed" };
      } else if (modelDownloadJob.state !== "running") {
        modelDownloadJobs += 1;
        modelDownloadJob = { state: "running", key: payload.modelKey, samType: payload.samType, total: payload.modelKey === "all" ? 4 : 1, completed: 0, current: payload.modelKey === "all" ? "target" : payload.modelKey, received: 1, expected: 10, paths: {} };
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/model-download/cancel" && request.method === "POST") {
      modelDownloadJob = { ...modelDownloadJob, state: "cancelled", current: "" };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(modelDownloadJob));
      return;
    }
    if (requestPath === "/api/job/cancel" && request.method === "POST") {
      cancelRequests += 1;
      if (cancelShouldFail) { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "cancel failed" })); return; }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(currentJob));
      return;
    }
    if (requestPath === "/api/detect" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      detectRequests.push(JSON.parse(body));
      const imageIds = detectRequests.at(-1).imageIds;
      currentJob = holdDetection
        ? { kind: "detect", state: "running", total: imageIds.length, completed: 0, current: "sample.png", startedAt: Date.now() / 1000, imageIds, completedImageIds: [] }
        : { kind: "detect", state: "complete", total: imageIds.length, completed: imageIds.length, current: "", startedAt: Date.now() / 1000, imageIds, completedImageIds: imageIds };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/apply" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const apply = JSON.parse(body);
      applyRequests.push(apply);
      currentJob = {
        kind: "apply", state: "running", total: apply.imageIds.length, completed: 0, current: "sample.png",
        startedAt: Date.now() / 1000, imageIds: apply.imageIds, completedImageIds: [], removeAfterSave: Boolean(apply.removeAfterSave),
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath.startsWith("/api/candidates/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ candidates: [], candidateRevision: 0 }));
      return;
    }
    if (requestPath.startsWith("/api/image/")) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": onePixelPng.length });
      response.end(onePixelPng);
      return;
    }
    if (requestPath.startsWith("/api/thumbnail/")) {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }

    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(staticRoot, relativePath);
    if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, detectRequests, applyRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs: () => modelDownloadJobs, modelDownloadPolls: () => modelDownloadPolls, cancelRequests: () => cancelRequests, holdDetection: (value) => { holdDetection = value; }, failCancel: (value) => { cancelShouldFail = value; }, failModelDownloadStatus: (value) => { failModelDownloadStatus = value; }, resetModelDownload: () => { modelDownloadJob = { state: "idle", paths: {} }; }, resetJob: () => { currentJob = { kind: "idle", state: "idle" }; }, finishApply: () => { currentJob = { ...currentJob, state: "complete", completed: currentJob.total, current: "", completedImageIds: currentJob.imageIds }; }, deferFullSettings: () => { deferFullSettings = true; }, releaseFullSettings: () => { deferFullSettings = false; releaseFullSettings?.(); } });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function overlaps(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

async function assertVisibleButtons(page, label) {
  const viewport = page.viewportSize();
  const buttons = await page.evaluate(() => [...document.querySelectorAll("button")].map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      visible: !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      id: element.id || element.textContent.trim(), text: element.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow,
    };
  }).filter((button) => button.visible));
  for (const button of buttons) {
    assert.ok(button.x >= -1 && button.y >= -1, `${button.id} must not start outside ${label}`);
    assert.ok(button.x + button.width <= viewport.width + 1, `${button.id} must not extend outside ${label}`);
    assert.ok(button.y + button.height <= viewport.height + 1, `${button.id} must not extend below ${label}`);
  }
  for (let index = 0; index < buttons.length; index += 1) for (let other = index + 1; other < buttons.length; other += 1) {
    assert.equal(overlaps(buttons[index], buttons[other]), false, `${buttons[index].id} and ${buttons[other].id} overlap at ${label}`);
  }
}

async function assertDesktopLayout(page, width, height) {
  await page.setViewportSize({ width, height });
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `horizontal overflow at ${width}x${height}`);
  await assertVisibleButtons(page, `${width}x${height} edit`);
  const appbar = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const hit = (selector) => { const rect = box(selector); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id === selector.slice(1); };
    return { appbar: box(".appbar"), settings: box("#settingsButton"), status: box("#status"), statusHidden: document.querySelector("#statusLine").hidden, hits: ["#pickFolder", "#settingsButton", "#detectAllButton", "#saveAllButton", "#batchMoreButton"].every(hit) };
  });
  assert.ok(appbar.appbar.right - appbar.settings.right <= 12, `settings stays at the header right edge at ${width}x${height}`);
  if (!appbar.statusHidden) assert.ok(appbar.status.top >= appbar.appbar.bottom, `status stays outside the header at ${width}x${height}`);
  assert.equal(appbar.hits, true, `key appbar and gallery buttons own their hit targets at ${width}x${height}`);
  if (width >= 1280) {
    const heading = await page.evaluate(() => {
      const pane = document.querySelector("#galleryPane").getBoundingClientRect();
      const action = document.querySelector("#batchMoreButton").getBoundingClientRect();
      return { rightGap: pane.right - action.right };
    });
    assert.ok(heading.rightGap <= 12, `all-image actions align with the gallery right edge at ${width}x${height}`);
  }
  assert.equal(await page.locator(".gallery-batch-bar").count(), 0, "the gallery has no inactive batch-edit row");
  await page.locator("#overviewButton").click();
  await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
  await assertVisibleButtons(page, `${width}x${height} overview`);
  const overview = await page.evaluate(() => {
    const toolbar = document.querySelector(".overview-toolbar");
    const bar = document.querySelector("#overviewSelectionBar");
    const button = document.querySelector("#batchModeButton");
    const toolbarRect = toolbar.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      headingTail: button.parentElement.lastElementChild === button,
      followsToolbar: toolbar.nextElementSibling === bar,
      hiddenBarLeavesNoGap: bar.hidden && Math.abs(document.querySelector(".overview-grid-viewport").getBoundingClientRect().top - toolbarRect.bottom) <= 1,
      buttonHit: document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2) === button,
      toolbarBottom: toolbarRect.bottom, barTop: barRect.top,
    };
  });
  assert.equal(overview.headingTail, true, `batch edit ends the overview heading at ${width}x${height}`);
  assert.equal(overview.followsToolbar, true, `selection actions follow the overview toolbar at ${width}x${height}`);
  assert.equal(overview.hiddenBarLeavesNoGap, true, `hidden selection actions leave no overview gap at ${width}x${height}`);
  assert.equal(overview.buttonHit, true, `batch edit owns its physical click target at ${width}x${height}`);
  await page.locator("#batchModeButton").click();
  await assertVisibleButtons(page, `${width}x${height} overview batch`);
  const batchDimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, visible: !document.querySelector("#overviewSelectionBar").hidden }));
  assert.equal(batchDimensions.visible, true, `selection actions become visible in overview batch mode at ${width}x${height}`);
  assert.equal(batchDimensions.scrollWidth, batchDimensions.clientWidth, `batch actions do not create horizontal overflow at ${width}x${height}`);
  await page.locator("#selectionClearButton").click();
  await page.locator("#closeOverviewButton").click();
  await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
}

async function assertConnectionStatusLayout(page, width, height, language) {
  await page.setViewportSize({ width, height });
  await page.evaluate(async (selected) => {
    await loadTranslations(selected);
    setStatusKey("error.connectionLost", {}, "error");
  }, language);
  const layout = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const appbar = box(".appbar");
    const connection = box("#connectionStatus");
    const settings = box("#settingsButton");
    const dimensions = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    return {
      inAppbar: connection.top >= appbar.top && connection.bottom <= appbar.bottom,
      gap: settings.left - connection.right,
      settingsHit: document.elementFromPoint(settings.x + settings.width / 2, settings.y + settings.height / 2) === document.querySelector("#settingsButton"),
      statusLineHidden: document.querySelector("#statusLine").hidden,
      connectionHidden: document.querySelector("#connectionStatus").hidden,
      parentIsAppbar: document.querySelector("#connectionStatus").parentElement === document.querySelector(".appbar"),
      ...dimensions,
    };
  });
  assert.equal(layout.connectionHidden, false, `connection status is visible at ${width}x${height} (${language})`);
  assert.equal(layout.statusLineHidden, true, `connection status does not use the line below the header at ${width}x${height} (${language})`);
  assert.equal(layout.parentIsAppbar && layout.inAppbar && layout.settingsHit, true, `connection status stays in the header and settings stays clickable at ${width}x${height} (${language})`);
  assert.ok(layout.gap >= 0 && layout.gap <= 10, `connection status sits immediately left of settings at ${width}x${height} (${language})`);
  assert.equal(layout.scrollWidth, layout.clientWidth, `connection status does not create horizontal overflow at ${width}x${height} (${language})`);

  await page.evaluate(() => setStatus("Test notification"));
  const general = await page.evaluate(() => {
    const appbar = document.querySelector(".appbar").getBoundingClientRect();
    const status = document.querySelector("#status").getBoundingClientRect();
    return { connectionHidden: document.querySelector("#connectionStatus").hidden, statusLineHidden: document.querySelector("#statusLine").hidden, belowAppbar: status.top >= appbar.bottom };
  });
  assert.equal(general.connectionHidden, true, `ordinary status hides the appbar connection message at ${width}x${height} (${language})`);
  assert.equal(general.statusLineHidden, false, `ordinary status remains below the header at ${width}x${height} (${language})`);
  assert.equal(general.belowAppbar, true, `ordinary status remains outside the header at ${width}x${height} (${language})`);

  await page.evaluate(() => setStatus("Test error", "error"));
  assert.equal(await page.evaluate(() => !document.querySelector("#connectionStatus").hidden && document.querySelector("#statusLine").hidden), true, `every global error uses the header at ${width}x${height} (${language})`);

  await page.evaluate(() => clearStatus());
  assert.equal(await page.evaluate(() => document.querySelector("#connectionStatus").hidden && document.querySelector("#statusLine").hidden), true, `clearing status hides both status areas at ${width}x${height} (${language})`);
}

async function assertSettingsDialogLayout(page, width, height, language) {
  await page.setViewportSize({ width, height });
  await page.locator("#settingsButton").click();
  await page.locator("#settingsTabGeneral").click();
  await page.locator("#settingsLanguage").selectOption(language);
  await page.waitForFunction((selected) => document.documentElement.lang === selected, language);
  const layout = await page.locator("#settingsDialog").evaluate((dialog) => {
    const footer = dialog.querySelector(".dialog-actions");
    const box = (element) => element.getBoundingClientRect();
    const hit = (element) => { const rect = box(element); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element; };
    return {
      fits: dialog.scrollWidth <= dialog.clientWidth,
      reset: hit(footer.querySelector("#settingsResetButton")),
      save: hit(footer.querySelector("#settingsSaveButton")),
      close: hit(dialog.querySelector("#settingsCloseButton")),
    };
  });
  assert.equal(layout.fits, true, `settings does not overflow at ${width}x${height} (${language})`);
  assert.equal(layout.reset && layout.save && layout.close, true, `settings controls own their hit targets at ${width}x${height} (${language})`);
  await page.locator("#settingsTabModels").click();
  const pickerCount = await page.locator("[data-model-picker]").count();
  assert.equal(pickerCount, 6, `all model pickers are available at ${width}x${height} (${language})`);
  const samHelp = page.locator('[data-model-help="samType"]');
  await samHelp.scrollIntoViewIfNeeded();
  assert.equal(await samHelp.evaluate((button) => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button; }), true, `SAM help owns its hit target at ${width}x${height} (${language})`);
  const handTrack = page.locator("#settingsHandCard .model-switch-track");
  if (!await page.locator("#settingsHandToggle").isChecked()) await handTrack.click();
  await page.waitForFunction(() => !document.querySelector("#settingsHandSegmentationToggle").disabled);
  const handSegmentationCard = page.locator("#settingsHandSegmentationCard");
  await handSegmentationCard.scrollIntoViewIfNeeded();
  const readHandSegmentationSwitch = () => page.evaluate(() => {
    const panel = document.querySelector("#settingsPanelModels");
    const card = document.querySelector("#settingsHandSegmentationCard");
    const handCard = document.querySelector("#settingsHandCard");
    const label = card.querySelector(".model-switch");
    const input = label.querySelector("input");
    const track = label.querySelector(".model-switch-track");
    const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const labelRect = rect(label); const inputRect = rect(input);
    return {
      scrollTop: panel.scrollTop,
      card: rect(card),
      handCardHeight: rect(handCard).height,
      label: labelRect,
      track: rect(track),
      input: inputRect,
      inputInsideLabel: inputRect.x >= labelRect.x && inputRect.y >= labelRect.y && inputRect.x + inputRect.width <= labelRect.x + labelRect.width && inputRect.y + inputRect.height <= labelRect.y + labelRect.height,
      checked: input.checked,
      active: card.classList.contains("active"),
      cardClasses: [...card.classList].filter((name) => name !== "active"),
      labelClasses: [...label.classList],
      trackClasses: [...track.classList],
      notes: card.querySelectorAll(".model-card-note").length,
      links: card.querySelectorAll("a").length,
    };
  });
  const beforeHandSegmentationToggle = await readHandSegmentationSwitch();
  assert.equal(beforeHandSegmentationToggle.inputInsideLabel, true, `the HandSeg switch input stays inside its label at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.card.height, beforeHandSegmentationToggle.handCardHeight, `HandSeg and hand cards have the same height at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.notes, 0, `HandSeg has no inline note at ${width}x${height} (${language})`);
  assert.equal(beforeHandSegmentationToggle.links, 0, `HandSeg has no download or project link at ${width}x${height} (${language})`);
  await page.mouse.click(beforeHandSegmentationToggle.label.x + beforeHandSegmentationToggle.label.width - 4, beforeHandSegmentationToggle.label.y + beforeHandSegmentationToggle.label.height / 2);
  await page.waitForFunction((checked) => document.querySelector("#settingsHandSegmentationToggle").checked === checked, !beforeHandSegmentationToggle.checked);
  const afterLabelClick = await readHandSegmentationSwitch();
  assert.equal(afterLabelClick.checked, !beforeHandSegmentationToggle.checked, `a physical HandSeg label click toggles the switch at ${width}x${height} (${language})`);
  assert.equal(afterLabelClick.active, afterLabelClick.checked, `the HandSeg active state follows the switch at ${width}x${height} (${language})`);
  assert.deepEqual({ ...afterLabelClick, checked: false, active: false }, { ...beforeHandSegmentationToggle, checked: false, active: false }, `a HandSeg label click changes no layout or card content at ${width}x${height} (${language})`);
  await page.mouse.click(afterLabelClick.track.x + afterLabelClick.track.width / 2, afterLabelClick.track.y + afterLabelClick.track.height / 2);
  await page.waitForFunction((checked) => document.querySelector("#settingsHandSegmentationToggle").checked === checked, beforeHandSegmentationToggle.checked);
  const afterTrackClick = await readHandSegmentationSwitch();
  assert.equal(afterTrackClick.checked, beforeHandSegmentationToggle.checked, `a physical HandSeg track click toggles the switch at ${width}x${height} (${language})`);
  assert.equal(afterTrackClick.active, afterTrackClick.checked, `the HandSeg active state returns with the switch at ${width}x${height} (${language})`);
  assert.deepEqual({ ...afterTrackClick, checked: false, active: false }, { ...beforeHandSegmentationToggle, checked: false, active: false }, `a HandSeg track click keeps the panel scroll and card geometry unchanged at ${width}x${height} (${language})`);
  const handSegmentationHelp = page.locator('[data-model-help="handSegmentation"]');
  await handSegmentationHelp.focus();
  await handSegmentationHelp.click();
  const handSegmentationHelpText = await page.locator("#modelHelpText").textContent();
  assert.doesNotMatch(handSegmentationHelpText, /handsegnet_vit_b_best\.safetensors|hugging face|ダウンロード|download/i, `HandSeg help is functional rather than a download guide at ${width}x${height} (${language})`);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#modelHelpDialog").isVisible(), false, `Escape closes HandSeg help at ${width}x${height} (${language})`);
  assert.equal(await handSegmentationHelp.evaluate((button) => document.activeElement === button), true, `Escape restores focus to HandSeg help at ${width}x${height} (${language})`);
  await handSegmentationHelp.click();
  await page.locator("#modelHelpCloseButton").click();
  assert.equal(await handSegmentationHelp.evaluate((button) => document.activeElement === button), true, `Close restores focus to HandSeg help at ${width}x${height} (${language})`);
  await page.locator("#settingsCloseButton").click();
}
async function assertToolRailLayout(page, position) {
  await page.locator("#canvasStage").evaluate((stage, selected) => { stage.dataset.toolPosition = selected; }, position);
  const boxes = await page.evaluate(() => {
    const read = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return { rail: read("#canvasToolRail"), settings: read(".canvas-settings-bar"), navigation: read(".canvas-navigation-bar") };
  });
  assert.equal(overlaps(boxes.rail, boxes.settings), false, `${position} rail must not overlap editor settings`);
  assert.equal(overlaps(boxes.rail, boxes.navigation), false, `${position} rail must not overlap image navigation`);
  if (position === "bottom") {
    assert.ok(Math.abs(boxes.rail.y - boxes.navigation.y) <= 2, "bottom tools and image navigation share one compact row");
    assert.ok(boxes.rail.x + boxes.rail.width <= boxes.navigation.x, "bottom navigation uses the horizontal space beside the tools");
  }
  await page.locator("#boundaryTool").click();
  const menu = await page.locator("#boundaryModeMenu").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  if (position === "left") assert.ok(menu.x >= boxes.rail.x + boxes.rail.width, "left rail menu opens right");
  if (position === "right") assert.ok(menu.x + menu.width <= boxes.rail.x, "right rail menu opens left");
  if (position === "top") assert.ok(menu.y >= boxes.rail.y + boxes.rail.height, "top rail menu opens down");
  if (position === "bottom") assert.ok(menu.y + menu.height <= boxes.rail.y, "bottom rail menu opens up");
  await page.keyboard.press("Escape");
}

async function selectFixtureImage(page, pageErrors, consoleErrors) {
  await page.locator('.gallery-item[data-id="sample"]').click();
  try { await page.waitForFunction(() => !document.querySelector("#detectCurrentButton").disabled, null, { timeout: 3000 }); }
  catch (error) {
    const status = await page.locator("#status").textContent();
    throw new Error(`image selection failed; status=${status}; pageErrors=${pageErrors.join(" | ")}; consoleErrors=${consoleErrors.join(" | ")}; cause=${error.message}`);
  }
}

async function main() {
  let server;
  let browser;
  let fixtureUrl;
  let detectRequests, applyRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs, modelDownloadPolls, resetJob, finishApply;
  let settingsRequests;
  let settingsActions;
  let settingsStatusRequests;
  let updateRequests;
  let cancelRequests, holdDetection, failCancel, failModelDownloadStatus, resetModelDownload;
  let deferFullSettings;
  let releaseFullSettings;
  try {
    ({ server, url: fixtureUrl, detectRequests, applyRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, modelDownloadRequests, modelDownloadJobs, modelDownloadPolls, cancelRequests, holdDetection, failCancel, failModelDownloadStatus, resetModelDownload, resetJob, finishApply, deferFullSettings, releaseFullSettings } = await startFixtureServer());
    browser = await chromium.launch();
    const initialPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await initialPage.addInitScript(() => {
      const fetchOriginal = window.fetch;
      window.fetch = (...args) => {
        const url = String(args[0]?.url || args[0]);
        if (url.includes("/api/images")) return new Promise((resolve) => { window.__releaseInitialImages = () => fetchOriginal(...args).then(resolve); });
        return fetchOriginal(...args);
      };
    });
    await initialPage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await initialPage.waitForFunction(() => typeof window.__releaseInitialImages === "function");
    assert.equal(await initialPage.locator("#statusLine").isHidden(), true, "the initial empty catalog has no blank status line");
    assert.equal(await initialPage.locator("#canvasStage").evaluate((stage) => Math.round(stage.getBoundingClientRect().height)), 672, "the hidden status line leaves no 24px gap at 1280x720");
    assert.equal(await initialPage.evaluate(() => typeof setStatus), "function");
    await initialPage.evaluate(() => setStatus("Test notification"));
    assert.equal(await initialPage.locator("#statusLine").isVisible(), true, "setStatus shows the notification line");
    await initialPage.evaluate(() => clearStatus());
    assert.equal(await initialPage.locator("#statusLine").isHidden(), true, "clearStatus hides the notification line again");
    await initialPage.close();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => { window.__openFilesCalled = true; return []; };
      window.showDirectoryPicker = async () => {
        window.__openDirectoryCalled = true;
        return { async *values() {} };
      };
    });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    assert.doesNotMatch(await page.locator("#status").textContent(), /フォルダを選択してください|Choose an image folder/, "the status line never presents the empty-catalog instruction");
    for (const [width, height] of [[1024, 768], [1920, 1080]]) {
      await assertConnectionStatusLayout(page, width, height, "ja");
      await assertConnectionStatusLayout(page, width, height, "en");
    }
    await page.evaluate(() => loadTranslations("ja"));
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, activeElapsed: 10 }));
    assert.match(await page.locator("#processingProgressText").textContent(), /残り約 20秒/, "detection ETA uses active elapsed time after the first completion");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "paused", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "paused detection hides ETA");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "complete", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "terminal detection hides ETA");
    await page.evaluate(() => showProcessing({ kind: "import", state: "running", total: 3, completed: 1, activeElapsed: 10 }));
    assert.doesNotMatch(await page.locator("#processingProgressText").textContent(), /残り約/, "imports never show a detection ETA");
    await page.evaluate(() => closeProcessing());
    const processingLayout = await page.locator("#processingDialog").evaluate((dialog) => ({
      describedBy: dialog.getAttribute("aria-describedby"),
      children: [...dialog.querySelector(".dialog-body").children].map((element) => element.id || element.className),
    }));
    assert.equal(processingLayout.describedBy, "processingProgressText processingCurrent", "the processing dialog describes progress before the current filename");
    assert.deepEqual(processingLayout.children, ["processingTitle", "processingProgress", "processingProgressText", "processingCurrent", "dialog-actions"], "processing shows progress, then the current filename, then actions");
    const processingStateBeforeFilenameChecks = await page.evaluate(() => ({
      images: state.images,
      detectionTargetIds: state.detectionTargetIds,
    }));
    await page.evaluate(() => {
      state.images = [
        { id: "one", relativePath: "001.png" },
        { id: "two", relativePath: "002.png" },
        { id: "three", relativePath: "003.png" },
      ];
      state.detectionTargetIds = ["one", "two", "three"];
    });
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 0, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: [] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "001.png", "detection shows the first unfinished filename rather than the last parallel worker update");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "001.png", "a later completed filename does not move the display ahead of earlier unfinished work");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "paused", total: 3, completed: 2, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["one", "three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "002.png", "paused detection keeps the earliest unfinished filename");
    await page.evaluate(() => closeProcessing());
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 3, completed: 1, current: "legacy.png", completedImageIds: ["one"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "002.png", "legacy detection jobs fall back to the remembered target ids");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "running", total: 1, completed: 0, current: "optimistic.png", imageIds: ["not-in-catalog"], completedImageIds: [] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "optimistic.png", "unmapped active detection targets retain the server filename");
    await page.evaluate(() => showProcessing({ kind: "detect", state: "complete", total: 3, completed: 3, current: "003.png", imageIds: ["one", "two", "three"], completedImageIds: ["one", "two", "three"] }));
    assert.equal(await page.locator("#processingCurrent").textContent(), "", "completed detection has no current filename");
    await page.evaluate((previous) => {
      state.images = previous.images;
      state.detectionTargetIds = previous.detectionTargetIds;
      closeProcessing();
    }, processingStateBeforeFilenameChecks);
    const fullSettingsBeforeOpen = settingsRequests.filter((search) => search === "").length;
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsDialog").isVisible(), true, "settings opens immediately from the cached lightweight response");
    assert.equal(settingsRequests.filter((search) => search === "").length, fullSettingsBeforeOpen, "opening settings does not start a full status request");
    await page.waitForFunction(() => document.querySelector("#settingsStatusButton").disabled === false);
    assert.equal(settingsStatusRequests.length, 1, "opening settings refreshes model and GPU status in the background");
    await page.locator("#settingsTabModels").click();
    await page.locator("#settingsProvider").selectOption("cpu");
    assert.equal(await page.locator("#settingsGpuDevice").isDisabled(), true, "CPU disables the GPU selector");
    await page.locator("#settingsProvider").selectOption("gpu");
    assert.equal(await page.locator("#settingsGpuDevice").isDisabled(), false, "GPU re-enables the GPU selector");
    assert.equal(await page.locator("#settingsHandSegmentationCard .model-card-note").count(), 0, "HandSeg matches the other model cards without an inline explanation");
    assert.equal(await page.locator("#settingsHandSegmentationCard a").count(), 0, "HandSeg keeps download information out of Settings");
    await page.locator('[data-model-help="handSegmentation"]').click();
    assert.doesNotMatch(await page.locator("#modelHelpText").textContent(), /handsegnet_vit_b_best\.safetensors|hugging face|ダウンロード|download/i, "HandSeg help describes the feature without download instructions");
    await page.locator("#modelHelpCloseButton").click();
    await page.locator('[data-model-picker="sam_checkpoint"]').click();
    await page.waitForFunction(() => document.querySelector("#settingsSamModel").value === "C:\\models\\sam_vit_l_0b3195.pth");
    assert.deepEqual(modelPickerRequests.at(-1), { modelKey: "sam_checkpoint", currentPath: "" }, "SAM browse posts its model key and current path");
    assert.equal(await page.locator("#settingsSamType").inputValue(), "vit_l", "known SAM filename synchronizes the model type without saving");
    const targetBeforeCancel = await page.locator("#settingsTargetModel").inputValue();
    const statusBeforeCancel = await page.locator("#settingsResult").textContent();
    const cancelResponse = page.waitForResponse((response) => response.url().includes("/api/model-file/pick") && response.status() === 200);
    await page.locator('[data-model-picker="target_segmentation"]').click();
    await cancelResponse;
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), targetBeforeCancel, "cancelled model browse leaves its input unchanged");
    assert.equal(await page.locator("#settingsResult").textContent(), statusBeforeCancel, "cancelled model browse leaves status unchanged");
    assert.equal(await page.locator("[data-model-download]").count(), 7, "every model and the genital section expose their download action");
    await page.locator('[data-model-download="ntd11"]').click();
    assert.equal(await page.locator("#modelDownloadDialog").isVisible(), true, "unsupported model download opens its own modal");
    assert.match(await page.locator("#modelDownloadMessage").textContent(), /NTD11/, "unsupported download identifies the selected model");
    assert.match(await page.locator("#modelDownloadStatus").textContent(), /GitHub|Hugging Face/, "unsupported download explains its source in the modal");
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="target"]').click();
    assert.equal(modelDownloadRequests.length, 0, "opening a download confirmation does not start a request");
    assert.match(await page.locator("#modelDownloadSecurity").textContent(), /SHA-256/, "confirmation explains the pinned checksum boundary");
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#settingsTargetModel").value.includes("models\\ultralytics\\nsfw-anime-xl-x1280.onnx"));
    assert.deepEqual(modelDownloadRequests.at(-1), { modelKey: "target", samType: "vit_l" }, "individual model download sends only the allowlisted key and selected SAM type");
    assert.match(await page.locator("#modelDownloadStatus").textContent(), /完了|complete/i, "download success is reported inside the modal");
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="hand_detection"]').click();
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent.includes("fixture download failed"));
    assert.match(await page.locator("#modelDownloadStatus").textContent(), /fixture download failed/, "download errors remain inside the download modal");
    await page.locator("#modelDownloadClose").click();
    await page.locator('[data-model-download="all"]').click();
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#settingsHandSegmentationModel").value.includes("models\\handsegnet\\handsegnet_vit_b_best.safetensors"));
    assert.deepEqual(modelDownloadRequests.at(-1), { modelKey: "all", samType: "vit_l" }, "Download all uses the selected SAM type without browser-provided URLs or paths");
    assert.equal(await page.locator("#settingsHandModel").inputValue(), "C:\\Mozarie\\models\\ultralytics\\anime-hand-v1.0-s.onnx", "Download all reflects each completed model path immediately");
    await page.locator("#modelDownloadClose").click();
    const jobsBeforeDoubleClick = modelDownloadJobs();
    const errorsBeforeDoubleStart = pageErrors.length;
    await page.evaluate(() => startModelDownload("sam"));
    await page.waitForFunction(() => document.querySelector("#modelDownloadDialog").open);
    assert.equal(modelDownloadJobs(), jobsBeforeDoubleClick, "confirmation does not create a download job");
    await page.locator("#modelDownloadStart").click();
    assert.equal(modelDownloadJobs(), jobsBeforeDoubleClick + 1, "confirmation starts exactly one download job");
    assert.deepEqual(pageErrors.slice(errorsBeforeDoubleStart), [], "opening and confirming a download does not reopen the dialog");
    await page.locator("#modelDownloadCancel").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent.includes("キャンセル"));
    assert.ok(modelDownloadPolls() >= 2, "download progress is polled while a job is active");
    await page.locator("#modelDownloadClose").click();
    failModelDownloadStatus(true);
    await page.locator('[data-model-download="target"]').click();
    await page.locator("#modelDownloadStart").click();
    await page.waitForFunction(() => document.querySelector("#modelDownloadStatus").textContent.includes("fixture status unavailable"));
    assert.equal(await page.locator("#modelDownloadCancel").isHidden(), true, "a download status error hides the unavailable cancel action");
    assert.equal(await page.locator("#modelDownloadClose").isDisabled(), false, "a download status error lets the user close the modal");
    const pollsAfterFailure = modelDownloadPolls();
    await page.waitForTimeout(500);
    assert.equal(modelDownloadPolls(), pollsAfterFailure, "a download status error stops further polling");
    await page.locator("#modelDownloadClose").click();
    failModelDownloadStatus(false); resetModelDownload();
    await page.locator("#settingsTargetModel").fill("unsaved.onnx");
    deferFullSettings();
    await page.locator("#settingsStatusButton").click();
    assert.equal(settingsStatusRequests.length, 2, "model confirmation starts one additional form-status request");
    assert.equal(settingsStatusRequests[1].models.target_segmentation, "unsaved.onnx", "model confirmation validates the unsaved form value");
    assert.equal(await page.locator("#settingsStatusButton").isDisabled(), true, "model confirmation stays disabled while its full response is pending");
    assert.equal(await page.locator("#settingsStatusResult").textContent(), "モデル・GPU情報を確認しています…");
    await page.locator("#settingsTargetModel").fill("changed-while-checking.onnx");
    releaseFullSettings();
    await page.waitForFunction(() => !document.querySelector("#settingsStatusButton").disabled);
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), "changed-while-checking.onnx", "model status refresh keeps unsaved form values");
    assert.equal(await page.locator("#settingsStatusResult").textContent(), "設定が変更されたため、もう一度確認してください。", "a stale form-status response requires an explicit recheck");
    assert.match(await page.locator("#settingsGpuDevice").textContent(), /^GPU 1: defaultGPU 0:/, "a stale form-status response does not render its GPU state");
    await page.locator("#settingsStatusButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsStatusButton").disabled);
    assert.equal(settingsStatusRequests.length, 3, "the changed form requires a second explicit status check");
    assert.equal(settingsStatusRequests[2].models.target_segmentation, "changed-while-checking.onnx", "the recheck sends the changed form");
    assert.match(await page.locator("#settingsGpuDevice").textContent(), /^GPU 3: changed-while-checking\.onnxGPU 0:/, "only the recheck renders model and GPU state");
    await page.locator("#settingsTargetModel").fill("gpu-options.onnx");
    await page.locator("#settingsStatusButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsStatusButton").disabled);
    assert.match(await page.locator("#settingsGpuDevice").textContent(), /^GPU 3: RTX TestGPU 4: Legacy Test.*GPU 0:/, "status shows actual GPU names and preserves the configured missing device");
    assert.equal(await page.locator('#settingsGpuDevice option[value="4"]').evaluate((option) => option.disabled), true, "unsupported GPUs remain unavailable");
    assert.equal(await page.locator(".help-button").evaluateAll((buttons) => buttons.every((button) => {
      const rect = button.getBoundingClientRect(); return rect.width === 28 && rect.height === 28;
    })), true, "all model help buttons, including SAM type, share the compact 28px target");
    await page.locator("#settingsTabShortcuts").click();
    assert.equal(await page.locator("#shortcutBindings > .form-row").evaluateAll((rows) => rows.length === 10 && rows.every((row) => {
      const children = [...row.children];
      return children.length === 3 && children.every((child) => Math.abs((child.getBoundingClientRect().y + child.getBoundingClientRect().height / 2) - (row.getBoundingClientRect().y + row.getBoundingClientRect().height / 2)) < 2);
    })), true, "all shortcut bindings keep one three-column row");
    await page.locator("#settingsTabInfo").click();
    const versionRow = await page.evaluate(() => {
      const version = document.querySelector("#settingsVersion").getBoundingClientRect();
      const button = document.querySelector("#checkUpdateButton").getBoundingClientRect();
      return { sameRow: Math.abs((version.y + version.height / 2) - (button.y + button.height / 2)) < 2, buttonWidth: button.width };
    });
    assert.equal(versionRow.sameRow, true, "the update button shares the version row");
    assert.ok(versionRow.buttonWidth > 0 && versionRow.buttonWidth < 180, "the update button remains compact and clickable");
    assert.equal(await page.locator("#checkUpdateButton").evaluate((button) => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button; }), true, "the version update button owns its hit target");
    await page.waitForFunction(() => document.querySelector("#checkUpdateButton").dataset.available === "false");
    const updatesBeforeClick = updateRequests.length;
    await page.locator("#checkUpdateButton").click();
    assert.equal(updateRequests.length, updatesBeforeClick + 1, "explicit update checking sends exactly one request");
    assert.equal(await page.locator("#updateStatus").textContent(), "確認中…");
    await page.waitForFunction(() => document.querySelector("#updateStatus").textContent.includes("最新"));
    await page.locator("#settingsDialog").evaluate((dialog) => dialog.close());
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false, "bucket tolerance is hidden until the fill tool is selected");
    await page.locator("#boundaryTool").click();
    await page.locator("#bucketTool").click();
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), true, "bucket tolerance appears for the fill tool");
    await page.locator("#brushTool").click();
    assert.equal(await page.locator("#bucketToleranceControl").isVisible(), false, "bucket tolerance hides when switching away from fill");
    for (const selector of ["#removeAndNextButton", "#hideAndNextButton"]) assert.equal(await page.locator(selector).isDisabled(), true, `${selector} is disabled without a selected image`);
    assert.equal(await page.locator("[data-candidate-batch]").evaluateAll((buttons) => buttons.every((button) => button.disabled)), true, "candidate batch actions are disabled without a selected image or candidate");
    await selectFixtureImage(page, pageErrors, consoleErrors);
    const eta = await page.evaluate(() => {
      state.detectionEta = null;
      const first = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 1, total: 4, activeElapsed: 10 });
      const polled = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 1, total: 4, activeElapsed: 40 });
      const completed = progressText({ kind: "detect", state: "running", startedAt: 1, completed: 2, total: 4, activeElapsed: 40 });
      return { first, polled, completed };
    });
    assert.equal(eta.polled, eta.first, "ETA is retained between image completions");
    assert.notEqual(eta.completed, eta.first, "ETA is recalculated after an image completes");
    const legacyDraftManualExclusion = await page.evaluate(() => {
      state.settings.detection.exclude_forced_default = false;
      state.drafts.set("sample", { add: "", exclusion: "" });
      const forced = draftPayload(["sample"]).sample.manualExclusionForced;
      state.drafts.delete("sample");
      state.settings.detection.exclude_forced_default = true;
      return forced;
    });
    assert.equal(legacyDraftManualExclusion, false, "a legacy draft inherits the configured manual-exclusion default");
    await assertDesktopLayout(page, 1024, 768);
    await assertSettingsDialogLayout(page, 1024, 768, "ja");
    await page.evaluate(() => loadTranslations("en"));
    await assertDesktopLayout(page, 1920, 1080);
    await assertSettingsDialogLayout(page, 1920, 1080, "en");
    await page.evaluate(() => loadTranslations("ja"));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsLanguage").inputValue(), "ja", "the compact settings API flow starts in Japanese");
    const actionsBeforeSettingsFooter = settingsActions.length;
    await page.locator("#settingsResetButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "初期値に戻しました。");
    const settingsResultBox = await page.locator("#settingsResult").boundingBox(); const resetBox = await page.locator("#settingsResetButton").boundingBox();
    assert.ok(settingsResultBox && resetBox && resetBox.x - (settingsResultBox.x + settingsResultBox.width) <= 12, "settings result stays beside Reset");
    assert.deepEqual(settingsActions.at(-1), { path: "/api/settings/reset", method: "POST" }, "the compact reset button reaches its dedicated API route");
    const shortcutsAfterReset = await page.locator("[data-shortcut-action]").evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.equal(shortcutsAfterReset.length, 10, "reset restores every shortcut binding before compact save");
    assert.equal(shortcutsAfterReset.every(Boolean) && new Set(shortcutsAfterReset).size === shortcutsAfterReset.length, true, "reset restores valid unique shortcut bindings before compact save");
    const savesBeforeCompactSave = settingsActions.filter((action) => action.path === "/api/settings" && action.method === "POST").length;
    await page.locator("#settingsSaveButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "設定を保存しました。");
    assert.equal(settingsActions.filter((action) => action.path === "/api/settings" && action.method === "POST").length, savesBeforeCompactSave + 1, "the compact save button posts exactly once");
    assert.deepEqual(settingsActions.at(-1), { path: "/api/settings", method: "POST" }, "the compact save button reaches the settings API route");
    await page.locator("#settingsCloseButton").click();
    await page.waitForFunction(() => !document.querySelector("#settingsDialog").open);
    assert.equal(settingsActions.length, actionsBeforeSettingsFooter + 2, "the compact close button does not call a settings API route");
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.equal(await page.locator(".editor-context-bar").count(), 0, "the old editor context row must be removed");
    assert.equal(await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().height >= 690), true, "the canvas stage keeps a full editing surface beneath the compact status line at 1024x768");
    for (const selector of ["#canvasStage", ".canvas-tool-rail", ".canvas-settings-bar", "#currentFileName", "#previousImageButton", "#imagePosition", "#nextImageButton", "#reviewAndNextButton", "#saveButton"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} must be visible on desktop`);
    }
    for (const position of ["left", "top", "right", "bottom"]) await assertToolRailLayout(page, position);
    await page.locator("#canvasStage").evaluate((stage) => { stage.dataset.toolPosition = "left"; });
    for (const [language, labels] of [["ja", ["削除して次へ", "非表示にして次へ", "確認済にして次へ"]], ["en", ["Remove and next", "Hide and next", "Mark reviewed and next"]]]) {
      await page.evaluate((locale) => loadTranslations(locale), language);
      assert.deepEqual(await page.locator(".canvas-navigation-bar > button").evaluateAll((buttons) => buttons.slice(-3).map((button) => button.textContent.trim())), labels, `${language} navigation actions follow the requested order`);
    }
    await page.evaluate(() => loadTranslations("ja"));
    const stageWidth = await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().width);
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#collapseGalleryButton").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("#galleryPaneContent").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#galleryPaneContent").evaluate((pane) => pane.inert), true);
    assert.equal(await page.locator("#galleryPane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 40);
    assert.ok(await page.locator("#canvasStage").evaluate((stage) => stage.getBoundingClientRect().width) > stageWidth, "collapsing the gallery must enlarge the canvas");
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#collapseGalleryButton").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#galleryPaneContent").getAttribute("aria-hidden"), "false");
    assert.equal(await page.locator("#galleryPaneContent").evaluate((pane) => pane.inert), false);
    await page.locator("#collapseInspectorButton").click();
    await page.waitForFunction(() => document.querySelector(".studio-grid").classList.contains("inspector-collapsed"));
    assert.equal(await page.locator("#candidatePaneContent").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), true);
    assert.equal(await page.locator("#candidatePane").evaluate((pane) => Math.round(pane.getBoundingClientRect().width)), 40);
    await page.locator("#collapseGalleryButton").click();
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), true, "left panel state must not reopen the right panel");
    await page.locator("#collapseInspectorButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("inspector-collapsed"));
    assert.equal(await page.locator("#candidatePaneContent").evaluate((pane) => pane.inert), false);
    await page.locator("#collapseGalleryButton").click();
    await page.waitForFunction(() => !document.querySelector(".studio-grid").classList.contains("gallery-collapsed"));
    assert.equal(await page.locator("#canvasStage > .canvas-tool-rail").count(), 1, "only editor tools stay in the canvas overlay");
    assert.equal(await page.locator("#overviewDetectAllButton").count(), 0, "overview must not duplicate global actions");
    await page.locator("#applyDialog").evaluate((dialog) => dialog.showModal());
    assert.equal(await page.locator('#applyDialog [data-i18n="apply.metadata"]').textContent(), "対応するメタデータを引き継ぎます。同名時は自動連番です。", "save dialog describes only supported metadata carryover");
    assert.doesNotMatch(await page.locator('#applyDialog [data-i18n="apply.metadata"]').textContent(), /検証|validated/, "save dialog makes no verification claim");
    await page.locator("#applyCopyMode").check();
    await page.locator("#applySuffix").fill("_kept");
    await page.locator("#applyOverwriteMode").check();
    assert.equal(await page.locator("#applySuffixRow").isVisible(), false);
    assert.equal(await page.locator("#deleteOriginalRow").isVisible(), false);
    assert.equal(await page.locator("#applyOutputDirectoryRow").isVisible(), false);
    assert.equal(await page.locator("#applyOverwriteNote").count(), 0);
    await page.locator("#applyCopyMode").check();
    assert.equal(await page.locator("#applySuffix").inputValue(), "_kept");
    assert.equal(await page.locator("#applySuffix").isDisabled(), false);
    assert.equal(await page.locator("#removeAfterSave").isVisible(), true);
    await page.locator("#applyDialog").evaluate((dialog) => dialog.close());

    await page.evaluate(() => { state.maskStatus.set(state.currentId, true); updateActionButtons(); });
    await page.locator("#saveButton").click();
    await page.locator("#applySuffix").fill("_qa");
    await page.locator("#applyStartButton").click();
    await page.waitForFunction(() => state.applyRunning && state.saving);
    assert.equal(applyRequests.length, 1, "copy save starts exactly one server job");
    assert.equal(await page.locator("#settingsButton").isDisabled(), true, "background controls lock while a server copy is running");
    finishApply();
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => !state.applyRunning && !state.saving);
    assert.match(await page.locator("#applyResult").textContent(), /完了しました。1件を処理しました。/, "server copy reports its completed result");
    assert.equal(await page.locator("#applyCloseButton").isDisabled(), false, "the completed copy dialog can be closed");
    await page.locator("#applyCloseButton").click();
    assert.equal(await page.locator("#applyDialog").evaluate((dialog) => dialog.open), false, "the completed copy dialog closes");
    assert.equal(await page.locator("#settingsButton").isDisabled(), false, "background controls unlock after a reconciled server copy");

    await selectFixtureImage(page, pageErrors, consoleErrors);
    assert.equal(await page.locator("#removeAndNextButton").isDisabled(), false, "remove and next enables after selecting an image");
    assert.equal(await page.locator("#hideAndNextButton").isDisabled(), false, "hide and next enables after selecting an image");
    assert.equal(await page.locator("[data-candidate-batch]").evaluateAll((buttons) => buttons.every((button) => button.disabled)), true, "candidate batch actions stay disabled when the selected image has no candidates");
    await page.locator("#confidence").evaluate((input) => {
      input.value = "1.00";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#detectCurrentButton").click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#detectDialog").isVisible(), false, "current-image detection must not open settings");
    assert.equal(detectRequests.length, 1, "current-image detection should start immediately");
    assert.deepEqual(detectRequests[0].imageIds, ["sample"]);
    assert.equal(detectRequests[0].confidence, 1.00, "current-image detection should use the right-pane threshold");
    assert.equal(detectRequests[0].parallelism, 1, "current-image detection must stay serial");
    assert.equal(Object.hasOwn(detectRequests[0], "mode"), false, "current-image detection must not submit a mode override");

    resetJob();
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#detectAllButton").click();
    assert.equal(await page.locator("#detectDialog").isVisible(), true, "detect settings should open before any request");
    assert.equal(detectRequests.length, 1, "opening settings must not start another detection");
    await page.locator("#detectConfidenceNumber").fill("0.67");
    await page.locator("#detectParallelism").fill("3");
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open === false);
    await page.waitForTimeout(50);
    assert.equal(detectRequests.length, 2, "starting settings should call detection once");
    assert.equal(detectRequests[1].confidence, 0.67, "dialog threshold should be submitted");
    assert.equal(detectRequests[1].parallelism, 3, "dialog parallelism should be submitted");
    assert.equal(Object.hasOwn(detectRequests[1], "mode"), false, "all-image detection must not submit a mode override");
    resetJob();
    await page.reload({ waitUntil: "networkidle" });
    holdDetection(true);
    await page.locator("#detectAllButton").click();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => document.querySelector("#processingDialog").open);
    assert.equal(await page.locator("#processingCancelButton").evaluate((button) => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button; }), true, "the processing cancel button owns its physical hit target");
    failCancel(true);
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => !document.querySelector("#processingCancelButton").disabled);
    assert.equal(cancelRequests(), 1, "a failed processing cancel sends one request and re-enables the button");
    assert.match(await page.locator("#connectionStatus").textContent(), /cancel failed/, "a failed cancel is shown in the header without leaving the modal locked");
    failCancel(false);
    await page.locator("#processingCancelButton").click();
    await page.waitForFunction(() => document.querySelector("#processingCancelButton").disabled);
    await page.locator("#processingCancelButton").evaluate((button) => button.click());
    assert.equal(cancelRequests(), 2, "a processing cancel cannot be sent twice");
    holdDetection(false);
    resetJob();
    await page.evaluate(async () => { await pollJob(); closeProcessing(); });
    const menu = page.locator("#pickerMenu");
    assert.equal(await menu.isVisible(), false, "the picker menu should be initially hidden");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), false, "the picker menu should initially be closed");

    await page.locator("#pickFolder").click();
    assert.equal(await menu.isVisible(), true, "the picker menu should be visible after opening");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), true, "the picker menu should be open after opening");
    const [pickerBox, triggerBox] = await Promise.all([menu.boundingBox(), page.locator("#pickFolder").boundingBox()]);
    assert.ok(Math.abs(pickerBox.x - triggerBox.x) <= 1, "picker left edge should align with its trigger");
    assert.ok(Math.abs(pickerBox.y - (triggerBox.y + triggerBox.height + 6)) <= 1, "picker should sit 6px below its trigger");

    await page.locator("#pickImages").click();
    assert.equal(await page.evaluate(() => window.__openFilesCalled), true, "native image picker should be preferred");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting image files");

    await page.locator("#pickFolder").click();
    await page.locator("#pickFolderFiles").click();
    assert.equal(await page.evaluate(() => window.__openDirectoryCalled), true, "native folder picker should be preferred");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting a folder");

    assert.equal(await page.locator("footer.batch-bar").count(), 0, "batch controls must not live below the editor");
    const batchMenu = page.locator("#batchMoreMenu");
    assert.equal(await batchMenu.isVisible(), false, "destructive batch commands should not be visible by default");
    await page.locator("#batchMoreButton").evaluate((button) => { button.disabled = false; });
    await page.locator("#batchMoreButton").click();
    assert.equal(await batchMenu.isVisible(), true, "batch menu should reveal destructive commands on demand");
    await page.waitForFunction(() => document.querySelector("#batchMoreButton").getAttribute("aria-expanded") === "true");
    assert.equal(await page.locator("#batchMoreButton").getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#batchMoreMenu").matches(":popover-open"));
    await page.waitForFunction(() => document.querySelector("#batchMoreButton").getAttribute("aria-expanded") === "false");
    assert.equal(await page.locator("#batchMoreButton").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".appbar-commands #batchMoreButton").count(), 0, "batch menu belongs beside the image count, not in the appbar");
    assert.equal(await page.locator(".gallery-heading #batchMoreButton").count(), 1);
    assert.equal(await page.locator(".gallery-batch-bar").count(), 0, "batch edit leaves no control row in the gallery");
    assert.equal(await page.locator("#galleryFilter").inputValue(), "all");
    assert.deepEqual(await page.locator("#galleryFilter option").allTextContents(), ["すべて", "モザイクあり", "モザイク無し", "非表示", "確認済", "未確認"]);
    assert.equal(await page.locator("#galleryDropOverlay").evaluate((element) => element.parentElement.classList.contains("gallery-viewport")), true, "the drop overlay must be outside the scrolling gallery");
    assert.equal(await page.locator("#galleryFilteredEmptyState").count(), 1, "the gallery needs a filtered-empty state");
    assert.equal(await page.locator("#overviewEmptyState").count(), 1, "the overview needs an empty state");
    assert.equal(await page.locator(".overview-filters").getAttribute("role"), null, "overview filters are toggle buttons, not incomplete tabs");
    for (const selector of ["#brushTool", "#eraserTool", "#boundaryTool", ".overview-filter"]) {
      assert.notEqual(await page.locator(selector).first().getAttribute("aria-pressed"), null, `${selector} must expose its toggle state`);
    }
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("role"), "menu");
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("tabindex"), "-1");
    for (const selector of ["#confirmDialog", "#detectDialog", "#applyDialog", "#processingDialog"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-labelledby"), `${selector} must have an accessible title`);
    }
    for (const selector of ["#detectConfidenceRange", "#detectConfidenceNumber", "#detectParallelism", "#processingProgress", "#applyProgress"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-label"), `${selector} must have an accessible name`);
    }
    for (const selector of ["#confirmDialog", "#detectDialog", "#settingsDialog", "#modelHelpDialog", "#applyDialog"]) {
      await page.locator(selector).evaluate((dialog) => {
        if (!dialog.open) dialog.showModal();
        dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForFunction((target) => document.querySelector(target).open === false, selector);
    }
    await page.locator("#processingDialog").evaluate((dialog) => {
      dialog.showModal();
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      dialog.dispatchEvent(new Event("cancel", { bubbles: false, cancelable: true }));
    });
    assert.equal(await page.locator("#processingDialog").getAttribute("open"), "", "processing dialog must ignore backdrop and Escape dismissal");
    await page.locator("#processingDialog").evaluate((dialog) => dialog.close());
    assert.equal(await page.locator(".help-button").first().textContent(), "", "help buttons use an information icon instead of a question mark");
    assert.ok(await page.locator(".help-button").first().getAttribute("aria-label"));

    await selectFixtureImage(page, pageErrors, consoleErrors);
    assert.equal(await page.locator('.gallery-item[aria-pressed], .gallery-item.batch-selected').count(), 0, "the normal gallery owns only the current-image state");
    await page.locator("#overviewButton").click();
    await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
    const currentBeforeBatch = await page.locator(".overview-item.current").getAttribute("data-id");
    await page.locator("#batchModeButton").click();
    assert.equal(await page.locator("#batchModeButton").getAttribute("aria-pressed"), "true", "batch edit is an explicit overview mode");
    assert.equal(await page.locator("#overviewSelectionBar").isVisible(), true, "batch controls appear immediately below the overview toolbar");
    assert.equal(await page.locator('[data-selection-action]').count(), 7, "overview batch edit retains all seven actions");
    await page.locator('.overview-item[data-id="sample"]').focus();
    await page.keyboard.press("Space");
    await page.locator('.overview-item[data-id="sample-two"]').click();
    assert.equal(await page.locator("#overviewPane").isVisible(), true, "batch selection stays in the overview");
    assert.equal(await page.locator(".overview-item.current").getAttribute("data-id"), currentBeforeBatch, "batch selection does not change the current image");
    assert.equal(await page.locator("#selectionCount").textContent(), "2件を選択中", "the overview selection bar reports the selected image count");
    assert.equal(await page.locator('.overview-item[data-id="sample"]').evaluate((item) => item.classList.contains("batch-selected")), true, "the first overview selection is green");
    assert.equal(await page.locator('.overview-item[data-id="sample-two"]').evaluate((item) => item.classList.contains("batch-selected")), true, "the second overview selection is green");
    assert.equal(await page.locator('.overview-item[data-id="sample"]').getAttribute("aria-pressed"), "true", "keyboard overview selection exposes its selected state");
    for (const [width, height, language] of [[1024, 768, "ja"], [1920, 1080, "en"]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((language) => loadTranslations(language), language);
      await page.locator("#selectionActionsButton").click();
      const geometry = await page.locator("#selectionActionsMenu").evaluate((menu) => {
        const button = document.querySelector("#selectionActionsButton").getBoundingClientRect(); const rect = menu.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, buttonRight: button.right, buttonBottom: button.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth };
      });
      assert.equal(geometry.right, geometry.buttonRight, `selection menu right aligns with its button at ${width}x${height} (${language})`);
      assert.ok(geometry.top >= geometry.buttonBottom + 4 && geometry.top <= geometry.buttonBottom + 6 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight && geometry.scrollWidth <= geometry.viewportWidth, `selection menu stays in the viewport without horizontal overflow at ${width}x${height} (${language})`);
      await page.locator("#selectionActionsMenu").evaluate((menu) => menu.hidePopover());
    }
    await page.evaluate(() => loadTranslations("ja"));
    await page.setViewportSize({ width: 1280, height: 720 });
    const batchDetectBefore = detectRequests.length;
    await page.locator("#selectionActionsButton").click();
    const selectionMenu = await page.locator("#selectionActionsMenu").evaluate((menu) => {
      const button = document.querySelector("#selectionActionsButton").getBoundingClientRect(); const rect = menu.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, buttonRight: button.right, buttonBottom: button.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.equal(selectionMenu.right, selectionMenu.buttonRight, "selection menu right edge anchors to its button");
    assert.ok(selectionMenu.top >= selectionMenu.buttonBottom && selectionMenu.right <= selectionMenu.viewportWidth && selectionMenu.bottom <= selectionMenu.viewportHeight, `selection menu is visibly anchored below its button: ${JSON.stringify(selectionMenu)}`);
    await page.locator('[data-selection-action="detect"]').click();
    await page.locator("#detectStartButton").click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(detectRequests.length, batchDetectBefore + 1, "batch auto detect sends exactly one request");
    assert.deepEqual(detectRequests.at(-1).imageIds.sort(), ["sample", "sample-two"], "batch auto detect receives exactly the selected gallery ids");
    await page.evaluate(() => pollJob());
    await page.waitForFunction(() => !document.querySelector("#processingDialog").open, null, { timeout: 5000 });
    await page.locator("#selectionClearButton").click();
    assert.equal(await page.locator('.overview-item.batch-selected').count(), 0, "exiting batch edit clears every green overview selection");
    assert.equal(await page.locator('.overview-item[aria-pressed]').count(), 0, "exiting batch edit removes overview selection semantics");
    await page.locator("#batchModeButton").click();
    assert.equal(await page.locator("#selectionCount").textContent(), "0件を選択中", "re-entering batch edit starts with no stale selection");
    await page.locator("#selectionClearButton").click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
    assert.equal(await page.locator('.gallery-item[aria-pressed], .gallery-item.batch-selected').count(), 0, "returning to the gallery never restores overview selection semantics");

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors.sort(), ["Failed to load resource: the server responded with a status of 500 (Internal Server Error)", "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"].sort(), `unexpected console errors: ${consoleErrors.join("; ")}`);
  } finally {
    await browser?.close();
    if (server) await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
