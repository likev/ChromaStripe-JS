/**
 * Pilot lattice calibration: 4x4 calibration pilot sampling, channel midpoint calculation,
 * and 2D bilinear threshold interpolation.
 */

import { projectH } from './homography.js';

export class PilotCalibrator {
  /**
   * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame
   * @param {number} width - Camera width
   * @param {number} height - Camera height
   * @param {Float64Array} H - Homography matrix
   * @param {TimingRefiner} [timingRefiner] - Optional timing offset provider
   */
  constructor(rgba, width, height, H, timingRefiner = null) {
    this.width = width;
    this.height = height;
    this.H = H;
    this.timingRefiner = timingRefiner;

    // 4x4 pilot lattice coordinates
    this.pilotCoords = [9.5, 29.5, 49.5, 69.5];

    // 16 entries of [Tr, Tg, Tb]
    this.thresholds = new Float32Array(16 * 3);
    this._samplePilots(rgba);
  }

  _samplePilots(rgba) {
    const sample3x3 = (u, v) => {
      let du = 0, dv = 0;
      if (this.timingRefiner) {
        const off = this.timingRefiner.getOffset(
          Math.max(0, Math.min(79, Math.round(u - 0.5))),
          Math.max(0, Math.min(79, Math.round(v - 0.5)))
        );
        du = off.du;
        dv = off.dv;
      }
      const { x, y } = projectH(this.H, u + du, v + dv);
      const ix = Math.round(x);
      const iy = Math.round(y);

      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = iy + dy;
        if (sy < 0 || sy >= this.height) continue;
        const rowOffset = sy * this.width;
        for (let dx = -1; dx <= 1; dx++) {
          const sx = ix + dx;
          if (sx < 0 || sx >= this.width) continue;
          const idx = (rowOffset + sx) * 4;
          rSum += rgba[idx];
          gSum += rgba[idx + 1];
          bSum += rgba[idx + 2];
          count++;
        }
      }
      return count > 0 ? [rSum / count, gSum / count, bSum / count] : [128, 128, 128];
    };

    const offsets = [9, 29, 49, 69];

    for (let rIdx = 0; rIdx < 4; rIdx++) {
      const rBase = offsets[rIdx];
      for (let cIdx = 0; cIdx < 4; cIdx++) {
        const cBase = offsets[cIdx];

        // 4 cells of pilot block:
        // [W (r, c)    | K (r, c+1)]
        // [C (r+1, c)  | M (r+1, c+1)]
        const [wR, wG, wB] = sample3x3(cBase + 0.5, rBase + 0.5);
        const [kR, kG, kB] = sample3x3(cBase + 1.5, rBase + 0.5);
        const [cR, cG, cB] = sample3x3(cBase + 0.5, rBase + 1.5);
        const [mR, mG, mB] = sample3x3(cBase + 1.5, rBase + 1.5);

        // High and low channel levels
        const rHi = (wR + mR) * 0.5;
        const rLo = (kR + cR) * 0.5;
        const gHi = (wG + cG) * 0.5;
        const gLo = (kG + mG) * 0.5;
        const bHi = (wB + cB + mB) / 3.0;
        const bLo = kB;

        // Thresholds
        const Tr = (rHi - rLo > 30) ? (rHi + rLo) * 0.5 : 128;
        const Tg = (gHi - gLo > 30) ? (gHi + gLo) * 0.5 : 128;
        const Tb = (bHi - bLo > 30) ? (bHi + bLo) * 0.5 : 128;

        const pIdx = (rIdx * 4 + cIdx) * 3;
        this.thresholds[pIdx] = Tr;
        this.thresholds[pIdx + 1] = Tg;
        this.thresholds[pIdx + 2] = Tb;
      }
    }
  }

  /**
   * Bilinearly interpolates [Tr, Tg, Tb] for cell coordinate (u, v).
   *
   * @param {number} u - 0..79
   * @param {number} v - 0..79
   * @returns {{ Tr: number, Tg: number, Tb: number }}
   */
  getThresholds(u, v) {
    const coords = this.pilotCoords;

    // Find bounding pilot indices in X
    let i = 0;
    while (i < 2 && u > coords[i + 1]) i++;

    // Find bounding pilot indices in Y
    let j = 0;
    while (j < 2 && v > coords[j + 1]) j++;

    const x0 = coords[i];
    const x1 = coords[i + 1];
    const y0 = coords[j];
    const y1 = coords[j + 1];

    const s = Math.max(0.0, Math.min(1.0, (u - x0) / (x1 - x0)));
    const t = Math.max(0.0, Math.min(1.0, (v - y0) / (y1 - y0)));

    const idx00 = (j * 4 + i) * 3;
    const idx10 = (j * 4 + (i + 1)) * 3;
    const idx01 = ((j + 1) * 4 + i) * 3;
    const idx11 = ((j + 1) * 4 + (i + 1)) * 3;

    const interp = (ch) => {
      const v00 = this.thresholds[idx00 + ch];
      const v10 = this.thresholds[idx10 + ch];
      const v01 = this.thresholds[idx01 + ch];
      const v11 = this.thresholds[idx11 + ch];

      const top = (1.0 - s) * v00 + s * v10;
      const bot = (1.0 - s) * v01 + s * v11;
      return (1.0 - t) * top + t * bot;
    };

    return {
      Tr: interp(0),
      Tg: interp(1),
      Tb: interp(2)
    };
  }
}
