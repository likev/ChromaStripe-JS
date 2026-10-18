/**
 * Timing track refinement: 8x8 Guard-Band First-Harmonic Fourier Phase Refiner
 * with fast radial lens distortion fallback.
 */

import { projectH, solveHomography } from './homography.js';
import { getLayout } from '../frame/layout.js';

const N_BINS = 8;
const COS_LUT = new Float64Array(N_BINS);
const SIN_LUT = new Float64Array(N_BINS);
for (let b = 0; b < N_BINS; b++) {
  const angle = (2 * Math.PI * (b + 0.5)) / N_BINS;
  COS_LUT[b] = Math.cos(angle);
  SIN_LUT[b] = Math.sin(angle);
}

export class TimingRefiner {
  /**
   * Refines timing offsets across the frame using radial lens compensation (if present)
   * and 8x8 guard-band Fourier phase analysis.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame
   * @param {number} width - Camera width
   * @param {number} height - Camera height
   * @param {Float64Array} H - Homography matrix
   * @param {Array<{x: number, y: number}>} [corners] - Optional corner points
   */
  constructor(rgba, width, height, H, corners = null) {
    this.H = H;
    this.width = width;
    this.height = height;

    this.corners = corners || [
      projectH(H, 3.5, 3.5),
      projectH(H, 76.5, 3.5),
      projectH(H, 3.5, 76.5),
      projectH(H, 76.5, 76.5)
    ];

    this.duGrid = new Float32Array(64);
    this.dvGrid = new Float32Array(64);
    this.duField = null;
    this.dvField = null;
    this.hasLensDistortion = false;

    this._analyze(rgba);
  }

  _analyze(rgba) {
    const { width: w, height: h, H, corners } = this;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const normScale = Math.min(cx, cy);
    const invScale = 1.0 / normScale;

    const getLuma = (px, py) => {
      const x = (px + 0.5) | 0;
      const y = (py + 0.5) | 0;
      if (x < 0 || x >= w || y < 0 || y >= h) return 0;
      const idx = (y * w + x) * 4;
      return 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    };

    const undist = (pt, k) => {
      const nx = (pt.x - cx) * invScale;
      const ny = (pt.y - cy) * invScale;
      const f = 1.0 / (1.0 + k * (nx * nx + ny * ny));
      return { x: cx + nx * f * normScale, y: cy + ny * f * normScale };
    };

    const evalContrast = (k) => {
      let H_u = H;
      if (Math.abs(k) > 1e-4) {
        H_u = solveHomography([
          undist(corners[0], k),
          undist(corners[1], k),
          undist(corners[2], k),
          undist(corners[3], k)
        ]);
        if (!H_u) return -Infinity;
      }

      let contrast = 0;
      // Top and bottom timing borders
      for (let c = 8; c <= 71; c++) {
        const s = ((c - 8) & 1) === 0 ? 1 : -1;
        const uT = c + 0.5, vT = 0.5;
        const dT = 1.0 / (H_u[6] * uT + H_u[7] * vT + 1.0);
        let pxT = (H_u[0] * uT + H_u[1] * vT + H_u[2]) * dT;
        let pyT = (H_u[3] * uT + H_u[4] * vT + H_u[5]) * dT;
        if (Math.abs(k) > 1e-4) {
          const nx = (pxT - cx) * invScale;
          const ny = (pyT - cy) * invScale;
          const f = 1.0 + k * (nx * nx + ny * ny);
          pxT = cx + nx * f * normScale;
          pyT = cy + ny * f * normScale;
        }

        const uB = c + 0.5, vB = 79.5;
        const dB = 1.0 / (H_u[6] * uB + H_u[7] * vB + 1.0);
        let pxB = (H_u[0] * uB + H_u[1] * vB + H_u[2]) * dB;
        let pyB = (H_u[3] * uB + H_u[4] * vB + H_u[5]) * dB;
        if (Math.abs(k) > 1e-4) {
          const nx = (pxB - cx) * invScale;
          const ny = (pyB - cy) * invScale;
          const f = 1.0 + k * (nx * nx + ny * ny);
          pxB = cx + nx * f * normScale;
          pyB = cy + ny * f * normScale;
        }

        contrast += s * getLuma(pxT, pyT) + s * getLuma(pxB, pyB);
      }

      // Left and right timing borders
      for (let r = 8; r <= 71; r++) {
        const s = ((r - 8) & 1) === 0 ? 1 : -1;
        const uL = 0.5, vL = r + 0.5;
        const dL = 1.0 / (H_u[6] * uL + H_u[7] * vL + 1.0);
        let pxL = (H_u[0] * uL + H_u[1] * vL + H_u[2]) * dL;
        let pyL = (H_u[3] * uL + H_u[4] * vL + H_u[5]) * dL;
        if (Math.abs(k) > 1e-4) {
          const nx = (pxL - cx) * invScale;
          const ny = (pyL - cy) * invScale;
          const f = 1.0 + k * (nx * nx + ny * ny);
          pxL = cx + nx * f * normScale;
          pyL = cy + ny * f * normScale;
        }

        const uR = 79.5, vR = r + 0.5;
        const dR = 1.0 / (H_u[6] * uR + H_u[7] * vR + 1.0);
        let pxR = (H_u[0] * uR + H_u[1] * vR + H_u[2]) * dR;
        let pyR = (H_u[3] * uR + H_u[4] * vR + H_u[5]) * dR;
        if (Math.abs(k) > 1e-4) {
          const nx = (pxR - cx) * invScale;
          const ny = (pyR - cy) * invScale;
          const f = 1.0 + k * (nx * nx + ny * ny);
          pxR = cx + nx * f * normScale;
          pyR = cy + ny * f * normScale;
        }

        contrast += s * getLuma(pxL, pyL) + s * getLuma(pxR, pyR);
      }

      return contrast;
    };

    // Baseline contrast at k = 0 (flat homography)
    const contrast0 = evalContrast(0);
    let bestK1 = 0;
    let maxContrast = contrast0;
    const minThreshold = contrast0 + Math.max(100, Math.abs(contrast0) * 0.025);

    for (let k = -0.12; k <= 0.02; k += 0.015) {
      if (Math.abs(k) < 1e-4) continue;
      const contrast = evalContrast(k);
      if (contrast > maxContrast && contrast > minThreshold) {
        maxContrast = contrast;
        bestK1 = k;
      }
    }

    if (Math.abs(bestK1) > 0.005) {
      this._computeLensField(bestK1, cx, cy, normScale, invScale);
    } else {
      this._computeGuardPhaseField(rgba, w, h, H);
    }
  }

  _computeLensField(bestK1, cx, cy, normScale, invScale) {
    const { H, corners } = this;
    const undist = (pt) => {
      const nx = (pt.x - cx) * invScale;
      const ny = (pt.y - cy) * invScale;
      const f = 1.0 / (1.0 + bestK1 * (nx * nx + ny * ny));
      return { x: cx + nx * f * normScale, y: cy + ny * f * normScale };
    };
    const dist = (pt) => {
      const nx = (pt.x - cx) * invScale;
      const ny = (pt.y - cy) * invScale;
      const f = 1.0 + bestK1 * (nx * nx + ny * ny);
      return { x: cx + nx * f * normScale, y: cy + ny * f * normScale };
    };

    const [h00, h01, h02, h10, h11, h12, h20, h21] = H;
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

    const H_undist = solveHomography([
      undist(corners[0]),
      undist(corners[1]),
      undist(corners[2]),
      undist(corners[3])
    ]);

    if (H_undist) {
      this.duField = new Float32Array(6400);
      this.dvField = new Float32Array(6400);
      this.hasLensDistortion = true;
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

  _computeGuardPhaseField(rgba, width, height, H) {
    const layout = getLayout();
    const uBins = new Float64Array(N_BINS);
    const vBins = new Float64Array(N_BINS);
    const { duGrid, dvGrid, width: w, height: h } = this;

    for (let qr = 0; qr < 8; qr++) {
      for (let qc = 0; qc < 8; qc++) {
        // Skip the 4 corner blocks containing 7x7 finder patterns
        if ((qr === 0 || qr === 7) && (qc === 0 || qc === 7)) continue;
        uBins.fill(0);
        vBins.fill(0);
        const rStart = qr * 10 + 1;
        const cStart = qc * 10 + 1;

        for (let r = rStart; r < rStart + 8; r += 2) {
          for (let col = cStart; col < cStart + 8; col += 2) {
            if (layout.cellClass[r * 80 + col] === 1) continue;
            for (let b = 0; b < N_BINS; b++) {
              const f = (b + 0.5) / N_BINS;
              const ptU = projectH(H, col + f, r + 0.5);
              const xU = (ptU.x + 0.5) | 0;
              const yU = (ptU.y + 0.5) | 0;
              if (xU >= 0 && xU < w && yU >= 0 && yU < h) {
                const idxU = (yU * w + xU) * 4;
                uBins[b] += rgba[idxU] + rgba[idxU + 1] + rgba[idxU + 2];
              }

              const ptV = projectH(H, col + 0.5, r + f);
              const xV = (ptV.x + 0.5) | 0;
              const yV = (ptV.y + 0.5) | 0;
              if (xV >= 0 && xV < w && yV >= 0 && yV < h) {
                const idxV = (yV * w + xV) * 4;
                vBins[b] += rgba[idxV] + rgba[idxV + 1] + rgba[idxV + 2];
              }
            }
          }
        }

        let reU = 0, imU = 0, reV = 0, imV = 0;
        let sumU = 0, sumV = 0;
        for (let b = 0; b < N_BINS; b++) {
          sumU += uBins[b];
          sumV += vBins[b];
          reU += uBins[b] * COS_LUT[b];
          imU += uBins[b] * SIN_LUT[b];
          reV += vBins[b] * COS_LUT[b];
          imV += vBins[b] * SIN_LUT[b];
        }

        const magU = Math.sqrt(reU * reU + imU * imU);
        const magV = Math.sqrt(reV * reV + imV * imV);

        let peakU = 0.5, peakV = 0.5;
        if (sumU > 0 && magU / sumU >= 0.015) {
          peakU = Math.atan2(imU, reU) / (2 * Math.PI);
          if (peakU < 0) peakU += 1.0;
        }
        if (sumV > 0 && magV / sumV >= 0.015) {
          peakV = Math.atan2(imV, reV) / (2 * Math.PI);
          if (peakV < 0) peakV += 1.0;
        }

        duGrid[qr * 8 + qc] = Math.max(-0.38, Math.min(0.38, peakU - 0.5));
        dvGrid[qr * 8 + qc] = Math.max(-0.38, Math.min(0.38, peakV - 0.5));
      }
    }

    // Fill the 4 corner blocks from their 2 adjacent edge blocks
    duGrid[0]  = 0.5 * (duGrid[1]  + duGrid[8]);
    dvGrid[0]  = 0.5 * (dvGrid[1]  + dvGrid[8]);
    duGrid[7]  = 0.5 * (duGrid[6]  + duGrid[15]);
    dvGrid[7]  = 0.5 * (duGrid[6]  + duGrid[15]);
    duGrid[56] = 0.5 * (duGrid[57] + duGrid[48]);
    dvGrid[56] = 0.5 * (duGrid[57] + duGrid[48]);
    duGrid[63] = 0.5 * (duGrid[62] + duGrid[55]);
    dvGrid[63] = 0.5 * (duGrid[62] + duGrid[55]);
  }

  /**
   * Returns refined offset (du, dv) in logical cell space for cell (u, v).
   *
   * @param {number} u - 0..79
   * @param {number} v - 0..79
   * @returns {{ du: number, dv: number }}
   */
  getOffset(u, v) {
    if (this.hasLensDistortion && this.duField) {
      const iu = Math.max(0, Math.min(79, Math.round(u)));
      const iv = Math.max(0, Math.min(79, Math.round(v)));
      const idx = iv * 80 + iu;
      return {
        du: this.duField[idx],
        dv: this.dvField[idx]
      };
    }

    const gx = (u - 5.0) * 0.1;
    const gy = (v - 5.0) * 0.1;
    const i = Math.max(0, Math.min(6, Math.floor(gx)));
    const j = Math.max(0, Math.min(6, Math.floor(gy)));
    const s = Math.max(-0.5, Math.min(1.5, gx - i));
    const t = Math.max(-0.5, Math.min(1.5, gy - j));
    const i00 = j * 8 + i, i10 = i00 + 1, i01 = i00 + 8, i11 = i00 + 9;
    return {
      du: (1 - t) * ((1 - s) * this.duGrid[i00] + s * this.duGrid[i10]) +
          t       * ((1 - s) * this.duGrid[i01] + s * this.duGrid[i11]),
      dv: (1 - t) * ((1 - s) * this.dvGrid[i00] + s * this.dvGrid[i10]) +
          t       * ((1 - s) * this.dvGrid[i01] + s * this.dvGrid[i11])
    };
  }
}
