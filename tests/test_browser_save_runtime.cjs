const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");
function runtime(response) {
  const controls = new Map();
  const state = { images: [], applyTargetIds: [], sourceAccess: new Map(), settings: { saving: { default_output_directory: "C:/old" } } };
  const control = () => ({ value: "original", textContent: "", disabled: false, checked: false, hidden: false, classList: { toggle() {} } });
  const context = { state, Map, Set, Promise, JSON, Error, console, t: (key) => key, localStorage: { length: 0, key() { return null; }, getItem() { return null; }, setItem() {}, removeItem() {} }, window: { addEventListener() {} }, document: { querySelectorAll() { return []; }, querySelector() { return control(); } }, $: (selector) => controls.get(selector) || controls.set(selector, control()).get(selector), api: async (...args) => response(...args), updateActionButtons() {} };
  vm.runInNewContext(source, context, { filename: "save.js" });
  vm.runInNewContext("globalThis.pickForTest = pickOutputDirectory;", context);
  return { context, controls, state };
}
test("the save-location action uses the server picker and stores its absolute result", async () => {
  const calls = []; const app = runtime(async (url, options) => { calls.push({ url, options }); return { cancelled: false, path: "G:/output", settings: { saving: { default_output_directory: "G:/output" } } }; });
  assert.equal(await app.context.pickForTest(), "G:/output"); assert.equal(calls[0].url, "/api/output-directory/pick"); assert.equal(calls[0].options.method, "POST"); assert.equal(app.state.settings.saving.default_output_directory, "G:/output");
});
test("the browser no longer requests a File System Access output handle", () => { assert.doesNotMatch(source, /showDirectoryPicker|ensureOutputDirectoryPermission|writeSingleOutput/); assert.match(source, /\/api\/output-directory\/pick/); });
