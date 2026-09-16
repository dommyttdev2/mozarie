"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

test("navigation and overview selection use isolated browser state", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
    await page.locator('.gallery-item[data-id="sample"]').click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.locator("#nextImageButton").click();
    await page.waitForFunction(() => state.currentId === "sample-two");
    await page.locator("#previousImageButton").click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.locator("#reviewAndNextButton").click();
    await page.waitForFunction(() => state.currentId === "sample-two" && state.images.find((image) => image.id === "sample")?.reviewed);
    await page.locator("#previousImageButton").click();
    await page.waitForFunction(() => state.currentId === "sample");
    await page.locator("#hideAndNextButton").click();
    await page.waitForFunction(() => state.currentId === "sample-two" && state.images.find((image) => image.id === "sample")?.hidden);
    await page.locator("#overviewButton").click();
    await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
    // Foldered cards are reached through the rendered overview UI, not a
    // private renderer call. This proves the folder select has real options.
    await page.evaluate(() => {
      state.images[0].relativePath = "nested/sample.png";
      state.images[1].relativePath = "nested/deeper/sample-two.png";
    });
    await page.locator("#closeOverviewButton").click();
    await page.locator("#overviewButton").click();
    await page.waitForFunction(() => document.querySelector("#overviewFolder option[value='nested']"));
    await page.locator("#overviewFolder").selectOption("nested");
    await page.locator("#batchModeButton").click();
    await page.locator('.overview-item[data-id="sample-two"]').click();
    await page.locator('.overview-item[data-id="sample"]').click({ modifiers: ["Control"] });
    await page.locator('.overview-item[data-id="sample"]').click({ modifiers: ["Control", "Shift"] });
    assert.deepEqual(await page.evaluate(() => [...state.selectedImageIds].sort()), ["sample", "sample-two"], "overview modifier selection preserves both images");
  } finally {
    await context.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});
