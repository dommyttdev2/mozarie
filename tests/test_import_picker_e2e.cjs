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
  const server = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    if (requestPath === "/api/images") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ images: [], root: "" }));
      return;
    }
    if (requestPath === "/api/job") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ state: "idle" }));
      return;
    }

    const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(staticRoot, relativePath);
    if (!filePath.startsWith(`${staticRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
      response.end(await fs.readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main() {
  let server;
  let browser;
  let fixtureUrl;
  try {
    ({ server, url: fixtureUrl } = await startFixtureServer());
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(fixtureUrl, { waitUntil: "networkidle" });
    const menu = page.locator("#pickerMenu");
    assert.equal(await menu.isVisible(), false, "the picker menu should be initially hidden");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), false, "the picker menu should initially be closed");

    await page.locator("#pickFolder").click();
    assert.equal(await menu.isVisible(), true, "the picker menu should be visible after opening");
    assert.equal(await menu.evaluate((element) => element.matches(":popover-open")), true, "the picker menu should be open after opening");

    const imagesChooser = page.waitForEvent("filechooser");
    await page.locator("#pickImages").click();
    assert.equal(await (await imagesChooser).element().getAttribute("id"), "importImagesInput");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting image files");

    await page.locator("#pickFolder").click();
    const folderChooser = page.waitForEvent("filechooser");
    await page.locator("#pickFolderFiles").click();
    const folderInput = (await folderChooser).element();
    assert.equal(await folderInput.getAttribute("id"), "importFolderInput");
    assert.notEqual(await folderInput.getAttribute("webkitdirectory"), null, "the folder input should allow directory selection");
    await page.waitForFunction(() => !document.querySelector("#pickerMenu").matches(":popover-open"));
    assert.equal(await menu.isVisible(), false, "the picker menu should close before selecting a folder");

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
