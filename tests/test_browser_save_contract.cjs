const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static");
const manifest = fs.readFileSync(path.join(staticRoot, "js", "manifest.js"), "utf8");
const app = [...manifest.matchAll(/"([a-z-]+\.js)"/g)]
  .map((match) => fs.readFileSync(path.join(staticRoot, "js", match[1]), "utf8"))
  .join("\n");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert.match(app, /window\.showDirectoryPicker\(\{ mode: "readwrite", id: "mozarie-output" \}\)/);
assert.match(app, /createWritable\(\{ keepExistingData: false \}\)/);
assert.match(app, /indexedDB\.open\(OUTPUT_HANDLE_DB, 1\)/);
assert.doesNotMatch(app, /api\("\/api\/dialog\/output-directory"/);
assert.doesNotMatch(app, /api\("\/api\/save\/copy"/);
assert.match(app, /response\.headers\?\.get\("X-Mozarie-Save-Token"\)/);
assert.match(app, /candidateRevision: entry\.candidateRevision, deleteOriginal, sourceAction, saveToken/);
assert.doesNotMatch(app, /deleteOriginal: entry\.deleteOriginal/);
assert.ok(app.indexOf("writeCopyOutput(directory, entry, suffix, bytes)") < app.indexOf('api("/api/save/commit"'), "the output must be written before commit");
assert.match(readme, /Saving preserves image metadata/);
assert.match(readme, /never downloads or bundles models/);

console.log("test_browser_save_contract: passed");
