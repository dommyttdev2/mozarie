const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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

function compiled(name, dependencies) {
  const names = Object.keys(dependencies);
  return new Function(...names, `${functionSource(name)}; return ${name};`)(...names.map((key) => dependencies[key]));
}

const codedError = (code) => Object.assign(new Error(code), { code });

test("a missing browser source snapshot starts neither deletion nor commit", async (t) => {
  const prepare = t.mock.fn();
  const claim = t.mock.fn();
  const deleteHandle = t.mock.fn();
  const commit = t.mock.fn();
  const removeSource = compiled("deleteCopiedBrowserSource", {
    browserDeleteEntry: () => ({ fileHandle: { getFile: async () => ({}) }, state: "ready" }),
    snapshotSourceHandle: async () => null,
    codedError,
    crypto: { randomUUID: () => "delete-token" },
    rememberPendingSourceDelete: t.mock.fn(),
    catalogApi: prepare,
    claimSourceDelete: claim,
    browserDeleteHandle: deleteHandle,
    commitSourceDeleteWithRetry: commit,
    api: t.mock.fn(),
    acknowledgeSourceDelete: t.mock.fn(),
    isDefinitiveCommitRejection: () => true,
    restoreCopiedBrowserSourcesAfterRejectedDelete: t.mock.fn(),
    console,
  });

  const result = await removeSource({ id: "image-1" }, "save-token");
  assert.equal(result.deleted, false);
  assert.equal(result.error.code, "source_restore_failed");
  for (const mock of [prepare, claim, deleteHandle, commit]) assert.equal(mock.mock.callCount(), 0);
});

test("a definitive delete commit rejection restores the exact Blob source", async (t) => {
  const snapshot = new Blob(["original bytes"]);
  const entry = { fileHandle: { getFile: async () => snapshot }, state: "ready" };
  const restored = t.mock.fn();
  const remembered = t.mock.fn(async () => {});
  const released = t.mock.fn(async () => {});
  const acknowledged = t.mock.fn(async () => {});
  const request = t.mock.fn(async () => ({ state: "cancelled" }));
  const restore = compiled("restoreCopiedBrowserSourcesAfterRejectedDelete", {
    Blob,
    restoreSourceHandle: restored,
    rememberPendingSourceDelete: remembered,
    releaseSourceDeleteClaim: released,
    api: request,
    acknowledgeSourceDelete: acknowledged,
  });
  const removeSource = compiled("deleteCopiedBrowserSource", {
    browserDeleteEntry: () => entry,
    snapshotSourceHandle: async () => snapshot,
    codedError,
    crypto: { randomUUID: () => "delete-token" },
    rememberPendingSourceDelete: remembered,
    catalogApi: t.mock.fn(async () => ({ preparedImageIds: ["image-1"] })),
    claimSourceDelete: t.mock.fn(async () => {}),
    browserDeleteHandle: t.mock.fn(async () => {}),
    commitSourceDeleteWithRetry: t.mock.fn(async () => { throw codedError("input_invalid"); }),
    api: request,
    acknowledgeSourceDelete: acknowledged,
    isDefinitiveCommitRejection: (error) => error.code === "input_invalid",
    restoreCopiedBrowserSourcesAfterRejectedDelete: restore,
    console,
  });

  const result = await removeSource({ id: "image-1" }, "save-token");
  assert.equal(result.deleted, false);
  assert.equal(result.error.code, "input_invalid");
  assert.equal(restored.mock.callCount(), 1);
  assert.deepEqual(restored.mock.calls[0].arguments, [entry, snapshot, true]);
  assert.equal(entry.state, "ready");
  assert.equal(released.mock.callCount(), 1);
  assert.equal(acknowledged.mock.callCount(), 1);
});

test("all source-delete mutations explicitly POST", () => {
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
});
