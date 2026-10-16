/**
 * Camera simulation: BT.601 YCbCr 4:2:0 chroma subsampling and optional 8x8 DCT quantization.
 */

// Standard JPEG Luminance Quantization Matrix
const JPEG_Q_LUMA = new Float32Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
]);

// 8x8 DCT-II orthonormal transform matrix
const DCT_MATRIX = new Float32Array(64);
const DCT_TRANSPOSE = new Float32Array(64);

for (let k = 0; k < 8; k++) {
  const alpha = (k === 0) ? Math.sqrt(1.0 / 8.0) : Math.sqrt(2.0 / 8.0);
  for (let n = 0; n < 8; n++) {
    const val = alpha * Math.cos((Math.PI * (2 * n + 1) * k) / 16.0);
    DCT_MATRIX[k * 8 + n] = val;
    DCT_TRANSPOSE[n * 8 + k] = val;
  }
}

/**
 * Applies 8x8 block DCT quantization (emulating video compression / JPEG).
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {number} [quality=70] - 1 to 100
 * @returns {Uint8ClampedArray}
 */
export function applyDCT(rgba, w, h, quality = 70) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;

  const qTable = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    qTable[i] = Math.max(1, Math.floor((JPEG_Q_LUMA[i] * scale + 50) / 100));
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);

  // Scratch buffers for 8x8 block
  const blockIn = new Float32Array(64);
  const blockTmp = new Float32Array(64);
  const blockDct = new Float32Array(64);
  const blockRec = new Float32Array(64);

  // Process 8x8 blocks across RGB channels (channel 0, 1, 2)
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const bw = Math.min(8, w - bx);
      const bh = Math.min(8, h - by);
      if (bw < 8 || bh < 8) continue; // Skip partial boundary blocks

      for (let ch = 0; ch < 3; ch++) {
        // Load block
        for (let y = 0; y < 8; y++) {
          const rowOffset = ((by + y) * w + bx) * 4;
          const bRow = y * 8;
          for (let x = 0; x < 8; x++) {
            blockIn[bRow + x] = rgba[rowOffset + x * 4 + ch] - 128;
          }
        }

        // 2D DCT: D = C * B * C^T
        // 1. Tmp = C * B
        for (let i = 0; i < 8; i++) {
          const cRow = i * 8;
          for (let j = 0; j < 8; j++) {
            let sum = 0;
            for (let k = 0; k < 8; k++) {
              sum += DCT_MATRIX[cRow + k] * blockIn[k * 8 + j];
            }
            blockTmp[i * 8 + j] = sum;
          }
        }

        // 2. Dct = Tmp * C^T
        for (let i = 0; i < 8; i++) {
          const tRow = i * 8;
          for (let j = 0; j < 8; j++) {
            let sum = 0;
            for (let k = 0; k < 8; k++) {
              sum += blockTmp[tRow + k] * DCT_TRANSPOSE[k * 8 + j];
            }
            // Quantize
            const qVal = qTable[i * 8 + j];
            blockDct[i * 8 + j] = Math.round(sum / qVal) * qVal;
          }
        }

        // 2D IDCT: B_rec = C^T * D * C
        // 1. Tmp = C^T * D
        for (let i = 0; i < 8; i++) {
          const ctRow = i * 8;
          for (let j = 0; j < 8; j++) {
            let sum = 0;
            for (let k = 0; k < 8; k++) {
              sum += DCT_TRANSPOSE[ctRow + k] * blockDct[k * 8 + j];
            }
            blockTmp[i * 8 + j] = sum;
          }
        }

        // 2. Rec = Tmp * C
        for (let i = 0; i < 8; i++) {
          const tRow = i * 8;
          const rowOffset = ((by + i) * w + bx) * 4;
          for (let j = 0; j < 8; j++) {
            let sum = 0;
            for (let k = 0; k < 8; k++) {
              sum += blockTmp[tRow + k] * DCT_MATRIX[k * 8 + j];
            }
            out[rowOffset + j * 4 + ch] = Math.max(0, Math.min(255, Math.round(sum + 128)));
          }
        }
      }
    }
  }

  return out;
}

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
