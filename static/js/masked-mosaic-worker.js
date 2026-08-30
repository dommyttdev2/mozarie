let source = null;
let sourceId = "";
let sourceCanvas = null;
let sourceContext = null;
let maskCanvas = null;
let maskContext = null;
let outputCanvas = null;
let outputContext = null;

function releaseSource() {
  source?.close?.();
  source = null; sourceId = ""; sourceCanvas = null; sourceContext = null; maskCanvas = null; maskContext = null; outputCanvas = null; outputContext = null;
}

function fail(generation) { self.postMessage({ type: "error", code: "mosaic_preview_failed", generation }); }

function render({ mask, width, height, blockSize, generation }) {
  if (!source || !sourceContext || !mask || source.width !== width || source.height !== height) return fail(generation);
  try {
    if (!maskCanvas || maskCanvas.width !== width || maskCanvas.height !== height) {
      maskCanvas = new OffscreenCanvas(width, height); maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
      outputCanvas = new OffscreenCanvas(width, height); outputContext = outputCanvas.getContext("2d");
      if (!maskContext || !outputContext) throw new Error("2d context unavailable");
    }
    sourceContext.clearRect(0, 0, width, height);
    sourceContext.drawImage(source, 0, 0);
    const pixels = sourceContext.getImageData(0, 0, width, height).data;
    maskContext.clearRect(0, 0, width, height); maskContext.drawImage(mask, 0, 0);
    const alphaPixels = maskContext.getImageData(0, 0, width, height).data;
    const output = new Uint8ClampedArray(pixels);
    for (let top = 0; top < height; top += blockSize) for (let left = 0; left < width; left += blockSize) {
      const bottom = Math.min(height, top + blockSize); const right = Math.min(width, left + blockSize);
      let count = 0; let red = 0; let green = 0; let blue = 0; let weight = 0;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const pixel = y * width + x; if (!alphaPixels[pixel * 4 + 3]) continue;
        const index = pixel * 4; count += 1; const a = pixels[index + 3];
        red += pixels[index] * a; green += pixels[index + 1] * a; blue += pixels[index + 2] * a; weight += a;
      }
      if (!count) continue;
      const rgb = weight ? [Math.floor((red + Math.floor(weight / 2)) / weight), Math.floor((green + Math.floor(weight / 2)) / weight), Math.floor((blue + Math.floor(weight / 2)) / weight)] : null;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const pixel = y * width + x; if (!alphaPixels[pixel * 4 + 3] || !rgb) continue; const index = pixel * 4;
        output[index] = rgb[0]; output[index + 1] = rgb[1]; output[index + 2] = rgb[2];
      }
    }
    outputContext.putImageData(new ImageData(output, width, height), 0, 0);
    const frame = outputCanvas.transferToImageBitmap();
    self.postMessage({ type: "frame", sourceId, generation, output: frame }, [frame]);
  } catch { fail(generation); } finally { mask.close?.(); }
}

self.onmessage = ({ data }) => {
  if (data.type === "release") return releaseSource();
  if (data.type === "source") {
    releaseSource();
    try {
      source = data.source; sourceId = data.sourceId;
      sourceCanvas = new OffscreenCanvas(source.width, source.height);
      sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) throw new Error("2d context unavailable");
    } catch { releaseSource(); fail(data.generation); }
    return;
  }
  if (data.type === "render" && data.sourceId === sourceId) render(data);
};
