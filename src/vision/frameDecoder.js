/**
 * Frame decoder: Full RX vision pipeline per camera frame.
 * Finders -> Homography -> Timing Refinement -> Pilots -> Sampler -> Bitpack -> RS -> CRC.
 */

import { findCorners } from './finder.js';
import { solveHomography, projectH } from './homography.js';
import { TimingRefiner } from './timing.js';
import { PilotCalibrator } from './pilots.js';
import { sampleStripeCells, sampleFullGrid, sliceCellCausal, sliceCellCentroid, sliceCell4Pam, sliceCell5Pam } from './sampler.js';
import { getLayout, getLayoutV2 } from '../frame/layout.js';
import {
  symbolsToBytes,
  symbolsMarginsToByteMargins,
  symbolsToBytesMultiBit,
  symbolsMarginsToByteMarginsMultiBit,
  bytesToSymbols
} from '../core/bitpack.js';
import { parsePacket, parsePacketV2, buildPacket } from '../frame/packet.js';
import {
  PACKET_TOTAL_BYTES,
  V2_PACKET_BYTES_HIGH_RATE,
  V2_PACKET_BYTES_STANDARD,
  GRID_SIZE
} from '../frame/constants.js';

// Linear-light crosstalk unmixing strengths tried (in addition to the learned one) for 4-PAM stripes
const XTALK_CANDIDATES = [0, 0.08, 0.14];

/**
 * Detects grid density (80, 96, or 112) using fast timing track contrast discrimination.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame buffer
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {object} corners - { TL, TR, BL, BR }
 * @returns {number} Detected grid density: 80, 96, or 112
 */
export function detectGridDensity(rgba, width, height, corners) {
  if (!corners || !corners.TL || !corners.TR || !corners.BL || !corners.BR) {
    return 80;
  }
  const cornerPts = [corners.TL, corners.TR, corners.BL, corners.BR];
  let bestG = 80;
  let bestScore = -Infinity;

  for (const G of [80, 96, 112]) {
    const H = solveHomography(cornerPts, G);
    if (!H) continue;
    let contrastSum = 0;
    let count = 0;
    for (const row of [0.5, G - 0.5]) {
      for (let col = 8; col <= G - 9; col++) {
        const { x, y } = projectH(H, col + 0.5, row);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi >= 0 && xi < width && yi >= 0 && yi < height) {
          const idx = (yi * width + xi) * 4;
          const luma = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
          contrastSum += ((col - 8) & 1) === 0 ? luma : -luma;
          count++;
        }
      }
    }
    const score = count > 0 ? contrastSum / count : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      bestG = G;
    }
  }
  return bestG;
}

export class FrameDecoder {
  constructor(options = {}) {
    this.options = { ...options };
    this.version = options.version || 1;
    this.autoGrid = options.gridSize === 'auto' || this.version === 'auto';
    this.gridSize = (options.gridSize && options.gridSize !== 'auto') ? options.gridSize : GRID_SIZE;
    this.bitsPerCell = options.bitsPerCell || null;
    this.numStripes = options.numStripes || ((this.version === 2 || this.version === 'auto') ? 8 : 4);
    this.rateMode = options.rateMode ?? 1;

    this.layoutV1 = getLayout();
    this.layoutV2 = getLayoutV2({ gridSize: this.gridSize, numStripes: 8 });
    this.layout = this.version === 2 ? this.layoutV2 : this.layoutV1;
    this.prevCorners = null;
    this.lockCount = 0;
    this.missCount = 0;

    const maxCells = 112 * 112;
    this.gridRgb = new Float32Array(maxCells * 3);
    this.gridInBounds = new Uint8Array(maxCells);
    this.centroids = null;
    this.lastCleanStripe = -1;
    this.lastCleanThresh = null;
    this.k1 = null;
    this.fullFrameLens = null;
    this.xtalkAlpha = 0;
    this._lastTurbo = null;

    this.stripeAccumV1 = Array.from({ length: 4 }, () => this._newStripeSlot());
    this.stripeAccumV2 = Array.from({ length: 8 }, () => this._newStripeSlot());
  }

  get stripeAccum() {
    return (this.version === 2 || this.version === 'auto') ? this.stripeAccumV2 : this.stripeAccumV1;
  }

  set stripeAccum(val) {
    if (this.version === 2 || this.version === 'auto') {
      this.stripeAccumV2 = val;
    } else {
      this.stripeAccumV1 = val;
    }
  }

  _newStripeSlot() {
    return {
      count: 0,
      curRgb: null,
      curThresh: null,
      sumRgb: null,
      sumThresh: null,
      prevRgb: null,
      prevThresh: null,
      accumSymbols: null,
      accumMargins: null,
      hasPrev: false,
      decodedInHold: false,
      lastResult: null
    };
  }

  _allocateStripeState(st, count) {
    st.curRgb = new Float32Array(count * 3);
    st.curThresh = new Float32Array(count * 3);
    st.sumRgb = new Float32Array(count * 3);
    st.sumThresh = new Float32Array(count * 3);
    st.prevRgb = new Float32Array(count * 3);
    st.prevThresh = new Float32Array(count * 3);
    st.accumSymbols = new Uint8Array(count);
    st.accumMargins = new Float32Array(count);
    st.hasPrev = false;
    st.count = 0;
    st.decodedInHold = false;
    st.lastResult = null;
  }

  setOptions(options = {}) {
    let changed = false;
    if (options.version !== undefined && options.version !== this.version) {
      this.version = options.version;
      changed = true;
    }
    if (options.gridSize !== undefined) {
      if (options.gridSize === 'auto') {
        this.autoGrid = true;
      } else {
        this.autoGrid = false;
        if (options.gridSize !== this.gridSize) {
          this.gridSize = options.gridSize;
          changed = true;
        }
      }
    }
    if (options.bitsPerCell !== undefined && options.bitsPerCell !== this.bitsPerCell) {
      this.bitsPerCell = options.bitsPerCell;
      changed = true;
    }
    if (options.numStripes !== undefined && options.numStripes !== this.numStripes) {
      this.numStripes = options.numStripes;
      changed = true;
    } else if ((this.version === 2 || this.version === 'auto') && this.numStripes === 4) {
      this.numStripes = 8;
      changed = true;
    }
    if (options.rateMode !== undefined) {
      this.rateMode = options.rateMode;
    }

    if (changed) {
      this.layoutV1 = getLayout();
      this.layoutV2 = getLayoutV2({ gridSize: this.gridSize, numStripes: this.numStripes || 8 });
      this.layout = this.version === 2 ? this.layoutV2 : this.layoutV1;
      this._resetAccum();
    }
  }

  _initStripeAccum() {
    this.stripeAccumV1 = Array.from({ length: 4 }, () => this._newStripeSlot());
    this.stripeAccumV2 = Array.from({ length: 8 }, () => this._newStripeSlot());
  }

  _resetAccum() {
    this.centroids = null;
    this.lastCleanStripe = -1;
    this.lastCleanThresh = null;
    this.k1 = null;
    this.fullFrameLens = null;
    for (let s = 0; s < 4; s++) {
      const st = this.stripeAccumV1[s];
      if (st) {
        st.count = 0;
        st.hasPrev = false;
        st.decodedInHold = false;
        st.lastResult = null;
      }
    }
    for (let s = 0; s < 8; s++) {
      const st = this.stripeAccumV2[s];
      if (st) {
        st.count = 0;
        st.hasPrev = false;
        st.decodedInHold = false;
        st.lastResult = null;
      }
    }
  }

  _updateCentroids(s, header, payloadU32, curRgb, curThresh) {
    try {
      const truePacket = buildPacket(header, payloadU32);
      const trueSymbols = bytesToSymbols(truePacket, 1446);

      const counts = new Uint16Array(8);
      const sums = new Float32Array(24);

      for (let i = 0; i < 1446; i++) {
        const sym = trueSymbols[i];
        const i3 = i * 3;
        const k3 = sym * 3;
        sums[k3] += curRgb[i3];
        sums[k3 + 1] += curRgb[i3 + 1];
        sums[k3 + 2] += curRgb[i3 + 2];
        counts[sym]++;
      }

      if (!this.centroids) {
        this.centroids = new Float32Array(24);
        for (let k = 0; k < 8; k++) {
          if (counts[k] > 0) {
            const inv = 1.0 / counts[k];
            this.centroids[k * 3] = sums[k * 3] * inv;
            this.centroids[k * 3 + 1] = sums[k * 3 + 1] * inv;
            this.centroids[k * 3 + 2] = sums[k * 3 + 2] * inv;
          }
        }
      } else {
        const alpha = 0.35;
        for (let k = 0; k < 8; k++) {
          if (counts[k] > 0) {
            const inv = 1.0 / counts[k];
            const rMean = sums[k * 3] * inv;
            const gMean = sums[k * 3 + 1] * inv;
            const bMean = sums[k * 3 + 2] * inv;
            this.centroids[k * 3] = (1 - alpha) * this.centroids[k * 3] + alpha * rMean;
            this.centroids[k * 3 + 1] = (1 - alpha) * this.centroids[k * 3 + 1] + alpha * gMean;
            this.centroids[k * 3 + 2] = (1 - alpha) * this.centroids[k * 3 + 2] + alpha * bMean;
          }
        }
      }

      let sumTr = 0, sumTg = 0, sumTb = 0;
      for (let i = 0; i < 1446; i++) {
        const i3 = i * 3;
        sumTr += curThresh[i3];
        sumTg += curThresh[i3 + 1];
        sumTb += curThresh[i3 + 2];
      }

      this.lastCleanStripe = s;
      this.lastCleanThresh = [sumTr / 1446, sumTg / 1446, sumTb / 1446];
    } catch (_) {
      // Ignore centroid update failures
    }
  }

  _tryCentroidDecode(s, count, curRgb, curThresh) {
    if (!this.centroids) return { ok: false };

    const baseTr = this.lastCleanThresh ? this.lastCleanThresh[0] : 128;
    const baseTg = this.lastCleanThresh ? this.lastCleanThresh[1] : 128;
    const baseTb = this.lastCleanThresh ? this.lastCleanThresh[2] : 128;

    const cSymbols = new Uint8Array(count);
    const cMargins = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const dTr = curThresh[i3] - baseTr;
      const dTg = curThresh[i3 + 1] - baseTg;
      const dTb = curThresh[i3 + 2] - baseTb;
      const rAdj = curRgb[i3] - dTr;
      const gAdj = curRgb[i3 + 1] - dTg;
      const bAdj = curRgb[i3 + 2] - dTb;

      const res = sliceCellCentroid(rAdj, gAdj, bAdj, this.centroids);
      cSymbols[i] = res.sym;
      cMargins[i] = res.margin;
    }

    const cSym1446 = cSymbols.subarray(0, 1446);
    const cPkt = symbolsToBytes(cSym1446, PACKET_TOTAL_BYTES);
    const cByteMargins = symbolsMarginsToByteMargins(cMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);

    return parsePacket(cPkt, s, cByteMargins);
  }

  /**
   * Decodes a single camera frame RGBA buffer.
   *
   * @param {Uint8ClampedArray|Uint8Array} rgba - Camera frame buffer
   * @param {number} width - Camera width
   * @param {number} height - Camera height
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   corners?: { TL: {x,y}, TR: {x,y}, BL: {x,y}, BR: {x,y} },
   *   stripes?: Array<{
   *     stripeIdx: number,
   *     ok: boolean,
   *     header?: object,
   *     payloadU32?: Uint32Array,
   *     corrected?: number
   *   }>,
   *   stats?: object
   * }}
   */
  decode(rgba, width, height, roi = null, options = null) {
    if (options) {
      this.setOptions(options);
    }
    const t0 = performance.now();

    // 1. Finder detection / tracking
    const localPrev = (this.prevCorners && roi)
      ? this.prevCorners.map(p => ({ x: p.x - roi.x, y: p.y - roi.y }))
      : this.prevCorners;

    const finderRes = findCorners(rgba, width, height, {
      prevCorners: localPrev
    });

    if (!finderRes.found || !finderRes.corners) {
      this.prevCorners = null;
      this.lockCount = 0;
      this._resetAccum();
      return {
        ok: false,
        error: 'FINDER_NOT_FOUND',
        stats: { totalMs: performance.now() - t0 }
      };
    }

    const corners = finderRes.corners;
    const globalCorners = roi ? {
      TL: { x: corners.TL.x + roi.x, y: corners.TL.y + roi.y },
      TR: { x: corners.TR.x + roi.x, y: corners.TR.y + roi.y },
      BL: { x: corners.BL.x + roi.x, y: corners.BL.y + roi.y },
      BR: { x: corners.BR.x + roi.x, y: corners.BR.y + roi.y }
    } : corners;
    this.prevCorners = [globalCorners.TL, globalCorners.TR, globalCorners.BL, globalCorners.BR];
    this.lockCount++;

    // 2. Grid density resolution
    // v1 is always 80x80; otherwise only run density detection when auto-grid is on.
    const activeGridSize = this.version === 1
      ? 80
      : (this.autoGrid ? detectGridDensity(rgba, width, height, corners) : this.gridSize);

    // 3. Solve Homography for active grid size
    const H = solveHomography([corners.TL, corners.TR, corners.BL, corners.BR], activeGridSize);
    if (!H) {
      this._resetAccum();
      return {
        ok: false,
        error: 'HOMOGRAPHY_SINGULAR',
        corners: globalCorners,
        stats: { totalMs: performance.now() - t0 }
      };
    }

    // 4. Timing track refinement & lens distortion compensation
    const timingRefiner = new TimingRefiner(
      rgba,
      width,
      height,
      H,
      [corners.TL, corners.TR, corners.BL, corners.BR],
      // k1 is only searched on full frames. ROI crops reuse the cached value around the FULL frame's
      // optical center (never the crop center); with no cached value they assume no lens distortion.
      this.k1 !== null ? this.k1 : (roi ? 0 : null),
      activeGridSize,
      roi && this.fullFrameLens
        ? { cx: this.fullFrameLens.cx - roi.x, cy: this.fullFrameLens.cy - roi.y, normScale: this.fullFrameLens.normScale }
        : null
    );
    if (this.k1 === null && !roi) {
      this.k1 = timingRefiner.bestK1;
      this.fullFrameLens = { cx: width * 0.5, cy: height * 0.5, normScale: Math.min(width, height) * 0.5 };
    }

    // 5. Pre-sample full cell grid FIRST so pilot calibrator can use matched unsharp mask
    sampleFullGrid(rgba, width, height, H, timingRefiner, this.gridRgb, this.gridInBounds, activeGridSize);

    // 6. Pilot calibration with gridRgb and activeGridSize
    const pilotCalibrator = new PilotCalibrator(rgba, width, height, H, timingRefiner, {
      gridSize: activeGridSize,
      gridRgb: this.gridRgb
    });

    const finish = (res, version, gridSize) => {
      if (res.validStripesCount > 0) {
        this.missCount = 0;
      } else {
        this.missCount = (this.missCount || 0) + 1;
      }

      if (this.lockCount >= 120) {
        this.prevCorners = null;
        this.lockCount = 0;
      }

      return {
        ok: res.validStripesCount > 0,
        corners: globalCorners,
        stripes: res.stripes,
        stats: {
          totalMs: performance.now() - t0,
          validStripesCount: res.validStripesCount,
          version: res.validStripesCount > 0 ? version : (this.version === 'auto' ? 'auto' : version),
          gridSize
        }
      };
    };

    if (this.version === 1) {
      const resV1 = this._decodeV1Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator);
      return finish(resV1, 1, 80);
    }

    if (this.version === 2) {
      const resV2 = this._decodeV2Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator, activeGridSize);
      return finish(resV2, 2, activeGridSize);
    }

    if (this.version === 'auto') {
      // 2-PAM pilots on an 80x80 grid: cheap v1 decode first, then v2 3-bit as the fallback.
      // 4-PAM pilots (or 96/112 grids) can only be v2.
      if (activeGridSize === 80 && !pilotCalibrator.hasPamPilots) {
        const resV1 = this._decodeV1Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator);
        if (resV1.validStripesCount > 0) return finish(resV1, 1, 80);
        const resV2 = this._decodeV2Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator, activeGridSize);
        return finish(resV2.validStripesCount > 0 ? resV2 : resV1, resV2.validStripesCount > 0 ? 2 : 1, 80);
      }
      const resV2 = this._decodeV2Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator, activeGridSize);
      return finish(resV2, 2, activeGridSize);
    }

    return {
      ok: false,
      corners: globalCorners,
      stripes: [],
      stats: {
        totalMs: performance.now() - t0,
        validStripesCount: 0,
        version: this.version
      }
    };
  }

  /**
   * Slices one (averaged) cell for the given modulation using the local pilot thresholds.
   * @private
   */
  _sliceCellForBpc(bpc, pilotCalibrator, c, r, rVal, gVal, bVal, alpha = this.xtalkAlpha) {
    if (bpc === 6 && pilotCalibrator?.getThresholds4Pam) {
      return sliceCell4Pam(rVal, gVal, bVal, pilotCalibrator.getThresholds4Pam(c, r), alpha);
    }
    if (bpc === 5 && pilotCalibrator?.getThresholds4Pam) {
      const t4 = pilotCalibrator.getThresholds4Pam(c, r);
      const { Tb } = pilotCalibrator.getThresholds(c, r);
      return sliceCell5Pam(rVal, gVal, bVal, t4, Tb, alpha);
    }
    const { Tr, Tg, Tb } = pilotCalibrator.getThresholds(c, r);
    const sc = pilotCalibrator.getScales
      ? pilotCalibrator.getScales(c, r)
      : { scaleR: 1.0, scaleG: 1.0, scaleB: 1.0 };
    return sliceCellCausal(rVal, gVal, bVal, Tr, Tg, Tb, sc.scaleR, sc.scaleG, sc.scaleB);
  }

  _decodeV2Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator, activeGridSize = 80) {
    const numStripes = 8;
    const layout = getLayoutV2({ gridSize: activeGridSize, numStripes });
    const stripes = new Array(numStripes);
    let validStripesCount = 0;
    // Modulation: explicit option wins; otherwise infer from the pilot style (4-PAM grayscale -> 6-bit, 2-PAM -> 3-bit)
    const bpc = this.bitsPerCell || (pilotCalibrator.hasPamPilots ? 6 : 3);

    for (let s = 0; s < numStripes; s++) {
      const dataCells = layout.stripeDataCells[s];
      const count = dataCells.length;
      let st = this.stripeAccumV2[s];
      if (!st) {
        st = this._newStripeSlot();
        this.stripeAccumV2[s] = st;
      }

      if (!st.curRgb || st.curRgb.length !== count * 3) {
        this._allocateStripeState(st, count);
      }

      const sampleRes = sampleStripeCells(
        rgba,
        width,
        height,
        H,
        timingRefiner,
        pilotCalibrator,
        dataCells,
        st.accumSymbols,
        st.accumMargins,
        st.curRgb,
        st.curThresh,
        this.gridRgb,
        this.gridInBounds,
        { gridSize: activeGridSize, bitsPerCell: bpc, xtalkAlpha: this.xtalkAlpha }
      );

      if (!sampleRes.ok) {
        st.count = 0;
        st.hasPrev = false;
        st.decodedInHold = false;
        st.lastResult = null;
        stripes[s] = { stripeIdx: s, ok: false, error: 'SAMPLE_OUT_OF_BOUNDS' };
        continue;
      }

      let mad = 0;
      if (st.hasPrev) {
        let diff = 0;
        const len = count * 3;
        for (let k = 0; k < len; k++) {
          diff += Math.abs(st.curRgb[k] - st.prevRgb[k]);
        }
        mad = diff / len;
      }

      if (!st.hasPrev || mad > 14) {
        st.count = 1;
        st.decodedInHold = false;
        st.lastResult = null;
        st.sumRgb.set(st.curRgb);
        st.sumThresh.set(st.curThresh);
      } else {
        st.count++;
        const len = count * 3;
        for (let k = 0; k < len; k++) {
          st.sumRgb[k] += st.curRgb[k];
          st.sumThresh[k] += st.curThresh[k];
        }
      }

      if (st.decodedInHold && mad < 10 && st.lastResult) {
        stripes[s] = st.lastResult;
        validStripesCount++;
        st.prevRgb.set(st.curRgb);
        st.prevThresh.set(st.curThresh);
        st.hasPrev = true;
        continue;
      }

      const tryParse = (symbols, margins) => {
        const symBits = symbols.length * bpc;
        const attempt = (len) => {
          const pkt = symbolsToBytesMultiBit(symbols, bpc, len);
          const m = margins ? symbolsMarginsToByteMarginsMultiBit(margins, bpc, len) : null;
          return parsePacketV2(pkt, s, m);
        };
        const sizes = [];
        const turboSizes = symBits >= 496 * 8 ? [488, 496] : (symBits >= 488 * 8 ? [488] : []);
        const stdSizes = [];
        if (symBits >= V2_PACKET_BYTES_HIGH_RATE * 8) stdSizes.push(V2_PACKET_BYTES_HIGH_RATE);
        if (symBits >= V2_PACKET_BYTES_STANDARD * 8) stdSizes.push(V2_PACKET_BYTES_STANDARD);
        // Try the packet family that last succeeded first (the sender's mode is stable)
        if (this._lastTurbo === false) sizes.push(...stdSizes, ...turboSizes);
        else sizes.push(...turboSizes, ...stdSizes);

        let res = { ok: false };
        for (const len of sizes) {
          res = attempt(len);
          if (res.ok) {
            this._lastTurbo = len >= 488;
            return res;
          }
        }
        return res;
      };

      let packetRes = tryParse(sampleRes.symbols, sampleRes.margins);

      // Adaptive linear-light crosstalk unmixing (4-PAM only): clean captures want alpha=0,
      // real cameras want ~0.08. Re-slice the stored RGB with alternative alphas on failure
      // and remember whichever alpha works.
      if (!packetRes.ok && bpc >= 5 && pilotCalibrator.getThresholds4Pam) {
        if (!this._xSym || this._xSym.length < count) {
          this._xSym = new Uint8Array(count);
          this._xMar = new Float32Array(count);
        }
        for (const a of XTALK_CANDIDATES) {
          if (a === this.xtalkAlpha) continue;
          for (let i = 0; i < count; i++) {
            const { r, c } = dataCells[i];
            const i3 = i * 3;
            const sl = this._sliceCellForBpc(bpc, pilotCalibrator, c, r, st.curRgb[i3], st.curRgb[i3 + 1], st.curRgb[i3 + 2], a);
            this._xSym[i] = sl.sym;
            this._xMar[i] = sl.margin;
          }
          const xr = tryParse(this._xSym.subarray(0, count), this._xMar.subarray(0, count));
          if (xr.ok) {
            packetRes = xr;
            this.xtalkAlpha = a;
            break;
          }
        }
      }

      if (!packetRes.ok && st.hasPrev && mad <= 14) {
        for (let i = 0; i < count; i++) {
          const { r, c } = dataCells[i];
          const i3 = i * 3;
          const rAvg = 0.5 * (st.curRgb[i3] + st.prevRgb[i3]);
          const gAvg = 0.5 * (st.curRgb[i3 + 1] + st.prevRgb[i3 + 1]);
          const bAvg = 0.5 * (st.curRgb[i3 + 2] + st.prevRgb[i3 + 2]);
          const sliced = this._sliceCellForBpc(bpc, pilotCalibrator, c, r, rAvg, gAvg, bAvg);
          st.accumSymbols[i] = sliced.sym;
          st.accumMargins[i] = sliced.margin;
        }
        const pairRes = tryParse(st.accumSymbols, st.accumMargins);
        if (pairRes.ok) {
          packetRes = pairRes;
        }
      }

      if (!packetRes.ok && st.count >= 3 && mad <= 14) {
        const inv = 1.0 / st.count;
        for (let i = 0; i < count; i++) {
          const { r, c } = dataCells[i];
          const i3 = i * 3;
          const rAvg = st.sumRgb[i3] * inv;
          const gAvg = st.sumRgb[i3 + 1] * inv;
          const bAvg = st.sumRgb[i3 + 2] * inv;
          const sliced = this._sliceCellForBpc(bpc, pilotCalibrator, c, r, rAvg, gAvg, bAvg);
          st.accumSymbols[i] = sliced.sym;
          st.accumMargins[i] = sliced.margin;
        }
        const accRes = tryParse(st.accumSymbols, st.accumMargins);
        if (accRes.ok) {
          packetRes = accRes;
        }
      }

      st.prevRgb.set(st.curRgb);
      st.prevThresh.set(st.curThresh);
      st.hasPrev = true;

      if (packetRes.ok) {
        st.decodedInHold = true;
        st.lastResult = {
          stripeIdx: s,
          ok: true,
          header: packetRes.header,
          payloadU32: packetRes.payloadU32,
          corrected: packetRes.corrected
        };
        validStripesCount++;
        stripes[s] = st.lastResult;
      } else {
        stripes[s] = {
          stripeIdx: s,
          ok: false,
          error: packetRes.error || 'DECODE_FAILED'
        };
      }
    }

    return { stripes, validStripesCount };
  }

  _decodeV1Stripes(rgba, width, height, H, timingRefiner, pilotCalibrator) {
    const stripes = new Array(4);
    let validStripesCount = 0;
    const layout = this.layoutV1 || getLayout();

    for (let s = 0; s < 4; s++) {
      const dataCells = layout.stripeDataCells[s];
      const count = dataCells.length;
      let st = this.stripeAccumV1[s];
      if (!st) {
        st = this._newStripeSlot();
        this.stripeAccumV1[s] = st;
      }

      if (!st.curRgb || st.curRgb.length !== count * 3) {
        this._allocateStripeState(st, count);
      }

      const sampleRes = sampleStripeCells(
        rgba,
        width,
        height,
        H,
        timingRefiner,
        pilotCalibrator,
        dataCells,
        undefined,
        undefined,
        st.curRgb,
        st.curThresh,
        this.gridRgb,
        this.gridInBounds
      );

      if (!sampleRes.ok) {
        st.count = 0;
        st.hasPrev = false;
        st.decodedInHold = false;
        st.lastResult = null;
        stripes[s] = { stripeIdx: s, ok: false, error: 'SAMPLE_OUT_OF_BOUNDS' };
        continue;
      }

      let mad = 0;
      let tearRowsCount = 0;
      let rMin = 0;
      let numRows = 0;
      let rowMad = null;

      if (st.hasPrev) {
        rMin = dataCells[0].r;
        const rMax = dataCells[count - 1].r;
        numRows = rMax - rMin + 1;
        const rowDiffSum = new Float32Array(numRows);
        const rowCellCount = new Uint16Array(numRows);

        let totalDiff = 0;
        const len = st.curRgb.length;
        for (let i = 0; i < count; i++) {
          const rIdx = dataCells[i].r - rMin;
          const i3 = i * 3;
          const d = Math.abs(st.curRgb[i3] - st.prevRgb[i3]) +
                    Math.abs(st.curRgb[i3 + 1] - st.prevRgb[i3 + 1]) +
                    Math.abs(st.curRgb[i3 + 2] - st.prevRgb[i3 + 2]);
          totalDiff += d;
          rowDiffSum[rIdx] += d;
          rowCellCount[rIdx]++;
        }
        mad = totalDiff / len;

        rowMad = new Float32Array(numRows);
        for (let r = 0; r < numRows; r++) {
          rowMad[r] = rowCellCount[r] > 0 ? (rowDiffSum[r] / (rowCellCount[r] * 3.0)) : 0;
          if (rowMad[r] > 18) tearRowsCount++;
        }
      }

      if (!st.hasPrev || (mad > 15 && tearRowsCount > 2)) {
        st.count = 1;
        st.decodedInHold = false;
        st.lastResult = null;
        st.sumRgb.set(st.curRgb);
        st.sumThresh.set(st.curThresh);
      } else {
        st.count++;
        const len = st.curRgb.length;
        for (let k = 0; k < len; k++) {
          st.sumRgb[k] += st.curRgb[k];
          st.sumThresh[k] += st.curThresh[k];
        }
      }

      if (st.decodedInHold && mad < 12 && st.lastResult) {
        stripes[s] = st.lastResult;
        validStripesCount++;
        st.prevRgb.set(st.curRgb);
        st.prevThresh.set(st.curThresh);
        st.hasPrev = true;
        continue;
      }

      const symbols1446 = sampleRes.symbols.subarray(0, 1446);
      const packetBytes = symbolsToBytes(symbols1446, PACKET_TOTAL_BYTES);
      const byteMargins = sampleRes.margins
        ? symbolsMarginsToByteMargins(sampleRes.margins.subarray(0, 1446), PACKET_TOTAL_BYTES)
        : null;

      let packetRes = parsePacket(packetBytes, s, byteMargins);

      if (!packetRes.ok && st.hasPrev && rowMad && tearRowsCount >= 1 && tearRowsCount <= 3 && sampleRes.margins) {
        const tearMargins = new Float32Array(sampleRes.margins);
        for (let i = 0; i < count; i++) {
          const rIdx = dataCells[i].r - rMin;
          if (rowMad[rIdx] > 18) {
            tearMargins[i] = 0;
          }
        }
        const tearByteMargins = symbolsMarginsToByteMargins(tearMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);
        packetRes = parsePacket(packetBytes, s, tearByteMargins);
      }

      if (!packetRes.ok && st.hasPrev && rowMad && numRows > 4) {
        let splitRow = -1;
        for (let r = 1; r < numRows - 1; r++) {
          if (Math.abs(rowMad[r] - rowMad[r - 1]) > 8) {
            splitRow = r;
            break;
          }
        }
        if (splitRow > 0) {
          const topTransitioned = rowMad[0] > 14;
          for (let i = 0; i < count; i++) {
            const rIdx = dataCells[i].r - rMin;
            const i3 = i * 3;
            const isTransitioned = (rIdx < splitRow) ? topTransitioned : !topTransitioned;
            const useCur = !isTransitioned;
            const srcRgb = useCur ? st.curRgb : st.prevRgb;
            const srcThresh = useCur ? st.curThresh : st.prevThresh;
            const Tr = srcThresh[i3];
            const Tg = srcThresh[i3 + 1];
            const Tb = srcThresh[i3 + 2];
            const sliced = sliceCellCausal(srcRgb[i3], srcRgb[i3 + 1], srcRgb[i3 + 2], Tr, Tg, Tb);
            st.accumSymbols[i] = sliced.sym;
            st.accumMargins[i] = sliced.margin;
          }
          const stitchSym1446 = st.accumSymbols.subarray(0, 1446);
          const stitchPkt = symbolsToBytes(stitchSym1446, PACKET_TOTAL_BYTES);
          const stitchMargins = symbolsMarginsToByteMargins(st.accumMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);
          const stitchRes = parsePacket(stitchPkt, s, stitchMargins);
          if (stitchRes.ok) {
            packetRes = stitchRes;
          }
        }
      }

      if (!packetRes.ok && this.centroids) {
        const centroidRes = this._tryCentroidDecode(s, count, st.curRgb, st.curThresh);
        if (centroidRes.ok) {
          packetRes = centroidRes;
        }
      }

      if (!packetRes.ok && st.hasPrev && mad <= 15) {
        for (let i = 0; i < count; i++) {
          const i3 = i * 3;
          const rAvg = 0.5 * (st.curRgb[i3] + st.prevRgb[i3]);
          const gAvg = 0.5 * (st.curRgb[i3 + 1] + st.prevRgb[i3 + 1]);
          const bAvg = 0.5 * (st.curRgb[i3 + 2] + st.prevRgb[i3 + 2]);
          const Tr = 0.5 * (st.curThresh[i3] + st.prevThresh[i3]);
          const Tg = 0.5 * (st.curThresh[i3 + 1] + st.prevThresh[i3 + 1]);
          const Tb = 0.5 * (st.curThresh[i3 + 2] + st.prevThresh[i3 + 2]);

          const sliced = sliceCellCausal(rAvg, gAvg, bAvg, Tr, Tg, Tb);
          st.accumSymbols[i] = sliced.sym;
          st.accumMargins[i] = sliced.margin;
        }

        const pairSym1446 = st.accumSymbols.subarray(0, 1446);
        const pairPkt = symbolsToBytes(pairSym1446, PACKET_TOTAL_BYTES);
        const pairMargins = symbolsMarginsToByteMargins(st.accumMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);

        packetRes = parsePacket(pairPkt, s, pairMargins);
      }

      if (!packetRes.ok && st.count >= 3 && mad <= 15) {
        const inv = 1.0 / st.count;
        for (let i = 0; i < count; i++) {
          const i3 = i * 3;
          const rAvg = st.sumRgb[i3] * inv;
          const gAvg = st.sumRgb[i3 + 1] * inv;
          const bAvg = st.sumRgb[i3 + 2] * inv;
          const Tr = st.sumThresh[i3] * inv;
          const Tg = st.sumThresh[i3 + 1] * inv;
          const Tb = st.sumThresh[i3 + 2] * inv;

          const sliced = sliceCellCausal(rAvg, gAvg, bAvg, Tr, Tg, Tb);
          st.accumSymbols[i] = sliced.sym;
          st.accumMargins[i] = sliced.margin;
        }

        const accSym1446 = st.accumSymbols.subarray(0, 1446);
        const accPkt = symbolsToBytes(accSym1446, PACKET_TOTAL_BYTES);
        const accMargins = symbolsMarginsToByteMargins(st.accumMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);

        packetRes = parsePacket(accPkt, s, accMargins);
      }

      st.prevRgb.set(st.curRgb);
      st.prevThresh.set(st.curThresh);
      st.hasPrev = true;

      if (packetRes.ok) {
        this._updateCentroids(s, packetRes.header, packetRes.payloadU32, st.curRgb, st.curThresh);
        st.decodedInHold = true;
        st.lastResult = {
          stripeIdx: s,
          ok: true,
          header: packetRes.header,
          payloadU32: packetRes.payloadU32,
          corrected: packetRes.corrected
        };
        validStripesCount++;
        stripes[s] = st.lastResult;
      } else {
        stripes[s] = {
          stripeIdx: s,
          ok: false,
          error: packetRes.error
        };
      }
    }

    return { stripes, validStripesCount };
  }
}
