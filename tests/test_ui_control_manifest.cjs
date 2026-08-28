const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { controls, dynamicControls, scenarioContracts } = require("./ui-control-manifest.cjs");

const html = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const resultKinds = new Set(["api", "canvas", "dialog", "disabled", "dom", "download", "history", "navigation", "value"]);
const scenarios = new Set(["candidate", "confirmation", "detection", "editor", "gallery", "import", "overview", "processing", "save", "settings", "workspace"]);
const actual = [...html.matchAll(/<(button|input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map((match) => match[2]);
assert.equal(new Set(actual).size, actual.length, "static controls must not reuse ids");
assert.equal(new Set(controls.map((control) => control.id)).size, controls.length, "manifest control ids must be unique");
assert.deepEqual([...new Set(controls.map((control) => control.id))].sort(), [...new Set(actual)].sort(), "every static id-addressable control needs an interaction contract");
for (const control of controls) {
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(resultKinds.has(control.resultKind), `unknown result kind for ${control.id}`);
  assert.ok(scenarios.has(control.scenario), `unknown scenario for ${control.id}`);
  assert.ok(control.expected);
}
assert.equal(new Set(dynamicControls.map((control) => control.selector)).size, dynamicControls.length, "dynamic control selectors must be unique");
for (const control of dynamicControls) {
  assert.ok(control.selector, "dynamic controls need an explicit selector contract");
  assert.match(control.action, /^(click|change|keyboard)$/);
  assert.ok(resultKinds.has(control.resultKind), `unknown result kind for ${control.selector}`);
  assert.ok(scenarios.has(control.scenario), `unknown scenario for ${control.selector}`);
  assert.ok(control.expected, "dynamic controls need an expected result");
}
for (const [scenario, contract] of Object.entries(scenarioContracts)) {
  assert.ok(scenarios.has(scenario), `unknown scenario contract ${scenario}`);
  assert.ok(contract.controls.length, `${scenario} needs controls`);
  assert.ok(contract.assertions.length, `${scenario} needs concrete assertions`);
}
for (const control of [...controls, ...dynamicControls]) {
  const key = control.id || control.selector;
  assert.ok(scenarioContracts[control.scenario]?.controls.includes(key), `${key} must be registered in its scenario`);
}
console.log(`test_ui_control_manifest: ${controls.length} id controls and ${dynamicControls.length} dynamic contracts`);
