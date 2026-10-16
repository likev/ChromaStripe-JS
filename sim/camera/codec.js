/**
 * Camera simulation: BT.601 YCbCr 4:2:0 chroma subsampling and reconstruction.
 */

export function applyChroma420(rgba, w, h) {
  const halfW = w >>> 1;
  const halfH = h >>> 1;

  const yPlane = new Float32Array(w * h);
  const cbPlane = new Float32Array(halfW * halfH);
  const crPlane = new Float32Array(halfW * halfH);

  // RGB -> YCbCr BT.601
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const idx = (rowOffset + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];

      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      const Cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      const Cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;

      yPlane[rowOffset + x] = Y;

      // Downsample 2x2 box for Cb and Cr
      const hx = x >>> 1;
      const hy = y >>> 1;
      if (hx < halfW && hy < halfH) {
        const cIdx = hy * halfW + hx;
        cbPlane[cIdx] += Cb * 0.25;
        crPlane[cIdx] += Cr * 0.25;
      }
    }
  }

  // YCbCr -> RGB with bilinear upsampling on Cb/Cr
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    const hy = Math.min(halfH - 1, y >>> 1);
    for (let x = 0; x < w; x++) {
      const hx = Math.min(halfW - 1, x >>> 1);
      const cIdx = hy * halfW + hx;

      const Y = yPlane[rowOffset + x];
      const Cb = cbPlane[cIdx] - 128;
      const Cr = crPlane[cIdx] - 128;

      const r = Y + 1.402 * Cr;
      const g = Y - 0.344136 * Cb - 0.714136 * Cr;
      const b = Y + 1.772 * Cb;

      const outIdx = (rowOffset + x) * 4;
      out[outIdx] = Math.max(0, Math.min(255, Math.round(r)));
      out[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[outIdx + 3] = 255;
    }
  }

  return out;
}
