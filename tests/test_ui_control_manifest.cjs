const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { controls, dynamicControls } = require("./ui-control-manifest.cjs");

const html = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const actual = [...html.matchAll(/<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => match[2]);
assert.equal(new Set(actual).size, actual.length, "static controls must not reuse ids");
assert.equal(new Set(controls.map((control) => control.id)).size, controls.length, "manifest control ids must be unique");
assert.deepEqual([...new Set(controls.map((control) => control.id))].sort(), [...new Set(actual)].sort(), "every static id-addressable control needs an interaction contract");
for (const control of controls) {
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(control.expected);
}
assert.equal(new Set(dynamicControls.map((control) => control.selector)).size, dynamicControls.length, "dynamic control selectors must be unique");
for (const control of dynamicControls) {
  assert.ok(control.selector, "dynamic controls need an explicit selector contract");
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(control.expected, "dynamic controls need an expected result");
}
console.log(`test_ui_control_manifest: ${controls.length} id controls and ${dynamicControls.length} dynamic contracts`);
