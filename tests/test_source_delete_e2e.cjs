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

test("Delete shortcut keeps a durable source-delete intent through claim and acknowledges the committed receipt", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    fixture.holdSourceDeleteClaim(true);
    ({ context, page } = await freshPage(browser, fixture));
    const card = page.locator('.gallery-item[data-id="sample"]');
    await card.click();
    await page.waitForFunction(() => state.currentId === "sample" && state.currentImage);
    await card.focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => document.querySelector("#confirmDialog").open);
    assert.match(await page.locator("#confirmMessage").textContent(), /元画像/, "the source delete warning identifies that the original file is deleted");
    await page.locator("#confirmAccept").click();
    await page.waitForFunction(async () => (await pendingSourceDeletes()).some((entry) => entry.imageIds?.includes("sample")));
    const pending = await page.evaluate(async () => (await pendingSourceDeletes()).find((entry) => entry.imageIds?.includes("sample")));
    assert.deepEqual(pending.browserEntries, [], "a filesystem source persists its delete intent before the server claim without a browser-handle entry");
    fixture.releaseSourceDeleteClaims();
    await page.waitForFunction(() => !state.images.some((image) => image.id === "sample"));
    await page.waitForFunction(() => !state.catalogMutation);
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [
      "/api/catalog/delete-source/prepare",
      "/api/catalog/delete-source/claim",
      "/api/catalog/delete-source",
    ], "Delete drives the ordered prepare, claim, and commit protocol");
    assert.deepEqual(fixture.sourceDeleteRequests.map(({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration }) => ({ expectedProjectId, expectedCatalogGeneration, headerProjectId, headerCatalogGeneration })), [
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
      { expectedProjectId: null, expectedCatalogGeneration: 1, headerProjectId: "", headerCatalogGeneration: "1" },
    ], "every source-delete mutation uses the same captured catalog epoch in its body and headers");
    await page.waitForFunction(async () => (await pendingSourceDeletes()).length === 0);
    assert.deepEqual(fixture.sourceDeleteOperations(), [], "acknowledgement removes the server receipt only after commit is visible to the browser");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});

test("unknown browser-source deletion remains recoverable instead of silently committing or cancelling", { timeout: 60000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await chromium.launch({ headless: true });
  let context; let page;
  try {
    ({ context, page } = await freshPage(browser, fixture));
    const token = "00000000-0000-4000-8000-000000000001";
    fixture.setSourceDeleteOperation(token, {
      state: "claimed",
      imageIds: ["sample-two"],
      preparedSourceKinds: { "sample-two": "session" },
    });
    await page.evaluate(async (deleteToken) => {
      await rememberPendingSourceDelete({
        deleteToken,
        imageIds: ["sample-two"],
        browserDeletedImageIds: [],
        browserEntries: [{ imageId: "sample-two", name: "sample-two.png", state: "unknown", fileHandle: {}, parentHandle: {} }],
      });
      await resumePendingSourceDeletes();
    }, token);
    assert.deepEqual(await page.evaluate(async () => (await pendingSourceDeletes()).map((entry) => ({ token: entry.deleteToken, state: entry.browserEntries[0]?.state }))), [{ token, state: "unknown" }], "an indeterminate browser deletion remains durable for a later recovery attempt");
    assert.equal(fixture.sourceDeleteOperations()[0]?.[1]?.state, "claimed", "the server receipt stays claimed while the browser source outcome is unknown");
    assert.deepEqual(fixture.sourceDeleteRequests.map((request) => request.path), [], "unknown browser deletion never commits a source removal");
  } finally {
    await context?.close();
    await browser.close();
    await closeServer(fixture.server);
  }
});
