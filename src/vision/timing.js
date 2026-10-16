/**
 * Timing track refinement: Border residual extraction and 2D Coons-patch lens distortion compensation.
 */

import { projectH } from './homography.js';
import { getLayout } from '../frame/layout.js';

export class TimingRefiner {
  /**
   * Refines timing along 4 borders and builds 2D Coons-patch offset field.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame
   * @param {number} width - Camera width
   * @param {number} height - Camera height
   * @param {Float64Array} H - Homography matrix
   * @returns {TimingRefiner}
   */
  constructor(rgba, width, height, H) {
    this.H = H;
    this.width = width;
    this.height = height;

    // 80x80 arrays for du and dv
    this.duField = new Float32Array(6400);
    this.dvField = new Float32Array(6400);

    this._computeCoonsField(rgba);
  }

  _computeCoonsField(rgba) {
    const layout = getLayout();

    const topResiduals = new Float32Array(80);
    const botResiduals = new Float32Array(80);
    const leftResiduals = new Float32Array(80);
    const rightResiduals = new Float32Array(80);

    // Helper to sample luminance at pixel (x, y)
    const getLuma = (px, py) => {
      const x = Math.max(0, Math.min(this.width - 1, Math.round(px)));
      const y = Math.max(0, Math.min(this.height - 1, Math.round(py)));
      const idx = (y * this.width + x) * 4;
      return 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    };

    // Measure residuals along top and bottom edges (row 0, row 79)
    for (let c = 8; c <= 71; c++) {
      const pTop = projectH(this.H, c + 0.5, 0.5);
      const lumaCenter = getLuma(pTop.x, pTop.y);
      const lumaLeft = getLuma(pTop.x - 1.5, pTop.y);
      const lumaRight = getLuma(pTop.x + 1.5, pTop.y);
      const gradX = (lumaRight - lumaLeft) * 0.5;
      topResiduals[c] = Math.max(-0.4, Math.min(0.4, gradX * 0.005));

      const pBot = projectH(this.H, c + 0.5, 79.5);
      const lumaBotL = getLuma(pBot.x - 1.5, pBot.y);
      const lumaBotR = getLuma(pBot.x + 1.5, pBot.y);
      botResiduals[c] = Math.max(-0.4, Math.min(0.4, (lumaBotR - lumaBotL) * 0.0025));
    }

    // Measure residuals along left and right edges (col 0, col 79)
    for (let r = 8; r <= 71; r++) {
      const pLeft = projectH(this.H, 0.5, r + 0.5);
      const lumaUp = getLuma(pLeft.x, pLeft.y - 1.5);
      const lumaDown = getLuma(pLeft.x, pLeft.y + 1.5);
      leftResiduals[r] = Math.max(-0.4, Math.min(0.4, (lumaDown - lumaUp) * 0.0025));

      const pRight = projectH(this.H, 79.5, r + 0.5);
      const lumaRightU = getLuma(pRight.x, pRight.y - 1.5);
      const lumaRightD = getLuma(pRight.x, pRight.y + 1.5);
      rightResiduals[r] = Math.max(-0.4, Math.min(0.4, (lumaRightD - lumaRightU) * 0.0025));
    }

    // 2D Coons-patch blending across 80x80 grid
    for (let v = 0; v < 80; v++) {
      const tv = v / 79.0;
      const oneMinusTv = 1.0 - tv;

      for (let u = 0; u < 80; u++) {
        const su = u / 79.0;
        const oneMinusSu = 1.0 - su;

        // Linear blend of opposite boundary curves
        const du = oneMinusTv * topResiduals[u] + tv * botResiduals[u];
        const dv = oneMinusSu * leftResiduals[v] + su * rightResiduals[v];

        const idx = v * 80 + u;
        this.duField[idx] = du;
        this.dvField[idx] = dv;
      }
    }
  }

  /**
   * Returns refined offset (du, dv) in logical cell space for cell (u, v).
   *
   * @param {number} u - 0..79
   * @param {number} v - 0..79
   * @returns {{ du: number, dv: number }}
   */
  getOffset(u, v) {
    const idx = v * 80 + u;
    return {
      du: this.duField[idx],
      dv: this.dvField[idx]
    };
  }
}
