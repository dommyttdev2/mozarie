const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let response;
let transfer;
const self = { postMessage(value, transferList) { response = value; transfer = transferList; } };
const context = vm.createContext({ self, Uint8ClampedArray, Math });
const workerPath = path.join(__dirname, "..", "static", "js", "masked-mosaic-worker.js");
vm.runInContext(fs.readFileSync(workerPath, "utf8"), context, { filename: workerPath });

function render(source, mask, width, height, blockSize, generation) {
  self.onmessage({ data: {
    source: new Uint8ClampedArray(source).buffer,
    mask: new Uint8ClampedArray(mask).buffer,
    width,
    height,
    blockSize,
    generation,
  } });
  return new Uint8ClampedArray(response.output);
}

const averaged = render([
  100, 0, 0, 255,
  0, 100, 0, 255,
  9, 9, 9, 255,
], [255, 255, 0], 3, 1, 2, 7);
assert.deepEqual([...averaged], [50, 50, 0, 255, 50, 50, 0, 255, 9, 9, 9, 255], "masked pixels use their alpha-weighted block colour and unmasked pixels stay unchanged");
assert.equal(response.generation, 7, "the generation is returned unchanged");
assert.equal(transfer.length, 1, "the worker transfers one output buffer");
assert.equal(transfer[0], response.output, "the transferred buffer is the response output");

const transparent = render([30, 40, 50, 0], [255], 1, 1, 1, 8);
assert.deepEqual([...transparent], [30, 40, 50, 0], "a fully transparent masked pixel does not invent an RGB colour");
assert.equal(response.generation, 8, "each render returns its own generation");

console.log("test_masked_mosaic_worker: passed");
