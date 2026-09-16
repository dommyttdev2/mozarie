const test = require("node:test");
const { chromium } = require("playwright");
const { runCandidateBlinkScenario } = require("./test_import_picker_e2e.cjs");

async function runScenario(expanded) {
  const browser = await chromium.launch();
  try { await runCandidateBlinkScenario(browser, expanded); }
  finally { await browser.close(); }
}

test("candidate rows work in the normal inspector", { timeout: 60000 }, async () => {
  await runScenario(false);
});

test("candidate rows work in the expanded inspector", { timeout: 60000 }, async () => {
  await runScenario(true);
});