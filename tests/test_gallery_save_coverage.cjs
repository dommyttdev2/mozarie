const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");
test("browser copy save keeps output publication and source deletion as separate phases", () => { assert.match(source, /snapshotSourceHandle/); assert.match(source, /commitBrowserSaveWithRetry/); assert.match(source, /deleteCopiedBrowserSource/); assert.doesNotMatch(source, /showDirectoryPicker/); });
test("the save flow remembers pending work in browser storage for recovery", () => { assert.match(source, /pendingSaveStorageKey/); assert.match(source, /reconcilePendingBrowserSaves/); assert.match(source, /window\.addEventListener\("online"/); });
