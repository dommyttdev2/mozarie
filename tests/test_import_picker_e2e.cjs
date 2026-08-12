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

function startFixtureServer() {
  const detectRequests = [];
  const server = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    if (requestPath === "/api/images") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        images: [{ id: "sample", relativePath: "sample.png", width: 100, height: 80, candidateCount: 0, enabledCandidateCount: 0 }],
        root: "G:/fixture",
      }));
      return;
    }
    if (requestPath === "/api/job") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ state: "idle" }));
      return;
    }
    if (requestPath === "/api/detect" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      detectRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/api/candidates/sample") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ candidates: [] }));
      return;
    }
    if (requestPath.startsWith("/api/thumbnail/") || requestPath.startsWith("/api/image/")) {
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
      resolve({ server, url: `http://127.0.0.1:${port}`, detectRequests });
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

async function assertInViewport(page, selector, label) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box, `${label} must have a layout box`);
  assert.ok(box.x >= -1 && box.y >= -1, `${label} must not begin outside the viewport`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${label} must not extend past the viewport right edge`);
}

async function assertDesktopLayout(page, width) {
  const viewport = { width, height: 900 };
  await page.setViewportSize(viewport);
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `horizontal overflow at ${width}px desktop width`);
  for (const [selector, label] of [
    ["#pickFolder", "source picker"], ["#detectAllButton", "detect-all button"],
    ["#saveAllButton", "batch-save button"], ["#batchMoreButton", "clear menu button"],
    ["#saveButton", "current-image save button"], ["#overviewButton", "overview button"],
  ]) await assertInViewport(page, selector, `${label} at ${width}px`);

  const batchBoxes = await Promise.all(["#detectAllButton", "#saveAllButton", "#batchMoreButton"].map((selector) => page.locator(selector).boundingBox()));
  for (let index = 0; index < batchBoxes.length; index += 1) {
    for (let other = index + 1; other < batchBoxes.length; other += 1) {
      assert.equal(overlaps(batchBoxes[index], batchBoxes[other]), false, `gallery batch controls overlap at ${width}px`);
    }
  }

  await page.locator("#overviewButton").click();
  await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
  for (const [selector, label] of [
    ["#overviewDetectAllButton", "overview detect-all button"], ["#overviewSaveAllButton", "overview batch-save button"],
    ["#overviewBatchMoreButton", "overview clear menu button"], ["#overviewQuery", "overview search"],
  ]) await assertInViewport(page, selector, `${label} at ${width}px`);
  const overviewBoxes = await Promise.all(["#overviewDetectAllButton", "#overviewSaveAllButton", "#overviewBatchMoreButton"].map((selector) => page.locator(selector).boundingBox()));
  for (let index = 0; index < overviewBoxes.length; index += 1) {
    for (let other = index + 1; other < overviewBoxes.length; other += 1) {
      assert.equal(overlaps(overviewBoxes[index], overviewBoxes[other]), false, `overview batch controls overlap at ${width}px`);
    }
  }
  await page.locator("#closeOverviewButton").click();
  await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
}

async function main() {
  let server;
  let browser;
  let fixtureUrl;
  let detectRequests;
  try {
    ({ server, url: fixtureUrl, detectRequests } = await startFixtureServer());
    browser = await chromium.launch();
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
    for (const viewport of [
      { width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 },
      { width: 800, height: 900 }, { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `horizontal overflow at ${viewport.width}x${viewport.height}`);
      assert.equal(await page.locator("#pickFolder").isVisible(), true, "source picker should remain available");
      assert.equal(await page.locator("#saveButton").isVisible(), true, "current-image save should remain visible");
    }
    for (const width of [900, 1024, 1279, 1280, 1366]) await assertDesktopLayout(page, width);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator(".editor-footer").count(), 0, "the editor footer must be removed");
    assert.equal(await page.locator(".editor-context-bar").isVisible(), true, "the editor context bar must be visible on desktop");
    assert.equal(await page.evaluate(() => {
      const contextBar = document.querySelector(".editor-context-bar");
      const canvas = document.querySelector("#editorCanvas");
      return Boolean(contextBar?.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, "the editor context bar must precede the canvas in the DOM");
    for (const selector of ["#imageInfo", "#reviewStatus", "#previousImageButton", "#imagePosition", "#nextImageButton", "#nextUnreviewedButton", "#reviewAndNextButton", "#navigationShortcutsEnabled"]) {
      assert.equal(await page.locator(selector).isVisible(), true, `${selector} must be visible on desktop`);
    }

    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => !document.querySelector("#detectCurrentButton").disabled);
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
    await page.reload({ waitUntil: "networkidle" });
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
    assert.equal(await page.locator("#galleryAllTab").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#galleryMaskedTab").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#galleryDropOverlay").evaluate((element) => element.parentElement.classList.contains("gallery-viewport")), true, "the drop overlay must be outside the scrolling gallery");
    assert.equal(await page.locator("#galleryFilteredEmptyState").count(), 1, "the gallery needs a filtered-empty state");
    assert.equal(await page.locator("#overviewEmptyState").count(), 1, "the overview needs an empty state");
    assert.equal(await page.locator(".overview-filters").getAttribute("role"), null, "overview filters are toggle buttons, not incomplete tabs");
    for (const selector of ["#brushTool", "#eraserTool", "#boundaryTool", ".overview-filter"]) {
      assert.notEqual(await page.locator(selector).first().getAttribute("aria-pressed"), null, `${selector} must expose its toggle state`);
    }
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("role"), "menu");
    assert.equal(await page.locator("#catalogContextMenu").getAttribute("tabindex"), "-1");
    for (const selector of ["#confirmDialog", "#detectDialog", "#applyDialog"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-labelledby"), `${selector} must have an accessible title`);
    }
    for (const selector of ["#detectConfidenceRange", "#detectConfidenceNumber", "#detectParallelism", "#jobProgress", "#applyProgress"]) {
      assert.ok(await page.locator(selector).getAttribute("aria-label"), `${selector} must have an accessible name`);
    }

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors, [], `unexpected console errors: ${consoleErrors.join("; ")}`);
  } finally {
    await browser?.close();
    if (server) await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
