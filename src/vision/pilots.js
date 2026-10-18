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

    // 4x4 pilot lattice coordinates (centers of 2x2 pilot blocks)
    this.pilotCoords = [10.0, 30.0, 50.0, 70.0];

    // 16 entries of [Tr, Tg, Tb]
    this.thresholds = new Float32Array(16 * 3);
    this._samplePilots(rgba);
  }

  _samplePilots(rgba) {
    const samplePilotCore = (u, v) => {
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
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);

      if (x0 < 0 || x0 >= this.width - 1 || y0 < 0 || y0 >= this.height - 1) {
        return [128, 128, 128];
      }

      const fx = x - x0;
      const fy = y - y0;
      const o00 = (y0 * this.width + x0) * 4;
      const o10 = o00 + 4;
      const o01 = ((y0 + 1) * this.width + x0) * 4;
      const o11 = o01 + 4;

      const w00 = (1.0 - fx) * (1.0 - fy);
      const w10 = fx * (1.0 - fy);
      const w01 = (1.0 - fx) * fy;
      const w11 = fx * fy;

      const r = w00 * rgba[o00] + w10 * rgba[o10] + w01 * rgba[o01] + w11 * rgba[o11];
      const g = w00 * rgba[o00 + 1] + w10 * rgba[o10 + 1] + w01 * rgba[o01 + 1] + w11 * rgba[o11 + 1];
      const b = w00 * rgba[o00 + 2] + w10 * rgba[o10 + 2] + w01 * rgba[o01 + 2] + w11 * rgba[o11 + 2];
      return [r, g, b];
    };

    const offsets = [9, 29, 49, 69];

    for (let rIdx = 0; rIdx < 4; rIdx++) {
      const rBase = offsets[rIdx];
      for (let cIdx = 0; cIdx < 4; cIdx++) {
        const cBase = offsets[cIdx];

        // 4 cells of pilot block:
        // [W (r, c)    | K (r, c+1)]
        // [C (r+1, c)  | M (r+1, c+1)]
        const [wR, wG, wB] = samplePilotCore(cBase + 0.5, rBase + 0.5);
        const [kR, kG, kB] = samplePilotCore(cBase + 1.5, rBase + 0.5);
        const [cR, cG, cB] = samplePilotCore(cBase + 0.5, rBase + 1.5);
        const [mR, mG, mB] = samplePilotCore(cBase + 1.5, rBase + 1.5);

        // High and low channel levels
        const rHi = (wR + mR) * 0.5;
        const rLo = (kR + cR) * 0.5;
        const gHi = (wG + cG) * 0.5;
        const gLeak = Math.max(0, 0.25 * (mG - kG));
        const gLo = (kG + mG) * 0.5 + gLeak;
        const bHi = (wB + cB + mB) / 3.0;
        const bLeak = Math.max(0, 0.25 * ((rLo - kR) + (gLo - kG)));
        const bLo = kB + bLeak;

        // Thresholds: midpoint between high and low levels
        const Tr = (rHi - rLo > 15) ? (rHi + rLo) * 0.5 : ((rHi + rLo) * 0.5 || 128);
        const Tg = (gHi - gLo > 15) ? (gHi + gLo) * 0.5 : ((gHi + gLo) * 0.5 || 128);
        const Tb = (bHi - bLo > 15) ? (bHi + bLo) * 0.5 : ((bHi + bLo) * 0.5 || 128);

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

    const s = Math.max(-0.4, Math.min(1.4, (u - x0) / (x1 - x0)));
    const t = Math.max(-0.4, Math.min(1.4, (v - y0) / (y1 - y0)));

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
      return Math.max(10, Math.min(245, (1.0 - t) * top + t * bot));
    };

    return {
      Tr: interp(0),
      Tg: interp(1),
      Tb: interp(2)
    };
  }
}
