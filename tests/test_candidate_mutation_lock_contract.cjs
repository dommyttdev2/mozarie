const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "editor-masks.js"), "utf8");
const start = source.indexOf("function renderCandidates() {");
assert.notEqual(start, -1, "renderCandidates must exist");
const end = source.indexOf("\nfunction candidateDisplayMode", start);
assert.notEqual(end, -1, "renderCandidates must end before candidateDisplayMode");
const renderCandidates = source.slice(start, end);

assert.match(renderCandidates, /const candidateMutationLocked = candidateLocked \|\| state\.projectReadOnly \|\| currentRecord\(\)\?\.sourceDimensionsChanged \|\| candidateViewLocked;/, "candidate mutations must share the complete view lock");

const manualStart = renderCandidates.indexOf("  const appendManual = (list, role) => {");
const manualEnd = renderCandidates.indexOf("  appendManual(applyList, \"apply\");", manualStart);
assert.notEqual(manualStart, -1, "manual candidate rows must exist");
assert.notEqual(manualEnd, -1, "manual candidate rows must end before they are appended");
const manualRows = renderCandidates.slice(manualStart, manualEnd);
assert.match(manualRows, /const enabled = makeToggle\([\s\S]*?\}, candidateMutationLocked\);/, "manual apply and exclude toggles must use the mutation lock");
assert.match(manualRows, /remove\.disabled = candidateMutationLocked;/, "manual apply and exclude deletes must use the mutation lock");
assert.match(manualRows, /const forced = makeForceToggle\([\s\S]*?\}, candidateMutationLocked\);/, "manual exclusion force must use the mutation lock");
assert.match(manualRows, /const blink = makeDisplay\(blinkId, role\);/, "manual display controls must remain independent of the mutation lock");

const eraseStart = renderCandidates.indexOf("  if (presence.hasManualExclusionErase) {");
const eraseEnd = renderCandidates.indexOf("  for (const candidate of state.candidates) {", eraseStart);
assert.notEqual(eraseStart, -1, "manual exclusion erase row must exist");
assert.notEqual(eraseEnd, -1, "manual exclusion erase row must end before detected candidates");
const eraseRow = renderCandidates.slice(eraseStart, eraseEnd);
assert.match(eraseRow, /const enabled = makeToggle\([\s\S]*?\}, candidateMutationLocked\);/, "manual exclusion erase toggle must use the mutation lock");
assert.match(eraseRow, /remove\.disabled = candidateMutationLocked;/, "manual exclusion erase delete must use the mutation lock");

const detectedStart = renderCandidates.indexOf("  for (const candidate of state.candidates) {");
const detectedEnd = renderCandidates.indexOf("  appendEmpty(applyList);", detectedStart);
assert.notEqual(detectedStart, -1, "detected candidate rows must exist");
assert.notEqual(detectedEnd, -1, "detected candidate rows must end before empty rows");
const detectedRows = renderCandidates.slice(detectedStart, detectedEnd);
assert.match(detectedRows, /const enabled = makeToggle\([\s\S]*?\}, deleting \|\| candidateMutationLocked\);/, "detected toggle must combine its delete lock with the mutation lock");
assert.match(detectedRows, /remove\.disabled = deleting \|\| candidateMutationLocked;/, "detected delete must combine its delete lock with the mutation lock");
assert.match(detectedRows, /const forced = makeForceToggle\([\s\S]*?\}, deleting \|\| candidateMutationLocked\);/, "detected exclusion force must combine its delete lock with the mutation lock");
assert.equal((detectedRows.match(/makeExpandButton\(candidate, deleting \|\| candidateMutationLocked, labelText\)/g) || []).length, 2, "detected apply and exclusion padding must combine their delete lock with the mutation lock");
assert.match(detectedRows, /candidateEffectiveToggle\(candidate\.id, role\)/, "detected effective display controls must remain independent of the mutation lock");
