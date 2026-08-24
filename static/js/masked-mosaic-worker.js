self.onmessage = ({ data }) => {
  const { source, mask, width, height, blockSize, generation } = data;
  const pixels = new Uint8ClampedArray(source); const alpha = new Uint8ClampedArray(mask); const output = new Uint8ClampedArray(pixels);
  for (let top = 0; top < height; top += blockSize) for (let left = 0; left < width; left += blockSize) {
    const bottom = Math.min(height, top + blockSize); const right = Math.min(width, left + blockSize);
    let count = 0; let red = 0; let green = 0; let blue = 0; let weight = 0;
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const pixel = y * width + x; if (!alpha[pixel]) continue;
      const index = pixel * 4; count += 1; const a = pixels[index + 3];
      red += pixels[index] * a; green += pixels[index + 1] * a; blue += pixels[index + 2] * a; weight += a;
    }
    if (!count) continue;
    const rgb = weight ? [Math.floor((red + Math.floor(weight / 2)) / weight), Math.floor((green + Math.floor(weight / 2)) / weight), Math.floor((blue + Math.floor(weight / 2)) / weight)] : null;
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
      const pixel = y * width + x; if (!alpha[pixel] || !rgb) continue; const index = pixel * 4;
      output[index] = rgb[0]; output[index + 1] = rgb[1]; output[index + 2] = rgb[2];
    }
  }
  self.postMessage({ generation, output: output.buffer }, [output.buffer]);
};
