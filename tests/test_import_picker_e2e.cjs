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
  const settingsRequests = [];
  const settingsActions = [];
  const settingsStatusRequests = [];
  const updateRequests = [];
  const modelPickerRequests = [];
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
    detection: { mode: "standard", fluid_exclusion_enabled: true, threshold: 0.5, parallelism: 2, targets: ["penis", "pussy"] },
    shortcuts: {
      enabled: true,
      bindings: { previous: "ArrowLeft", next: "ArrowRight", previousVisible: "ArrowUp", nextVisible: "ArrowDown", first: "Home", last: "End", nextUnreviewed: "Shift+ArrowRight", reviewAndNext: "Enter", toggleOverview: "G", undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" },
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
      settingsStatusRequests.push(JSON.parse(body));
      const reply = () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: { models: {}, gpus: [] } })); };
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
      resolve({ server, url: `http://127.0.0.1:${port}`, detectRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, cancelRequests: () => cancelRequests, holdDetection: (value) => { holdDetection = value; }, failCancel: (value) => { cancelShouldFail = value; }, resetJob: () => { currentJob = { kind: "idle", state: "idle" }; }, deferFullSettings: () => { deferFullSettings = true; }, releaseFullSettings: () => releaseFullSettings?.() });
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
    assert.ok(button.scrollWidth <= button.clientWidth, `${button.id} label must not be clipped at ${label}`);
    assert.equal(button.whiteSpace, "nowrap", `${button.id} must not wrap at ${label}`);
    assert.notEqual(button.textOverflow, "ellipsis", `${button.id} must not use ellipsis at ${label}`);
    assert.equal(button.text.includes("..."), false, `${button.id} must not contain three-dot truncation at ${label}`);
    assert.equal(button.text.includes("…"), false, `${button.id} must not contain ellipsis truncation at ${label}`);
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

async function assertSettingsDialogLayout(page, width, height, footerOnly = false) {
  await page.setViewportSize({ width, height });
  await page.locator("#settingsButton").click();
  for (const language of ["ja", "en"]) {
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#settingsLanguage").selectOption(language);
    await page.waitForFunction((selectedLanguage) => document.documentElement.lang === selectedLanguage, language);
    const footer = await page.locator("#settingsDialog .dialog-actions").evaluate((actions) => {
      const [result, reset, save] = actions.children;
      const actionRect = actions.getBoundingClientRect();
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element };
      };
      return {
        className: actions.className,
        children: [...actions.children].map((child) => child.id),
        scrollWidth: actions.scrollWidth,
        clientWidth: actions.clientWidth,
        result: rect(result), reset: rect(reset), save: rect(save),
        actionLeft: actionRect.left, actionRight: actionRect.right,
      };
    });
    assert.equal(footer.className, "dialog-actions", `settings footer keeps the shared action bar at ${width}x${height} (${language})`);
    assert.deepEqual(footer.children, ["settingsResult", "settingsResetButton", "settingsSaveButton"], `settings footer contains only result, reset and save at ${width}x${height} (${language})`);
    assert.ok(footer.scrollWidth <= footer.clientWidth, `settings footer has no horizontal overflow at ${width}x${height} (${language})`);
    assert.ok(footer.result.left >= footer.actionLeft && footer.save.right <= footer.actionRight && footer.reset.hit && footer.save.hit, `settings footer items are visible physical hit targets at ${width}x${height} (${language})`);
    assert.ok(footer.result.right < footer.reset.left && footer.reset.right < footer.save.left, `settings footer keeps result, reset, save order at ${width}x${height} (${language})`);
    assert.ok(footer.reset.left - footer.result.right >= 6 && footer.reset.left - footer.result.right <= 12 && footer.save.left - footer.reset.right >= 6 && footer.save.left - footer.reset.right <= 12, `settings footer keeps compact 8px gaps at ${width}x${height} (${language})`);
    const heading = await page.locator("#settingsDialog .settings-heading").evaluate((heading) => {
      const [title, close] = heading.children;
      const headingRect = heading.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      return { children: [...heading.children].map((child) => child.id), scrollWidth: heading.scrollWidth, clientWidth: heading.clientWidth, closeRight: closeRect.right, headingRight: headingRect.right, closeHit: document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2) === close };
    });
    assert.deepEqual(heading.children, ["settingsDialogTitle", "settingsCloseButton"], `settings header keeps title then close at ${width}x${height} (${language})`);
    assert.ok(heading.scrollWidth <= heading.clientWidth && heading.closeRight <= heading.headingRight && heading.closeHit, `settings header close remains right-aligned and clickable at ${width}x${height} (${language})`);
    await page.locator("#settingsResetButton").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "settingsSaveButton", `tab follows reset with save at ${width}x${height} (${language})`);
    if (footerOnly) continue;
    for (const [panelSelector, tabSelector] of [["#settingsPanelGeneral", "#settingsTabGeneral"], ["#settingsPanelModels", "#settingsTabModels"], ["#settingsPanelDisplay", "#settingsTabDisplay"]]) {
      await page.locator(tabSelector).click();
      const layout = await page.locator(`${panelSelector} .form-row`).evaluateAll((rows) => {
        const panel = rows[0]?.parentElement.getBoundingClientRect();
        return {
          panelLeft: panel?.left,
          rows: rows.map((row) => {
            const [label, control] = row.children;
            const labelRect = label.getBoundingClientRect();
            const controlRect = control.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            return {
              rowLeft: rowRect.left, rowRight: rowRect.right, rowWidth: rowRect.width, rowScrollWidth: row.scrollWidth,
              labelLeft: labelRect.left, labelRight: labelRect.right, labelBottom: labelRect.bottom,
              controlLeft: controlRect.left, controlTop: controlRect.top, controlRight: controlRect.right,
              labelTextAlign: getComputedStyle(label).textAlign,
            };
          }),
        };
      });
      assert.ok(layout.rows.length > 0, `${panelSelector} has settings rows at ${width}x${height} (${language})`);
      for (const row of layout.rows) {
        assert.ok(Math.abs(row.rowLeft - layout.panelLeft) <= 2 && Math.abs(row.labelLeft - layout.panelLeft) <= 2 && Math.abs(row.controlLeft - layout.panelLeft) <= 2, `${panelSelector} labels and controls start at the panel left edge at ${width}x${height} (${language})`);
        assert.equal(row.labelTextAlign, "left", `${panelSelector} labels are never right-aligned at ${width}x${height} (${language})`);
        assert.ok(row.controlTop - row.labelBottom >= 4 && row.controlTop - row.labelBottom <= 8, `${panelSelector} keeps a compact vertical label-to-control gap at ${width}x${height} (${language})`);
        assert.ok(row.controlRight <= row.rowRight + 1 && row.rowScrollWidth <= row.rowWidth + 1, `${panelSelector} controls do not overflow or overlap at ${width}x${height} (${language})`);
      }
    }
    await page.locator("#settingsTabModels").click();
    const modelPickerControls = page.locator("[data-model-picker]");
    const modelPickers = [];
    for (let index = 0; index < await modelPickerControls.count(); index += 1) {
      const button = modelPickerControls.nth(index); await button.scrollIntoViewIfNeeded();
      modelPickers.push(await button.evaluate((button) => {
        const wrapper = button.parentElement.getBoundingClientRect(); const input = button.parentElement.querySelector("input").getBoundingClientRect(); const rect = button.getBoundingClientRect();
        return { key: button.dataset.modelPicker, fits: input.left >= wrapper.left && input.right < rect.left && rect.right <= wrapper.right + 1, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button };
      }));
    }
    assert.equal(modelPickers.length, 6, `all six model file pickers exist at ${width}x${height} (${language})`);
    assert.ok(modelPickers.every((picker) => picker.fits && picker.hit), `model file picker fields fit and remain clickable at ${width}x${height} (${language})`);
    const samHelp = page.locator('[data-model-help="samType"]');
    await samHelp.scrollIntoViewIfNeeded();
    const samTarget = await samHelp.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      const row = button.closest(".form-row").getBoundingClientRect();
      const label = document.querySelector('label[for="settingsSamType"]');
      const labelRect = label.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height,
        centerIsButton: document.elementFromPoint(centerX, centerY) === button,
        edgesAreNotButton: [[rect.x - 1, centerY], [rect.right + 1, centerY], [centerX, rect.y - 1], [centerX, rect.bottom + 1]].every(([x, y]) => document.elementFromPoint(x, y) !== button),
        labelFor: label.htmlFor, labelText: label.textContent,
        blankX: row.right - 2, blankY: labelRect.y + labelRect.height / 2,
      };
    });
    assert.deepEqual([samTarget.width, samTarget.height], [28, 28], `SAM help keeps its 28px target at ${width}x${height} (${language})`);
    assert.equal(samTarget.centerIsButton, true, `SAM help owns its center hit target at ${width}x${height} (${language})`);
    assert.equal(samTarget.edgesAreNotButton, true, `SAM help does not capture clicks 1px outside its edges at ${width}x${height} (${language})`);
    assert.equal(samTarget.labelFor, "settingsSamType", `SAM setting label is explicitly linked at ${width}x${height} (${language})`);
    assert.equal(samTarget.labelText, language === "en" ? "Outline extraction model type" : "輪郭抽出モデルの種類", `SAM setting label is localized at ${width}x${height} (${language})`);
    await page.locator('label[for="settingsSamType"]').click();
    assert.equal(await page.locator("#modelHelpDialog").isVisible(), false, `clicking the SAM setting label does not open help at ${width}x${height} (${language})`);
    await page.mouse.click(samTarget.blankX, samTarget.blankY);
    assert.equal(await page.locator("#modelHelpDialog").isVisible(), false, `clicking blank SAM row space does not open help at ${width}x${height} (${language})`);
    await samHelp.click();
    const samDialog = await page.locator("#modelHelpDialog").evaluate((dialog) => {
      const table = dialog.querySelector("#modelHelpSamTable");
      return {
        textHidden: dialog.querySelector("#modelHelpText").hidden,
        tableHidden: table.hidden,
        rows: table.tBodies[0].rows.length,
        columns: [...table.rows].every((row) => row.cells.length === 5),
        headers: [...table.tHead.rows[0].cells].map((cell) => cell.textContent),
        columnScopes: [...table.tHead.rows[0].cells].map((cell) => cell.scope),
        rowScopes: [...table.tBodies[0].rows].map((row) => row.cells[0].scope),
        tableScrollWidth: table.scrollWidth, tableClientWidth: table.clientWidth,
        dialogScrollWidth: dialog.scrollWidth, dialogClientWidth: dialog.clientWidth,
      };
    });
    assert.equal(samDialog.textHidden, false, `SAM help keeps its short explanation above the table at ${width}x${height} (${language})`);
    assert.equal(samDialog.tableHidden, false, `SAM help shows its comparison table at ${width}x${height} (${language})`);
    assert.equal(samDialog.rows, 3, `SAM help has three model rows at ${width}x${height} (${language})`);
    assert.equal(samDialog.columns, true, `SAM help has five columns at ${width}x${height} (${language})`);
    assert.deepEqual(samDialog.headers, language === "en" ? ["Model", "Speed", "Relative detail", "VRAM", "Best for"] : ["モデル", "速度", "輪郭の細かさ目安", "VRAM", "向いている用途"], `SAM table headers are localized at ${width}x${height} (${language})`);
    assert.deepEqual(samDialog.columnScopes, ["col", "col", "col", "col", "col"], `SAM table headers use column scopes at ${width}x${height} (${language})`);
    assert.deepEqual(samDialog.rowScopes, ["row", "row", "row"], `SAM table model names use row scopes at ${width}x${height} (${language})`);
    assert.ok(samDialog.tableScrollWidth <= samDialog.tableClientWidth && samDialog.dialogScrollWidth <= samDialog.dialogClientWidth, `SAM help table has no horizontal overflow at ${width}x${height} (${language})`);
    await page.locator("#modelHelpCloseButton").click();
    assert.equal(await page.locator("#modelHelpDialog").isVisible(), false, `SAM help close button works at ${width}x${height} (${language})`);
    await page.locator('[data-model-help="ntd11"]').click();
    assert.equal(await page.locator("#modelHelpText").isVisible(), true, `other model help keeps its paragraph at ${width}x${height} (${language})`);
    assert.equal(await page.locator("#modelHelpSamTable").isVisible(), false, `other model help keeps the SAM table hidden at ${width}x${height} (${language})`);
    await page.locator("#modelHelpDialog").evaluate((dialog) => dialog.close());
    await page.locator("#settingsTabGeneral").click();
    assert.equal(await page.locator("#settingsOpenBrowser").evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
    }), true, `the startup-browser checkbox owns its left-side hit target at ${width}x${height} (${language})`);
    const openBrowser = page.locator("#settingsOpenBrowser");
    const checked = await openBrowser.isChecked();
    await openBrowser.click();
    assert.equal(await openBrowser.isChecked(), !checked, `the startup-browser checkbox accepts a physical click at ${width}x${height} (${language})`);
    await openBrowser.click();
    await page.locator("#settingsTabShortcuts").click();
    assert.equal(await page.locator("#shortcutBindings > .form-row").first().locator("span").textContent(), language === "en" ? "Previous image" : "前の画像", `shortcut labels follow the selected language at ${width}x${height} (${language})`);
    const shortcuts = await page.locator("#shortcutBindings > .form-row").evaluateAll((rows) => {
      const panelLeft = rows[0]?.parentElement.parentElement.getBoundingClientRect().left;
      return { panelLeft, rows: rows.map((row) => {
        const children = [...row.children]; const rowRect = row.getBoundingClientRect();
        return { children: children.map((child) => { const rect = child.getBoundingClientRect(); return { left: rect.left, right: rect.right, centerY: rect.y + rect.height / 2 }; }), rowLeft: rowRect.left, rowRight: rowRect.right, rowWidth: rowRect.width, rowScrollWidth: row.scrollWidth, rowCenterY: rowRect.y + rowRect.height / 2 };
      }) };
    });
    assert.equal(shortcuts.rows.length, 11, `all shortcut bindings render at ${width}x${height} (${language})`);
    for (const row of shortcuts.rows) {
      assert.equal(row.children.length, 3, `each shortcut has label, enabled checkbox, and key input at ${width}x${height} (${language})`);
      assert.ok(Math.abs(row.rowLeft - shortcuts.panelLeft) <= 2 && Math.abs(row.children[0].left - shortcuts.panelLeft) <= 2, `shortcut rows stay grouped on the settings panel left at ${width}x${height} (${language})`);
      assert.ok(row.children.every((child) => Math.abs(child.centerY - row.rowCenterY) <= 2), `shortcut controls stay on one row at ${width}x${height} (${language})`);
      assert.ok(row.children[1].left - row.children[0].left >= 220 && row.children[1].left - row.children[0].left <= 250 && row.children[2].left - row.children[1].right >= 8 && row.children[2].left - row.children[1].right <= 14, `shortcut columns keep their local left-side positions at ${width}x${height} (${language}): ${JSON.stringify(row)}`);
      assert.ok(row.children[2].right <= row.rowRight + 1 && row.rowScrollWidth <= row.rowWidth + 1, `shortcut rows do not overflow at ${width}x${height} (${language})`);
    }
  }
  if (footerOnly) {
    await page.locator("#settingsTabGeneral").click();
    await page.locator("#settingsLanguage").selectOption("ja");
    await page.waitForFunction(() => document.documentElement.lang === "ja");
    await page.locator("#settingsDialog").evaluate((dialog) => dialog.close());
    return;
  }
  await page.locator("#settingsTabModels").click();
  assert.equal(await page.locator(".help-button").evaluateAll((buttons) => buttons.every((button) => { const rect = button.getBoundingClientRect(); return rect.width === 28 && rect.height === 28; })), true, `all help buttons stay 28px at ${width}x${height}`);
  await page.locator("#settingsTabGeneral").click();
  await page.locator("#settingsLanguage").selectOption("ja");
  await page.waitForFunction(() => document.documentElement.lang === "ja");
  await page.locator("#settingsDialog").evaluate((dialog) => dialog.close());
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
  let detectRequests, modelPickerRequests, resetJob;
  let settingsRequests;
  let settingsActions;
  let settingsStatusRequests;
  let updateRequests;
  let cancelRequests, holdDetection, failCancel;
  let deferFullSettings;
  let releaseFullSettings;
  try {
    ({ server, url: fixtureUrl, detectRequests, settingsRequests, settingsActions, settingsStatusRequests, updateRequests, modelPickerRequests, cancelRequests, holdDetection, failCancel, resetJob, deferFullSettings, releaseFullSettings } = await startFixtureServer());
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
    const fullSettingsBeforeOpen = settingsRequests.filter((search) => search === "").length;
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsDialog").isVisible(), true, "settings opens immediately from the cached lightweight response");
    assert.equal(settingsRequests.filter((search) => search === "").length, fullSettingsBeforeOpen, "opening settings does not start a full status request");
    await page.locator("#settingsTabModels").click();
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
    await page.locator("#settingsTargetModel").fill("unsaved.onnx");
    deferFullSettings();
    await page.locator("#settingsStatusButton").click();
    assert.equal(settingsStatusRequests.length, 1, "model confirmation starts exactly one form-status request");
    assert.equal(settingsStatusRequests[0].models.target_segmentation, "unsaved.onnx", "model confirmation validates the unsaved form value");
    assert.equal(await page.locator("#settingsStatusButton").isDisabled(), true, "model confirmation stays disabled while its full response is pending");
    assert.equal(await page.locator("#settingsStatusResult").textContent(), "モデル・GPU情報を確認しています…");
    releaseFullSettings();
    await page.waitForFunction(() => !document.querySelector("#settingsStatusButton").disabled);
    assert.equal(await page.locator("#settingsTargetModel").inputValue(), "unsaved.onnx", "model status refresh keeps unsaved form values");
    assert.equal(await page.locator(".help-button").evaluateAll((buttons) => buttons.every((button) => {
      const rect = button.getBoundingClientRect(); return rect.width === 28 && rect.height === 28;
    })), true, "all model help buttons, including SAM type, share the compact 28px target");
    await page.locator("#settingsTabShortcuts").click();
    assert.equal(await page.locator("#shortcutBindings > .form-row").evaluateAll((rows) => rows.length === 11 && rows.every((row) => {
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
    for (const viewport of [
      { width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize(viewport);
      const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `horizontal overflow at ${viewport.width}x${viewport.height}`);
      assert.equal(await page.locator("#pickFolder").isVisible(), true, "source picker should remain available");
      assert.equal(await page.locator("#saveButton").isVisible(), true, "current-image save should remain visible in the inspector");
    }
    for (const viewport of [
      { width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
    ]) await assertDesktopLayout(page, viewport.width, viewport.height);
    for (const viewport of [
      { width: 1024, height: 768 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
    ]) await assertSettingsDialogLayout(page, viewport.width, viewport.height);
    await assertSettingsDialogLayout(page, 320, 720, true);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.locator("#settingsButton").click();
    assert.equal(await page.locator("#settingsLanguage").inputValue(), "ja", "the compact settings API flow starts in Japanese");
    const actionsBeforeSettingsFooter = settingsActions.length;
    await page.locator("#settingsResetButton").click();
    await page.waitForFunction(() => document.querySelector("#settingsResult").textContent === "初期値に戻しました。");
    assert.deepEqual(settingsActions.at(-1), { path: "/api/settings/reset", method: "POST" }, "the compact reset button reaches its dedicated API route");
    const shortcutsAfterReset = await page.locator("[data-shortcut-action]").evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.equal(shortcutsAfterReset.length, 11, "reset restores every shortcut binding before compact save");
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
    for (const selector of ["#canvasStage", ".canvas-tool-rail", ".canvas-settings-bar", "#previousImageButton", "#imagePosition", "#nextImageButton", "#nextUnreviewedButton", "#reviewAndNextButton", "#saveButton"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} must be visible on desktop`);
    }
    for (const position of ["left", "top", "right", "bottom"]) await assertToolRailLayout(page, position);
    await page.locator("#canvasStage").evaluate((stage) => { stage.dataset.toolPosition = "left"; });
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
    assert.match(await page.locator("#status").textContent(), /cancel failed/, "a failed cancel is shown as an error without leaving the modal locked");
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
    for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080], [2560, 1440]]) for (const language of ["ja", "en"]) {
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
    assert.deepEqual(consoleErrors, ["Failed to load resource: the server responded with a status of 500 (Internal Server Error)"], `unexpected console errors: ${consoleErrors.join("; ")}`);
  } finally {
    await browser?.close();
    if (server) await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
