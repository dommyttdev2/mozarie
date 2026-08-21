const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");

assert.match(source, /if \(copy && !\$\("#deleteOriginal"\)\.checked\)/);
assert.match(source, /copyToDefault: true, suffix/);
assert.match(source, /await removeSourceHandle\(access\);\s*\n\s*sourceAction = "deleted"/);
assert.match(source, /saveToken: response\.saveToken/);
assert.doesNotMatch(source, /navigator\.locks|outputHandle|directory\.getFileHandle/);
console.log("test_browser_save_runtime: passed");
