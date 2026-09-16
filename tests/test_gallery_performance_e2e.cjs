"use strict";

// This deliberately runs outside coverage.  The ordinary frontend runner
// invokes it once after the coverage-friendly suite, so the 20k catalogue is
// exercised without instrumenting or repeating the larger browser scenario.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { closeServer, startFixtureServer } = require("./test_import_picker_e2e.cjs");

async function main() {
  let browser;
  let server;
  let url;
  let setCatalog;
  let resetScenario;
  try {
    ({ server, url, setCatalog, resetScenario } = await startFixtureServer());
    setCatalog(Array.from({ length: 20000 }, (_, index) => ({
      id: `performance-${index}`,
      relativePath: `set-${String(index % 40).padStart(2, "0")}/image-${String(index).padStart(5, "0")}.png`,
      sourceKind: "fixture", width: 100, height: 80,
      candidateCount: 0, enabledCandidateCount: 0, reviewed: index % 2 === 0,
    })));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.showOpenFilePicker = async () => [];
      window.showDirectoryPicker = async () => ({ async *values() {} });
    });
    try {
      const loadStart = performance.now();
      await page.goto(url, { waitUntil: "networkidle" });
      const loadElapsed = performance.now() - loadStart;
      const mounted = await page.locator(".gallery-item, .overview-item").count();
      assert.ok(loadElapsed <= 1500, `20k catalogue becomes interactive within 1.5s (actual ${loadElapsed.toFixed(1)}ms)`);
      assert.ok(mounted < 2000, `20k catalogue keeps mounted cards below 2000 (actual ${mounted})`);
      const timings = [];
      for (let index = 0; index < 10; index += 1) {
        let started = performance.now();
        await page.locator("#overviewButton").click();
        await page.waitForFunction(() => !document.querySelector("#overviewPane").hidden);
        timings.push(performance.now() - started);
        started = performance.now();
        await page.locator("#closeOverviewButton").click();
        await page.waitForFunction(() => document.querySelector("#overviewPane").hidden);
        timings.push(performance.now() - started);
        started = performance.now();
        const filter = index % 2 ? "reviewed" : "unreviewed";
        await page.locator("#galleryFilterButton").click();
        for (const input of await page.locator("[data-gallery-filter]:checked").all()) await input.uncheck();
        await page.locator(`[data-gallery-filter="${filter}"]`).check();
        await page.waitForFunction((value) => state.galleryFilter instanceof Set && state.galleryFilter.size === 1 && state.galleryFilter.has(value), filter);
        await page.locator("#galleryFilterButton").click();
        timings.push(performance.now() - started);
      }
      const p95 = [...timings].sort((left, right) => left - right)[Math.ceil(timings.length * 0.95) - 1];
      assert.ok(p95 <= 250, `gallery switch and filter p95 is within 250ms (actual ${p95.toFixed(1)}ms)`);
      console.log(`browser performance: 20k initial=${loadElapsed.toFixed(1)}ms mounted=${mounted} switch-filter-p95=${p95.toFixed(1)}ms`);
    } finally {
      await context.close();
      resetScenario();
    }
  } finally {
    await browser?.close();
    if (server) await closeServer(server);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
