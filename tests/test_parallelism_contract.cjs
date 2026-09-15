const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const detection = fs.readFileSync(path.join(root, "static", "js", "detection.js"), "utf8");
const interaction = fs.readFileSync(path.join(root, "static", "js", "interaction.js"), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

const normaliseImportParallelism = new Function(`${functionSource(detection, "normaliseImportParallelism")}; return normaliseImportParallelism;`)();
assert.equal(normaliseImportParallelism(11), 11, "an 11-worker import setting must not be rounded down to 10");
assert.equal(normaliseImportParallelism(11.4), 11, "the normal integer worker conversion remains stable");
assert.ok(interaction.includes("const workerCount = Math.min(supportedFiles.length, session.requestedParallelism);"), "the browser must cap only by selected file count");
for (const filename of ["core.py", "state.py", "http.py"]) {
  const source = fs.readFileSync(path.join(root, "mozarie", filename), "utf8");
  for (const gate of ["import_staging_gate", "thumbnail_gate", "THUMBNAIL_WORKERS", "thumbnail_generation_lock"]) {
    assert.ok(!source.includes(gate), `${filename} must not restore ${gate}`);
  }
}
