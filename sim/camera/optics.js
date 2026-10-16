/**
 * Camera simulation: Optical point spread function (PSF) blur.
 */

/**
 * Applies separable Gaussian blur to float32 linear buffer.
 *
 * @param {Float32Array} buf - [w * h * 3] interleaved RGB
 * @param {number} w
 * @param {number} h
 * @param {number} sigma - PSF standard deviation
 * @returns {Float32Array}
 */
export function applyPSF(buf, w, h, sigma) {
  if (sigma <= 0.2) return buf;

  const radius = Math.min(5, Math.ceil(sigma * 2.5));
  const kernelSize = radius * 2 + 1;
  const kernel = new Float32Array(kernelSize);

  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const val = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = val;
    sum += val;
  }
  for (let i = 0; i < kernelSize; i++) kernel[i] /= sum;

  const temp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 3;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const nx = Math.max(0, Math.min(w - 1, x + k));
        const idx = rowOffset + nx * 3;
        const weight = kernel[k + radius];
        r += buf[idx] * weight;
        g += buf[idx + 1] * weight;
        b += buf[idx + 2] * weight;
      }
      const outIdx = rowOffset + x * 3;
      temp[outIdx] = r;
      temp[outIdx + 1] = g;
      temp[outIdx + 2] = b;
    }
  }

  // Vertical pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const ny = Math.max(0, Math.min(h - 1, y + k));
        const idx = (ny * w + x) * 3;
        const weight = kernel[k + radius];
        r += temp[idx] * weight;
        g += temp[idx + 1] * weight;
        b += temp[idx + 2] * weight;
      }
      const outIdx = (y * w + x) * 3;
      out[outIdx] = r;
      out[outIdx + 1] = g;
      out[outIdx + 2] = b;
    }
  }

  return out;
}
