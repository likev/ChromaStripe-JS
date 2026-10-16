/**
 * Timing track refinement: Border residual extraction and 2D lens distortion compensation.
 */

import { projectH, solveHomography } from './homography.js';
import { getLayout } from '../frame/layout.js';

export class TimingRefiner {
  /**
   * Refines timing along 4 borders and builds 2D offset field for lens distortion and timing jitter.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame
   * @param {number} width - Camera width
   * @param {number} height - Camera height
   * @param {Float64Array} H - Homography matrix
   * @param {Array<{x: number, y: number}>} [corners] - Optional corner points [TL, TR, BL, BR]
   * @returns {TimingRefiner}
   */
  constructor(rgba, width, height, H, corners = null) {
    this.H = H;
    this.width = width;
    this.height = height;

    // Corners in observed camera coordinates
    this.corners = corners || [
      projectH(H, 3.5, 3.5),   // TL
      projectH(H, 76.5, 3.5),  // TR
      projectH(H, 3.5, 76.5),  // BL
      projectH(H, 76.5, 76.5)  // BR
    ];

    // 80x80 arrays for du and dv
    this.duField = new Float32Array(6400);
    this.dvField = new Float32Array(6400);

    this._computeOffsetField(rgba);
  }

  _computeOffsetField(rgba) {
    const cx = this.width * 0.5;
    const cy = this.height * 0.5;

    const getLuma = (px, py) => {
      const x = Math.max(0, Math.min(this.width - 1, Math.round(px)));
      const y = Math.max(0, Math.min(this.height - 1, Math.round(py)));
      const idx = (y * this.width + x) * 4;
      return 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    };

    // 1. Search for radial lens distortion coefficient k1 that maximizes timing track contrast
    let bestK1 = 0;
    let maxContrast = -Infinity;

    for (let k = -0.12; k <= 0.02; k += 0.015) {
      const undist = (pt) => {
        const nx = (pt.x - cx) / cx;
        const ny = (pt.y - cy) / cy;
        const f = 1.0 / (1.0 + k * (nx * nx + ny * ny));
        return { x: cx + nx * f * cx, y: cy + ny * f * cy };
      };
      const dist = (pt) => {
        const nx = (pt.x - cx) / cx;
        const ny = (pt.y - cy) / cy;
        const f = 1.0 + k * (nx * nx + ny * ny);
        return { x: cx + nx * f * cx, y: cy + ny * f * cy };
      };

      const H_u = solveHomography([
        undist(this.corners[0]),
        undist(this.corners[1]),
        undist(this.corners[2]),
        undist(this.corners[3])
      ]);
      if (!H_u) continue;

      let contrast = 0;
      // Top and bottom timing edges (step 2 for speed)
      for (let c = 8; c <= 71; c += 2) {
        const s = ((c - 8) & 1) === 0 ? 1 : -1;
        const pT = dist(projectH(H_u, c + 0.5, 0.5));
        const pB = dist(projectH(H_u, c + 0.5, 79.5));
        contrast += s * getLuma(pT.x, pT.y) + s * getLuma(pB.x, pB.y);
      }
      // Left and right timing edges
      for (let r = 8; r <= 71; r += 2) {
        const s = ((r - 8) & 1) === 0 ? 1 : -1;
        const pL = dist(projectH(H_u, 0.5, r + 0.5));
        const pR = dist(projectH(H_u, 79.5, r + 0.5));
        contrast += s * getLuma(pL.x, pL.y) + s * getLuma(pR.x, pR.y);
      }

      if (contrast > maxContrast) {
        maxContrast = contrast;
        bestK1 = k;
      }
    }

    // 2. Invert current homography H
    const [h00, h01, h02, h10, h11, h12, h20, h21] = this.H;
    const h22 = 1.0;
    const det =
      h00 * (h11 * h22 - h12 * h21) -
      h01 * (h10 * h22 - h12 * h20) +
      h02 * (h10 * h21 - h11 * h20);

    if (Math.abs(det) < 1e-12) return;

    const invDet = 1.0 / det;
    const H_inv = [
      (h11 * h22 - h12 * h21) * invDet,
      (h02 * h21 - h01 * h22) * invDet,
      (h01 * h12 - h02 * h11) * invDet,

      (h12 * h20 - h10 * h22) * invDet,
      (h00 * h22 - h02 * h20) * invDet,
      (h02 * h10 - h00 * h12) * invDet,

      (h10 * h21 - h11 * h20) * invDet,
      (h01 * h20 - h00 * h21) * invDet,
      (h00 * h11 - h01 * h10) * invDet
    ];

    const unproject = (px, py) => {
      const d = 1.0 / (H_inv[6] * px + H_inv[7] * py + H_inv[8]);
      return {
        u: (H_inv[0] * px + H_inv[1] * py + H_inv[2]) * d,
        v: (H_inv[3] * px + H_inv[4] * py + H_inv[5]) * d
      };
    };

    // 3. Compute undistorted homography and populate offset field
    if (Math.abs(bestK1) > 0.005) {
      const undist = (pt) => {
        const nx = (pt.x - cx) / cx;
        const ny = (pt.y - cy) / cy;
        const f = 1.0 / (1.0 + bestK1 * (nx * nx + ny * ny));
        return { x: cx + nx * f * cx, y: cy + ny * f * cy };
      };
      const dist = (pt) => {
        const nx = (pt.x - cx) / cx;
        const ny = (pt.y - cy) / cy;
        const f = 1.0 + bestK1 * (nx * nx + ny * ny);
        return { x: cx + nx * f * cx, y: cy + ny * f * cy };
      };

      const H_undist = solveHomography([
        undist(this.corners[0]),
        undist(this.corners[1]),
        undist(this.corners[2]),
        undist(this.corners[3])
      ]);

      if (H_undist) {
        for (let r = 0; r < 80; r++) {
          const vNom = r + 0.5;
          const rowOffset = r * 80;
          for (let c = 0; c < 80; c++) {
            const uNom = c + 0.5;
            const pLinear = projectH(H_undist, uNom, vNom);
            const pDist = dist(pLinear);
            const { u, v } = unproject(pDist.x, pDist.y);
            const idx = rowOffset + c;
            this.duField[idx] = Math.max(-2.0, Math.min(2.0, u - uNom));
            this.dvField[idx] = Math.max(-2.0, Math.min(2.0, v - vNom));
          }
        }
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
