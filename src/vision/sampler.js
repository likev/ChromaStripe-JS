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
 * @returns {{ ok: boolean, symbols: Uint8Array }}
 */
export function sampleStripeCells(
  rgba,
  width,
  height,
  H,
  timingRefiner,
  pilotCalibrator,
  stripeDataCells,
  outSymbols
) {
  const count = stripeDataCells.length;
  const symbols = outSymbols || new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const { r, c } = stripeDataCells[i];

    // Timing offset
    const { du, dv } = timingRefiner.getOffset(c, r);
    const uRef = c + 0.5 + du;
    const vRef = r + 0.5 + dv;

    // Project into camera coordinates
    const { x, y } = projectH(H, uRef, vRef);
    const ix = Math.floor(x);
    const iy = Math.floor(y);

    // Bounds check
    if (ix < 0 || ix >= width - 1 || iy < 0 || iy >= height - 1) {
      return { ok: false, symbols };
    }

    // 2x2 pixel block average (samples exact cell core)
    const o00 = (iy * width + ix) * 4;
    const o10 = o00 + 4;
    const o01 = ((iy + 1) * width + ix) * 4;
    const o11 = o01 + 4;

    const rAvg = (rgba[o00] + rgba[o10] + rgba[o01] + rgba[o11]) * 0.25;
    const gAvg = (rgba[o00 + 1] + rgba[o10 + 1] + rgba[o01 + 1] + rgba[o11 + 1]) * 0.25;
    const bAvg = (rgba[o00 + 2] + rgba[o10 + 2] + rgba[o01 + 2] + rgba[o11 + 2]) * 0.25;

    // Local pilot thresholds
    const { Tr, Tg, Tb } = pilotCalibrator.getThresholds(c, r);

    // Branchless 3-bit slicing
    symbols[i] = ((rAvg >= Tr ? 1 : 0) << 2) |
                 ((gAvg >= Tg ? 1 : 0) << 1) |
                 (bAvg >= Tb ? 1 : 0);
  }

  return { ok: true, symbols };
}
