"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function freshPage(browser, fixture, initScript = null) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await page.goto(fixture.url, { waitUntil: "networkidle" });
  return { context, page };
}

test("filter popover combines checked states and review-at-tail stays on the filtered image", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => {
      const [masked, plain] = state.images;
      masked.candidateCount = 1; masked.enabledCandidateCount = 1; masked.reviewed = false;
      plain.candidateCount = 0; plain.enabledCandidateCount = 0; plain.reviewed = false;
      state.maskStatus.set(masked.id, true); state.maskStatus.set(plain.id, false);
      renderGallery(true);
    });
    await page.locator("#galleryFilterButton").click();
    await page.locator('[data-gallery-filter="masked"]').check();
    await page.locator('[data-gallery-filter="unreviewed"]').check();
    await page.waitForFunction(() => state.galleryFilter instanceof Set && state.galleryFilter.size === 2);
    assert.deepEqual(await page.evaluate(() => state.images.filter(imageMatchesGalleryFilter).map((image) => image.id)), ["sample", "sample-two"], "checked filters use OR and do not make mosaic status depend on reviewed state");

    await page.locator('[data-gallery-filter="unreviewed"]').uncheck();
    await page.waitForFunction(() => state.images.filter(imageMatchesGalleryFilter).length === 1);
    assert.deepEqual(await page.evaluate(() => state.images.filter(imageMatchesGalleryFilter).map((image) => image.id)), ["sample"], "mosaic-only still includes an already-reviewed image");

    await page.keyboard.press("Escape");
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample")?.reviewed === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample", "review at the filtered tail leaves the reviewed current image selected");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("all-image detection submits the fluid color-fill settings with default tolerance 26", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => {
      window.__detectPayloads = [];
      const nativeFetch = window.fetch;
      window.fetch = async (input, init = {}) => {
        const url = String(input?.url || input);
        if (url.endsWith("/api/detect")) window.__detectPayloads.push(JSON.parse(init.body));
        return nativeFetch(input, init);
      };
    });
    await page.locator("#detectAllButton").click();
    await page.waitForFunction(() => document.querySelector("#detectDialog").open);
    assert.equal(await page.locator("#detectFluidColorFillTolerance").inputValue(), "26", "the all-image dialog starts at the configured default tolerance");
    await page.locator("#detectFluidColorFillTolerance").fill("27");
    await page.locator("#detectFluidColorFillEnabled").uncheck();
    await page.locator("#detectStartButton").click();
    await page.waitForFunction(() => window.__detectPayloads.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__detectPayloads[0]), {
      imageIds: ["sample", "sample-two"], confidence: 0.5, parallelism: 2, targetClasses: ["penis", "pussy"], fluidColorFillEnabled: false, fluidColorFillTolerance: 27,
    }, "the modal sends an explicit fluid-fill switch and tolerance with the detection request");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("filtered review and hide keep their tail, while deletion selects the previous filtered image", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.evaluate(() => {
      for (const image of state.images) {
        image.candidateCount = 1; image.enabledCandidateCount = 1; image.reviewed = false; image.hidden = false;
        state.maskStatus.set(image.id, true);
      }
      state.galleryFilter = new Set(["masked"]);
      renderGallery(true);
    });

    await page.locator('.gallery-item[data-id="sample-two"]').click();
    await page.waitForFunction(() => state.currentId === "sample-two" && state.currentImage);
    await page.evaluate(() => {
      // Selecting an image refreshes its fixture candidates.  Establish the
      // filter after that asynchronous refresh so this is a true two-image
      // filtered-tail case, not an index-missing fallback case.
      for (const image of state.images) state.maskStatus.set(image.id, true);
      renderGallery(true);
    });
    assert.deepEqual(await page.evaluate(() => galleryFilteredImages().map((image) => image.id)), ["sample", "sample-two"], "the selected image is the tail of the active filter");
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample-two")?.reviewed === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample-two", "reviewing the last filtered image never moves backwards");

    await page.locator("#hideAndNextButton").click();
    await page.waitForFunction(() => state.images.find((image) => image.id === "sample-two")?.hidden === true);
    assert.equal(await page.evaluate(() => state.currentId), "sample-two", "hiding the last filtered image keeps that image on screen");

    await page.evaluate(() => {
      const image = state.images.find((item) => item.id === "sample-two");
      image.hidden = false;
      state.hiddenImageIds.delete(image.id);
      renderGallery(true);
    });
    await page.evaluate(async () => {
      const removed = new Set(["sample-two"]);
      const selection = deletionSelectionSnapshot(removed, galleryFilteredImages());
      state.images = state.images.filter((image) => !removed.has(image.id));
      await restoreDeletionSelection(selection, removed);
      renderCatalogViews();
    });
    await page.waitForFunction(() => state.images.length === 1 && state.currentId === "sample");
    assert.deepEqual(await page.evaluate(() => state.images.map((image) => image.id)), ["sample"], "deleting the tail removes it and selects the previous filtered image");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("fill tolerance buttons change one step and candidate deletion is undoable", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await page.locator("#bucketTool").click();
    const tolerance = page.locator("#bucketTolerance");
    const initialTolerance = Number(await tolerance.inputValue());
    await page.locator("#bucketToleranceIncrease").click();
    assert.equal(Number(await tolerance.inputValue()), initialTolerance + 1, "plus raises fill tolerance by one");
    await page.locator("#bucketToleranceDecrease").click();
    assert.equal(Number(await tolerance.inputValue()), initialTolerance, "minus lowers fill tolerance by one");
    await page.locator("#bucketToleranceClose").click();

    await page.evaluate(() => {
      state.settings.confirmations.candidateDelete = false;
      state.candidates = [{ id: "undoable", role: "apply", enabled: true, forced: false, expandPx: 0, confidence: .61, labelToken: "penis", color: "#ff3d4d" }];
      const mask = document.createElement("canvas"); mask.width = originalCanvas.width; mask.height = originalCanvas.height;
      mask.getContext("2d").fillRect(3, 3, 8, 8);
      state.candidateImages = new Map([["undoable", mask]]);
      state.removedCandidateIds = new Set(); resetHistoryToCurrentManualMask(); renderCandidates();
    });
    const row = page.locator('.candidate-row[data-candidate-blink-id="undoable"]');
    assert.equal(await row.locator(".candidate-row-heading > button").getAttribute("class"), "candidate-delete", "candidate remove control is at the row's upper-right heading edge");
    await row.locator(".candidate-delete").click();
    await page.waitForFunction(() => state.removedCandidateIds.has("undoable"));
    assert.equal(await page.evaluate(() => $("#undoButton").disabled), false, "candidate deletion enables undo immediately");
    await page.locator("#undoButton").click();
    await page.waitForFunction(() => !state.removedCandidateIds.has("undoable"));
    assert.equal(await row.locator(".candidate-delete").count(), 1, "undo restores the deleted candidate row");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});
