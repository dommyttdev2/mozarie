"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function freshPage(browser, fixture) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.showOpenFilePicker = async () => [];
    window.showDirectoryPicker = async () => ({ async *values() {} });
  });
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
