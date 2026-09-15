const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");

function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} body is incomplete`);
}

const codedError = (code) => Object.assign(new Error(code), { code });
const snapshotSourceHandle = new Function("codedError", `${functionSource("snapshotSourceHandle")}; return snapshotSourceHandle;`)(codedError);

(async () => {
  await assert.rejects(
    snapshotSourceHandle({ fileHandle: { getFile: async () => ({}) } }),
    (error) => error?.code === "source_restore_failed",
  );
  for (const marker of [
    "if (output && !(deleteOriginal && access?.fileHandle && sourceSnapshot === null))",
    "if (!(inputs.deleteOriginal && access?.fileHandle && sourceSnapshot === null)) await inputs.outputDirectoryHandle.removeEntry",
  ]) assert.ok(source.includes(marker), `${marker} must preserve a completed copy when its source snapshot is unavailable`);
})();
