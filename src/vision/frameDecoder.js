/**
 * Frame decoder: Full RX vision pipeline per camera frame.
 * Finders -> Homography -> Timing Refinement -> Pilots -> Sampler -> Bitpack -> RS -> CRC.
 */

import { findCorners } from './finder.js';
import { solveHomography } from './homography.js';
import { TimingRefiner } from './timing.js';
import { PilotCalibrator } from './pilots.js';
import { sampleStripeCells, sampleFullGrid, sliceCellCausal, sliceCellCentroid } from './sampler.js';
import { getLayout } from '../frame/layout.js';
import { symbolsToBytes, symbolsMarginsToByteMargins, bytesToSymbols } from '../core/bitpack.js';
import { parsePacket, buildPacket } from '../frame/packet.js';
import { PACKET_TOTAL_BYTES } from '../frame/constants.js';

export class FrameDecoder {
  constructor() {
    this.layout = getLayout();
    this.prevCorners = null;
    this.lockCount = 0;
    this.missCount = 0;
    this.gridRgb = new Float32Array(6400 * 3);
    this.gridInBounds = new Uint8Array(6400);
    this.centroids = null;
    this.lastCleanStripe = -1;
    this.lastCleanThresh = null;
    this.k1 = null;
    this.stripeAccum = Array.from({ length: 4 }, () => ({
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
    }));
  }

  _resetAccum() {
    this.centroids = null;
    this.lastCleanStripe = -1;
    this.lastCleanThresh = null;
    this.k1 = null;
    for (let s = 0; s < 4; s++) {
      const st = this.stripeAccum[s];
      st.count = 0;
      st.hasPrev = false;
      st.decodedInHold = false;
      st.lastResult = null;
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
  decode(rgba, width, height, roi = null) {
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

    // 2. Solve Homography
    const H = solveHomography([corners.TL, corners.TR, corners.BL, corners.BR]);
    if (!H) {
      this._resetAccum();
      return {
        ok: false,
        error: 'HOMOGRAPHY_SINGULAR',
        corners: globalCorners,
        stats: { totalMs: performance.now() - t0 }
      };
    }

    // 3. Timing track refinement & lens distortion compensation
    const timingRefiner = new TimingRefiner(
      rgba,
      width,
      height,
      H,
      [corners.TL, corners.TR, corners.BL, corners.BR],
      this.k1
    );
    if (this.k1 === null) {
      this.k1 = timingRefiner.bestK1;
    }

    // 4. Pilot calibration with timing offset
    const pilotCalibrator = new PilotCalibrator(rgba, width, height, H, timingRefiner);

    // 5. Pre-sample full 80x80 cell grid once for all stripes
    sampleFullGrid(rgba, width, height, H, timingRefiner, this.gridRgb, this.gridInBounds);

    // 6. Sample and decode each of the 4 stripes
    const stripes = new Array(4);
    let validStripesCount = 0;

    for (let s = 0; s < 4; s++) {
      const dataCells = this.layout.stripeDataCells[s];
      const count = dataCells.length;
      const st = this.stripeAccum[s];

      if (!st.curRgb || st.curRgb.length !== count * 3) {
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

      // If already decoded in this stationary hold window, skip redundant RS decoding
      if (st.decodedInHold && mad < 12 && st.lastResult) {
        stripes[s] = st.lastResult;
        validStripesCount++;
        st.prevRgb.set(st.curRgb);
        st.prevThresh.set(st.curThresh);
        st.hasPrev = true;
        continue;
      }

      // Convert 1446 symbols into 542 packet bytes
      const symbols1446 = sampleRes.symbols.subarray(0, 1446);
      const packetBytes = symbolsToBytes(symbols1446, PACKET_TOTAL_BYTES);
      const byteMargins = sampleRes.margins
        ? symbolsMarginsToByteMargins(sampleRes.margins.subarray(0, 1446), PACKET_TOTAL_BYTES)
        : null;

      // 1. Single-frame raw decode
      let packetRes = parsePacket(packetBytes, s, byteMargins);

      // 1b. If failed and 1-3 transition tear rows detected, try localized RS row erasures
      if (!packetRes.ok && st.hasPrev && rowMad && tearRowsCount >= 1 && tearRowsCount <= 3 && sampleRes.margins) {
        const tearMargins = new Float32Array(sampleRes.margins);
        for (let i = 0; i < count; i++) {
          const rIdx = dataCells[i].r - rMin;
          if (rowMad[rIdx] > 18) {
            tearMargins[i] = 0; // Force erasure on tearing row
          }
        }
        const tearByteMargins = symbolsMarginsToByteMargins(tearMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);
        packetRes = parsePacket(packetBytes, s, tearByteMargins);
      }

      // 1c. If failed and rolling-shutter tear split detected, try sub-stripe complementary stitching
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

      // 1d. If failed, try 8-color decision-directed centroid fallback
      if (!packetRes.ok && this.centroids) {
        const centroidRes = this._tryCentroidDecode(s, count, st.curRgb, st.curThresh);
        if (centroidRes.ok) {
          packetRes = centroidRes;
        }
      }

      // 2. If failed, try 2-frame pair average fallback
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

      // 3. If still failed, try multi-frame accumulator average
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

    if (validStripesCount > 0) {
      this.missCount = 0;
    } else {
      this.missCount = (this.missCount || 0) + 1;
    }

    if (this.lockCount >= 120) {
      this.prevCorners = null;
      this.lockCount = 0;
    }

    const totalMs = performance.now() - t0;

    return {
      ok: validStripesCount > 0,
      corners: globalCorners,
      stripes,
      stats: {
        totalMs,
        validStripesCount,
        lockCount: this.lockCount
      }
    };
  }
}
