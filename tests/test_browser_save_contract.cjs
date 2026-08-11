const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "static", "app.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert.match(app, /window\.showDirectoryPicker\(\{ id: "lets-censoring-output", mode: "readwrite" \}\)/);
assert.match(app, /response\.headers\?\.get\("X-Lets-Censoring-Save-Token"\)/);
assert.match(app, /candidateRevision: entry\.candidateRevision, deleteOriginal, sourceAction, saveToken/);
assert.doesNotMatch(app, /deleteOriginal: entry\.deleteOriginal/);
assert.ok(app.indexOf("await stream.close()") < app.indexOf('api("/api/save/commit"'), "commit must occur after close");
assert.match(app, /file\.size !== 0 \|\| file\.lastModified \+ 2000 < reservedAt/);
assert.match(app, /\$\{stem\}\$\{suffix\}\$\{number === 1 \? "" : `_\$\{number\}`\}\$\{extension\}/);
assert.doesNotMatch(app, /removeEntry\(output\.name\)/, "browser save must not delete an output with uncertain ownership");
assert.match(readme, /空の予約ファイルが残る場合があります/);

console.log("test_browser_save_contract: passed");
