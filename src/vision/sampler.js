/**
 * Zero-warp coordinate sampler with 5-point spatial lattice deblur
 * and causal 3-channel decision-feedback slicing.
 */

import { projectH } from './homography.js';

/**
 * Shared causal 3-channel decision-feedback slicer.
 * Conditions each channel's threshold on decisions of the other channels.
 *
 * @param {number} rVal - Deblurred Red channel intensity
 * @param {number} gVal - Deblurred Green channel intensity
 * @param {number} bVal - Deblurred Blue channel intensity
 * @param {number} Tr - Local Red threshold
 * @param {number} Tg - Local Green threshold
 * @param {number} Tb - Local Blue threshold
 * @returns {{ sym: number, margin: number }}
 */
export function sliceCellCausal(rVal, gVal, bVal, Tr, Tg, Tb, scaleR = 1.0, scaleG = 1.0, scaleB = 1.0) {
  // Stage 1: Initial estimates
  const bG0 = gVal >= Tg ? 1 : 0;
  const bR0 = rVal >= (Tr + (bG0 ? 14 : -10) * scaleR) ? 1 : 0;
  const bB0 = bVal >= (Tb + ((bR0 ? 12 : -8) + (bG0 ? 12 : -8)) * scaleB) ? 1 : 0;

  // Stage 2: 2-neighbor crosstalk-compensated decisions
  const tgEff = Tg + ((bR0 ? 6 : -10) + (bB0 ? 14 : -8)) * scaleG;
  const bG = gVal >= tgEff ? 1 : 0;

  const trEff = Tr + ((bG ? 14 : -10) + (bB0 ? 2 : -2)) * scaleR;
  const bR = rVal >= trEff ? 1 : 0;

  const tbEff = Tb + ((bR ? 13 : -10) + (bG ? 13 : -10)) * scaleB;
  const bB = bVal >= tbEff ? 1 : 0;

  const mR = Math.abs(rVal - trEff);
  const mG = Math.abs(gVal - tgEff);
  const mB = Math.abs(bVal - tbEff);

  return {
    sym: (bR << 2) | (bG << 1) | bB,
    margin: Math.min(mR, mG, mB)
  };
}

/**
 * 8-Color Centroid / Nearest Neighbor Slicer.
 *
 * @param {number} rVal
 * @param {number} gVal
 * @param {number} bVal
 * @param {Float32Array|number[]} centroids - 8x3 RGB centroids
 * @returns {{ sym: number, margin: number }}
 */
export function sliceCellCentroid(rVal, gVal, bVal, centroids) {
  let bestSym = 0;
  let bestDist = Infinity;
  let secondDist = Infinity;

  for (let k = 0; k < 8; k++) {
    const k3 = k * 3;
    const dr = rVal - centroids[k3];
    const dg = gVal - centroids[k3 + 1];
    const db = bVal - centroids[k3 + 2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      secondDist = bestDist;
      bestDist = dist;
      bestSym = k;
    } else if (dist < secondDist) {
      secondDist = dist;
    }
  }

  const margin = Math.max(0, Math.sqrt(secondDist) - Math.sqrt(bestDist));
  return { sym: bestSym, margin };
}

/**
 * 4-PAM 6-Bit Gray-coded Constellation Slicer ([4x4x4] = 6 bits/cell).
 *
 * @param {number} rVal
 * @param {number} gVal
 * @param {number} bVal
 * @param {Float32Array|number[]} thresh4Pam - 9 thresholds [Tr01, Tr12, Tr23, Tg01, Tg12, Tg23, Tb01, Tb12, Tb23]
 * @returns {{ sym: number, margin: number }}
 */
export function sliceCell4Pam(rVal, gVal, bVal, thresh4Pam) {
  // R channel: 2 Gray-coded bits
  let bR = 0, mR = 0;
  if (rVal < thresh4Pam[0]) {
    bR = 0;
    mR = thresh4Pam[0] - rVal;
  } else if (rVal < thresh4Pam[1]) {
    bR = 1;
    mR = Math.min(rVal - thresh4Pam[0], thresh4Pam[1] - rVal);
  } else if (rVal < thresh4Pam[2]) {
    bR = 3;
    mR = Math.min(rVal - thresh4Pam[1], thresh4Pam[2] - rVal);
  } else {
    bR = 2;
    mR = rVal - thresh4Pam[2];
  }

  // G channel: 2 Gray-coded bits
  let bG = 0, mG = 0;
  if (gVal < thresh4Pam[3]) {
    bG = 0;
    mG = thresh4Pam[3] - gVal;
  } else if (gVal < thresh4Pam[4]) {
    bG = 1;
    mG = Math.min(gVal - thresh4Pam[3], thresh4Pam[4] - gVal);
  } else if (gVal < thresh4Pam[5]) {
    bG = 3;
    mG = Math.min(gVal - thresh4Pam[4], thresh4Pam[5] - gVal);
  } else {
    bG = 2;
    mG = gVal - thresh4Pam[5];
  }

  // B channel: 2 Gray-coded bits
  let bB = 0, mB = 0;
  if (bVal < thresh4Pam[6]) {
    bB = 0;
    mB = thresh4Pam[6] - bVal;
  } else if (bVal < thresh4Pam[7]) {
    bB = 1;
    mB = Math.min(bVal - thresh4Pam[6], thresh4Pam[7] - bVal);
  } else if (bVal < thresh4Pam[8]) {
    bB = 3;
    mB = Math.min(bVal - thresh4Pam[7], thresh4Pam[8] - bVal);
  } else {
    bB = 2;
    mB = bVal - thresh4Pam[8];
  }

  return {
    sym: (bR << 4) | (bG << 2) | bB,
    margin: Math.min(mR, mG, mB)
  };
}

/**
 * 4-PAM 5-Bit Constellation Slicer ([4x4x2] = 5 bits/cell).
 */
export function sliceCell5Pam(rVal, gVal, bVal, thresh4Pam, Tb = 128) {
  let bR = 0, mR = 0;
  if (rVal < thresh4Pam[0]) {
    bR = 0;
    mR = thresh4Pam[0] - rVal;
  } else if (rVal < thresh4Pam[1]) {
    bR = 1;
    mR = Math.min(rVal - thresh4Pam[0], thresh4Pam[1] - rVal);
  } else if (rVal < thresh4Pam[2]) {
    bR = 3;
    mR = Math.min(rVal - thresh4Pam[1], thresh4Pam[2] - rVal);
  } else {
    bR = 2;
    mR = rVal - thresh4Pam[2];
  }

  let bG = 0, mG = 0;
  if (gVal < thresh4Pam[3]) {
    bG = 0;
    mG = thresh4Pam[3] - gVal;
  } else if (gVal < thresh4Pam[4]) {
    bG = 1;
    mG = Math.min(gVal - thresh4Pam[3], thresh4Pam[4] - gVal);
  } else if (gVal < thresh4Pam[5]) {
    bG = 3;
    mG = Math.min(gVal - thresh4Pam[4], thresh4Pam[5] - gVal);
  } else {
    bG = 2;
    mG = gVal - thresh4Pam[5];
  }

  const bB = bVal >= Tb ? 1 : 0;
  const mB = Math.abs(bVal - Tb);

  return {
    sym: (bR << 3) | (bG << 1) | bB,
    margin: Math.min(mR, mG, mB)
  };
}

/**
 * Samples all cells across the grid.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame buffer
 * @param {number} width - Camera width
 * @param {number} height - Camera height
 * @param {Float64Array} H - Homography matrix
 * @param {TimingRefiner} timingRefiner - Timing offset provider
 * @param {Float32Array} [outGridRgb] - Preallocated buffer
 * @param {Uint8Array} [outInBounds]
 * @param {number} [gridSize=80] - Grid dimension
 * @returns {{ ok: boolean, gridRgb: Float32Array }}
 */
export function sampleFullGrid(rgba, width, height, H, timingRefiner, outGridRgb, outInBounds = null, gridSize = 80) {
  const G = gridSize || 80;
  const gridRgb = outGridRgb || new Float32Array(G * G * 3);
  let allInBounds = true;

  for (let r = 0; r < G; r++) {
    for (let c = 0; c < G; c++) {
      let du = 0, dv = 0;
      if (timingRefiner) {
        const off = timingRefiner.getOffset(c, r);
        du = off.du;
        dv = off.dv;
      }
      const uRef = c + 0.5 + du;
      const vRef = r + 0.5 + dv;

      const { x, y } = projectH(H, uRef, vRef);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const cellIdx = r * G + c;
      const idx3 = cellIdx * 3;

      if (x0 < 0 || x0 >= width - 1 || y0 < 0 || y0 >= height - 1) {
        gridRgb[idx3] = 128;
        gridRgb[idx3 + 1] = 128;
        gridRgb[idx3 + 2] = 128;
        if (outInBounds) outInBounds[cellIdx] = 0;
        allInBounds = false;
        continue;
      }

      if (outInBounds) outInBounds[cellIdx] = 1;

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

      const rC = w00 * rgba[o00] + w10 * rgba[o10] + w01 * rgba[o01] + w11 * rgba[o11];
      const gC = w00 * rgba[o00 + 1] + w10 * rgba[o10 + 1] + w01 * rgba[o01 + 1] + w11 * rgba[o11 + 1];
      const bC = w00 * rgba[o00 + 2] + w10 * rgba[o10 + 2] + w01 * rgba[o01 + 2] + w11 * rgba[o11 + 2];

      // 5-point inner-core sampling: center (0.40) + 4 symmetric satellites (0.15 each)
      const invD = 1.0 / (H[6] * uRef + H[7] * vRef + 1.0);
      const dxU = (H[0] - H[6] * x) * 0.14 * invD;
      const dyU = (H[3] - H[6] * y) * 0.14 * invD;
      const dxV = (H[1] - H[7] * x) * 0.14 * invD;
      const dyV = (H[4] - H[7] * y) * 0.14 * invD;

      let rSum = rC * 0.40;
      let gSum = gC * 0.40;
      let bSum = bC * 0.40;

      // Point 1: u + 0.14
      let sx = x + dxU, sy = y + dyU;
      let sx0 = Math.floor(sx), sy0 = Math.floor(sy);
      if (sx0 >= 0 && sx0 < width - 1 && sy0 >= 0 && sy0 < height - 1) {
        const sfx = sx - sx0, sfy = sy - sy0;
        const so00 = (sy0 * width + sx0) * 4;
        const so10 = so00 + 4, so01 = ((sy0 + 1) * width + sx0) * 4, so11 = so01 + 4;
        const sw00 = (1.0 - sfx) * (1.0 - sfy), sw10 = sfx * (1.0 - sfy), sw01 = (1.0 - sfx) * sfy, sw11 = sfx * sfy;
        rSum += 0.15 * (sw00 * rgba[so00] + sw10 * rgba[so10] + sw01 * rgba[so01] + sw11 * rgba[so11]);
        gSum += 0.15 * (sw00 * rgba[so00 + 1] + sw10 * rgba[so10 + 1] + sw01 * rgba[so01 + 1] + sw11 * rgba[so11 + 1]);
        bSum += 0.15 * (sw00 * rgba[so00 + 2] + sw10 * rgba[so10 + 2] + sw01 * rgba[so01 + 2] + sw11 * rgba[so11 + 2]);
      } else {
        rSum += 0.15 * rC; gSum += 0.15 * gC; bSum += 0.15 * bC;
      }

      // Point 2: u - 0.14
      sx = x - dxU; sy = y - dyU;
      sx0 = Math.floor(sx); sy0 = Math.floor(sy);
      if (sx0 >= 0 && sx0 < width - 1 && sy0 >= 0 && sy0 < height - 1) {
        const sfx = sx - sx0, sfy = sy - sy0;
        const so00 = (sy0 * width + sx0) * 4;
        const so10 = so00 + 4, so01 = ((sy0 + 1) * width + sx0) * 4, so11 = so01 + 4;
        const sw00 = (1.0 - sfx) * (1.0 - sfy), sw10 = sfx * (1.0 - sfy), sw01 = (1.0 - sfx) * sfy, sw11 = sfx * sfy;
        rSum += 0.15 * (sw00 * rgba[so00] + sw10 * rgba[so10] + sw01 * rgba[so01] + sw11 * rgba[so11]);
        gSum += 0.15 * (sw00 * rgba[so00 + 1] + sw10 * rgba[so10 + 1] + sw01 * rgba[so01 + 1] + sw11 * rgba[so11 + 1]);
        bSum += 0.15 * (sw00 * rgba[so00 + 2] + sw10 * rgba[so10 + 2] + sw01 * rgba[so01 + 2] + sw11 * rgba[so11 + 2]);
      } else {
        rSum += 0.15 * rC; gSum += 0.15 * gC; bSum += 0.15 * bC;
      }

      // Point 3: v + 0.14
      sx = x + dxV; sy = y + dyV;
      sx0 = Math.floor(sx); sy0 = Math.floor(sy);
      if (sx0 >= 0 && sx0 < width - 1 && sy0 >= 0 && sy0 < height - 1) {
        const sfx = sx - sx0, sfy = sy - sy0;
        const so00 = (sy0 * width + sx0) * 4;
        const so10 = so00 + 4, so01 = ((sy0 + 1) * width + sx0) * 4, so11 = so01 + 4;
        const sw00 = (1.0 - sfx) * (1.0 - sfy), sw10 = sfx * (1.0 - sfy), sw01 = (1.0 - sfx) * sfy, sw11 = sfx * sfy;
        rSum += 0.15 * (sw00 * rgba[so00] + sw10 * rgba[so10] + sw01 * rgba[so01] + sw11 * rgba[so11]);
        gSum += 0.15 * (sw00 * rgba[so00 + 1] + sw10 * rgba[so10 + 1] + sw01 * rgba[so01 + 1] + sw11 * rgba[so11 + 1]);
        bSum += 0.15 * (sw00 * rgba[so00 + 2] + sw10 * rgba[so10 + 2] + sw01 * rgba[so01 + 2] + sw11 * rgba[so11 + 2]);
      } else {
        rSum += 0.15 * rC; gSum += 0.15 * gC; bSum += 0.15 * bC;
      }

      // Point 4: v - 0.14
      sx = x - dxV; sy = y - dyV;
      sx0 = Math.floor(sx); sy0 = Math.floor(sy);
      if (sx0 >= 0 && sx0 < width - 1 && sy0 >= 0 && sy0 < height - 1) {
        const sfx = sx - sx0, sfy = sy - sy0;
        const so00 = (sy0 * width + sx0) * 4;
        const so10 = so00 + 4, so01 = ((sy0 + 1) * width + sx0) * 4, so11 = so01 + 4;
        const sw00 = (1.0 - sfx) * (1.0 - sfy), sw10 = sfx * (1.0 - sfy), sw01 = (1.0 - sfx) * sfy, sw11 = sfx * sfy;
        rSum += 0.15 * (sw00 * rgba[so00] + sw10 * rgba[so10] + sw01 * rgba[so01] + sw11 * rgba[so11]);
        gSum += 0.15 * (sw00 * rgba[so00 + 1] + sw10 * rgba[so10 + 1] + sw01 * rgba[so01 + 1] + sw11 * rgba[so11 + 1]);
        bSum += 0.15 * (sw00 * rgba[so00 + 2] + sw10 * rgba[so10 + 2] + sw01 * rgba[so01 + 2] + sw11 * rgba[so11 + 2]);
      } else {
        rSum += 0.15 * rC; gSum += 0.15 * gC; bSum += 0.15 * bC;
      }

      gridRgb[idx3] = rSum;
      gridRgb[idx3 + 1] = gSum;
      gridRgb[idx3 + 2] = bSum;
    }
  }

  return { ok: allInBounds, gridRgb };
}

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
 * @param {Float32Array} [outRgb] - Optional buffer for deblurred RGB values
 * @param {Float32Array} [outThresh] - Optional buffer for local thresholds
 * @param {Float32Array} [precomputedGrid] - Optional pre-sampled 80x80x3 grid
 * @param {Uint8Array} [inBounds] - Optional 80x80 bounds validity mask
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
  outThresh,
  precomputedGrid = null,
  inBounds = null,
  options = {}
) {
  const G = options.gridSize || pilotCalibrator?.gridSize || 80;
  const bitsPerCell = options.bitsPerCell || 3;
  const count = stripeDataCells.length;
  const symbols = outSymbols || new Uint8Array(count);
  const margins = outMargins || new Float32Array(count);

  let gridRgb = precomputedGrid;
  if (!gridRgb) {
    const gridRes = sampleFullGrid(rgba, width, height, H, timingRefiner, null, null, G);
    if (!gridRes.ok) {
      // Check if stripe cells specifically are out of bounds
      for (let i = 0; i < count; i++) {
        const { r, c } = stripeDataCells[i];
        const off = timingRefiner ? timingRefiner.getOffset(c, r) : { du: 0, dv: 0 };
        const pt = projectH(H, c + 0.5 + off.du, r + 0.5 + off.dv);
        const x0 = Math.floor(pt.x);
        const y0 = Math.floor(pt.y);
        if (x0 < 0 || x0 >= width - 1 || y0 < 0 || y0 >= height - 1) {
          return { ok: false, symbols, margins };
        }
      }
    }
    gridRgb = gridRes.gridRgb;
  } else if (inBounds) {
    for (let i = 0; i < count; i++) {
      const { r, c } = stripeDataCells[i];
      if (inBounds[r * G + c] === 0) {
        return { ok: false, symbols, margins };
      }
    }
  }

  const beta = 0.045;
  const rowStride = G * 3;

  for (let i = 0; i < count; i++) {
    const { r, c } = stripeDataCells[i];
    const cIdx = (r * G + c) * 3;

    let rVal = gridRgb[cIdx];
    let gVal = gridRgb[cIdx + 1];
    let bVal = gridRgb[cIdx + 2];

    let nR = 0, nG = 0, nB = 0, cnt = 0;
    if (r > 0)     { const k = cIdx - rowStride; nR += gridRgb[k]; nG += gridRgb[k + 1]; nB += gridRgb[k + 2]; cnt++; }
    if (r < G - 1) { const k = cIdx + rowStride; nR += gridRgb[k]; nG += gridRgb[k + 1]; nB += gridRgb[k + 2]; cnt++; }
    if (c > 0)     { const k = cIdx - 3;         nR += gridRgb[k]; nG += gridRgb[k + 1]; nB += gridRgb[k + 2]; cnt++; }
    if (c < G - 1) { const k = cIdx + 3;         nR += gridRgb[k]; nG += gridRgb[k + 1]; nB += gridRgb[k + 2]; cnt++; }

    rVal -= beta * (nR - cnt * rVal);
    gVal -= beta * (nG - cnt * gVal);
    bVal -= beta * (nB - cnt * bVal);

    let res;
    if (bitsPerCell === 6 && pilotCalibrator?.getThresholds4Pam) {
      const t4 = pilotCalibrator.getThresholds4Pam(c, r);
      res = sliceCell4Pam(rVal, gVal, bVal, t4);
      if (outThresh) {
        const idx3 = i * 3;
        outThresh[idx3] = t4[1];
        outThresh[idx3 + 1] = t4[4];
        outThresh[idx3 + 2] = t4[7];
      }
    } else if (bitsPerCell === 5 && pilotCalibrator?.getThresholds4Pam) {
      const t4 = pilotCalibrator.getThresholds4Pam(c, r);
      const { Tb } = pilotCalibrator.getThresholds(c, r);
      res = sliceCell5Pam(rVal, gVal, bVal, t4, Tb);
      if (outThresh) {
        const idx3 = i * 3;
        outThresh[idx3] = t4[1];
        outThresh[idx3 + 1] = t4[4];
        outThresh[idx3 + 2] = Tb;
      }
    } else {
      // Local pilot thresholds and scales
      const { Tr, Tg, Tb } = pilotCalibrator.getThresholds(c, r);
      const { scaleR, scaleG, scaleB } = pilotCalibrator.getScales
        ? pilotCalibrator.getScales(c, r)
        : { scaleR: 1.0, scaleG: 1.0, scaleB: 1.0 };

      if (outThresh) {
        const idx3 = i * 3;
        outThresh[idx3] = Tr;
        outThresh[idx3 + 1] = Tg;
        outThresh[idx3 + 2] = Tb;
      }

      res = sliceCellCausal(rVal, gVal, bVal, Tr, Tg, Tb, scaleR, scaleG, scaleB);
    }

    if (outRgb) {
      const idx3 = i * 3;
      outRgb[idx3] = rVal;
      outRgb[idx3 + 1] = gVal;
      outRgb[idx3 + 2] = bVal;
    }

    symbols[i] = res.sym;
    margins[i] = res.margin;
  }

  return { ok: true, symbols, margins };
}

