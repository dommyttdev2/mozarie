const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const staticRoot = path.join(root, "static");
const manifest = fs.readFileSync(path.join(staticRoot, "js", "manifest.js"), "utf8");
const app = [...manifest.matchAll(/"([a-z-]+\.js)"/g)]
  .map((match) => fs.readFileSync(path.join(staticRoot, "js", match[1]), "utf8"))
  .join("\n");
const server = fs.readFileSync(path.join(root, "mozarie", "http.py"), "utf8");

assert.match(app, /api\("\/api\/output-directory\/pick"/);
assert.match(app, /copyToDefault: true, suffix/);
assert.match(app, /api\("\/api\/apply"/);
const save = fs.readFileSync(path.join(staticRoot, "js", "save.js"), "utf8");
assert.doesNotMatch(save, /showDirectoryPicker|indexedDB|outputDirectoryHandle|uniqueOutputFileHandle|writeCopyOutput/);
assert.match(save, /let outputDirectoryPickRequest = null/);
assert.match(save, /state\.outputDirectoryPicking = picking/);
assert.match(save, /if \(!outputDirectoryPickRequest\)/);
assert.match(save, /selected\.path \|\| null/);
assert.match(server, /path == "\/api\/output-directory\/pick"/);
assert.match(server, /if copy_to_default:\s*\n\s*self\._json\(\{"output": str\(rendered\.output_path\)/);
assert.doesNotMatch(server, /browser_save_tokens\.get\(save_token\)/);
console.log("test_browser_save_contract: passed");
