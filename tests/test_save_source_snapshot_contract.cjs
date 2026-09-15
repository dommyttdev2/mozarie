const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "js", "save.js"), "utf8");
const interaction = fs.readFileSync(path.join(__dirname, "..", "static", "js", "interaction.js"), "utf8");

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
  assert.equal(
    await snapshotSourceHandle({ fileHandle: { getFile: async () => ({}) } }),
    null,
    "a non-Blob browser source cannot proceed to deletion",
  );
  for (const marker of [
    "if (!(sourceSnapshot instanceof Blob)) return { deleted: false, error: codedError(\"source_restore_failed\") };",
    "const sourceDelete = await deleteCopiedBrowserSource(sourceImage, saveToken);",
    "await restoreCopiedBrowserSourcesAfterRejectedDelete(pending)",
  ]) assert.ok(source.includes(marker), `${marker} must keep a browser copy/delete reversible until its separate receipt commits`);
  for (const endpoint of [
    "/api/catalog/delete-source",
    "/api/catalog/delete-source/prepare",
    "/api/catalog/delete-source/claim",
    "/api/catalog/delete-source/release",
  ]) {
    const calls = [...interaction.matchAll(new RegExp(`catalogApi\\(\\"${endpoint.replaceAll("/", "\\/")}\\"[^\\n]*`, "g"))];
    assert.ok(calls.length, `${endpoint} must use catalogApi`);
    for (const call of calls) assert.match(call[0], /method: "POST"/, `${endpoint} must explicitly POST its mutation`);
  }
})();
