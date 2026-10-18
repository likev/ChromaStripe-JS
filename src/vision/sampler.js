/**
 * Zero-warp coordinate sampler: Samples 2x2 px core block per cell via inverse homography,
 * applies timing refinement, and branchlessly slices into 3-bit symbols using local pilot thresholds.
 */

import { projectH } from './homography.js';

/**
 * Samples all data cells for a given stripe.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame buffer
 * @param {number} width - Camera width
 * @param {number} height - Camera height
 * @param {Float64Array} H - Homography matrix
 * @param {TimingRefiner} timingRefiner - 2D timing offset provider
 * @param {PilotCalibrator} pilotCalibrator - Bilinear pilot threshold provider
 * @param {Array<{r: number, c: number}>} stripeDataCells - List of data cell coordinates
 * @param {Uint8Array} [outSymbols] - Optional preallocated buffer
 * @param {Float32Array} [outMargins] - Optional preallocated margins buffer
 * @returns {{ ok: boolean, symbols: Uint8Array, margins: Float32Array }}
 */
export function sampleStripeCells(
  rgba,
  width,
  height,
  H,
  timingRefiner,
  pilotCalibrator,
  stripeDataCells,
  outSymbols,
  outMargins,
  outRgb,
  outThresh
) {
  const count = stripeDataCells.length;
  const symbols = outSymbols || new Uint8Array(count);
  const margins = outMargins || new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const { r, c } = stripeDataCells[i];

    // Timing offset
    const { du, dv } = timingRefiner.getOffset(c, r);
    const uRef = c + 0.5 + du;
    const vRef = r + 0.5 + dv;

    // Project into camera coordinates
    const { x, y } = projectH(H, uRef, vRef);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);

    // Bounds check
    if (x0 < 0 || x0 >= width - 1 || y0 < 0 || y0 >= height - 1) {
      return { ok: false, symbols, margins };
    }

    const fx = x - x0;
    const fy = y - y0;
    const o00 = (y0 * width + x0) * 4;
    const o10 = o00 + 4;
    const o01 = ((y0 + 1) * width + x0) * 4;
    const o11 = o01 + 4;

    const w00 = (1.0 - fx) * (1.0 - fy);
    const w10 = fx * (1.0 - fy);
    const w01 = (1.0 - fx) * fy;
    const w11 = fx * fy;

    const rAvg = w00 * rgba[o00] + w10 * rgba[o10] + w01 * rgba[o01] + w11 * rgba[o11];
    const gAvg = w00 * rgba[o00 + 1] + w10 * rgba[o10 + 1] + w01 * rgba[o01 + 1] + w11 * rgba[o11 + 1];
    const bAvg = w00 * rgba[o00 + 2] + w10 * rgba[o10 + 2] + w01 * rgba[o01 + 2] + w11 * rgba[o11 + 2];

    // Local pilot thresholds
    const { Tr, Tg, Tb } = pilotCalibrator.getThresholds(c, r);

    if (outRgb) {
      const idx3 = i * 3;
      outRgb[idx3] = rAvg;
      outRgb[idx3 + 1] = gAvg;
      outRgb[idx3 + 2] = bAvg;
    }
    if (outThresh) {
      const idx3 = i * 3;
      outThresh[idx3] = Tr;
      outThresh[idx3 + 1] = Tg;
      outThresh[idx3 + 2] = Tb;
    }

    // Adaptive cross-channel crosstalk compensation:
    // Red channel has high separation; Magenta (R=1, B=1) leaks into Green (+36 counts),
    // and Yellow (R=1, G=1) leaks into Blue (+51 counts).
    const bR = rAvg >= Tr ? 1 : 0;
    const tgEff = Tg + (bR === 1 ? 10 : -5);
    const bG = gAvg >= tgEff ? 1 : 0;
    const tbEff = Tb + ((bR === 1 && bG === 1) ? 20 : -6);
    const bB = bAvg >= tbEff ? 1 : 0;

    symbols[i] = (bR << 2) | (bG << 1) | bB;
    margins[i] = Math.min(Math.abs(rAvg - Tr), Math.abs(gAvg - tgEff), Math.abs(bAvg - tbEff));
  }

  return { ok: true, symbols, margins };
}
