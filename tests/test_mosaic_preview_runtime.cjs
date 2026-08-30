const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const draws = [];
class Worker {
  constructor() { this.onmessage = null; }
  postMessage() {}
  terminate() {}
}
const imageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const canvas = (width = 3840, height = 2160) => ({ width, height });
const state = {
  mosaicPreviewEnabled: true, currentImage: { width: 3840, height: 2160 }, mosaicPreviewGeneration: 0,
  mosaicWorker: null, mosaicWorkerBusy: false, mosaicPending: false,
};
const context = {
  Worker, ImageData: imageData, Uint8Array, Uint8ClampedArray, state,
  requestAnimationFrame: () => 1,
  originalCanvas: canvas(), combinedCanvas: canvas(), mosaicCanvas: canvas(),
  originalCtx: { clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(3840 * 2160 * 4) }) },
  combinedCtx: { getImageData: () => ({ data: new Uint8ClampedArray(3840 * 2160 * 4) }) },
  mosaicCtx: { putImageData: () => draws.push("preview") },
  calculatedBlockSize: () => 16, flushMaskComposition() {}, prepareOriginalImage() {}, render() {},
};
const canvasPath = path.join(__dirname, "..", "static", "js", "editor-canvas.js");
vm.runInNewContext(fs.readFileSync(canvasPath, "utf8"), context, { filename: canvasPath });
context.postMosaicPreview = () => {};
context.rebuildMosaicPreview();
const worker = state.mosaicWorker;
state.mosaicPending = true; // A new 4K drag sample arrived while this frame ran.
worker.onmessage({ data: { generation: 1, output: new Uint8ClampedArray(3840 * 2160 * 4).buffer } });
assert.deepEqual(draws, ["preview"], "the completed 4K frame is displayed before the queued update");
console.log("test_mosaic_preview_runtime: passed");
