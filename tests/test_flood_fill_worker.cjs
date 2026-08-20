const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
let response;
let transfer;
const self = { postMessage(value, transferList) { response = value; transfer = transferList; } };
const context = vm.createContext({ self, Uint8ClampedArray, Uint8Array, Int32Array, Math });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "flood-fill-worker.js"), "utf8"), context);
const pixels = new Uint8ClampedArray([
  10, 10, 10, 255, 11, 11, 11, 255, 200, 200, 200, 255,
  11, 11, 11, 255, 10, 10, 10, 255, 200, 200, 200, 255,
  200, 200, 200, 255, 200, 200, 200, 255, 10, 10, 10, 255,
]);
self.onmessage({ data: { pixels: pixels.buffer, width: 3, height: 3, x: 0, y: 0, tolerance: 2 } });
assert.deepEqual([...response.spans], [0, 0, 2, 1, 0, 2], "four-connected matching pixels only");
assert.equal(transfer.length, 1, "spans have one transfer buffer");
assert.equal(transfer[0], response.spans.buffer, "spans remain transferred rather than copied");
console.log("test_flood_fill_worker: passed");
