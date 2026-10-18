/**
 * Frame decoder: Full RX vision pipeline per camera frame.
 * Finders -> Homography -> Timing Refinement -> Pilots -> Sampler -> Bitpack -> RS -> CRC.
 */

import { findCorners } from './finder.js';
import { solveHomography } from './homography.js';
import { TimingRefiner } from './timing.js';
import { PilotCalibrator } from './pilots.js';
import { sampleStripeCells } from './sampler.js';
import { getLayout } from '../frame/layout.js';
import { symbolsToBytes, symbolsMarginsToByteMargins } from '../core/bitpack.js';
import { parsePacket } from '../frame/packet.js';
import { PACKET_TOTAL_BYTES } from '../frame/constants.js';

export class FrameDecoder {
  constructor() {
    this.layout = getLayout();
    this.prevCorners = null;
    this.lockCount = 0;
    this.missCount = 0;
    this.stripeAccum = Array.from({ length: 4 }, () => ({
      count: 0,
      curRgb: null,
      curThresh: null,
      sumRgb: null,
      sumThresh: null,
      prevRgb: null,
      accumSymbols: null,
      accumMargins: null,
      hasPrev: false
    }));
  }

  _resetAccum() {
    for (let s = 0; s < 4; s++) {
      const st = this.stripeAccum[s];
      st.count = 0;
      st.hasPrev = false;
    }
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
  decode(rgba, width, height) {
    const t0 = performance.now();

    // 1. Finder detection / tracking
    const finderRes = findCorners(rgba, width, height, {
      prevCorners: this.prevCorners
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
    this.prevCorners = [corners.TL, corners.TR, corners.BL, corners.BR];
    this.lockCount++;

    // 2. Solve Homography
    const H = solveHomography([corners.TL, corners.TR, corners.BL, corners.BR]);
    if (!H) {
      this._resetAccum();
      return {
        ok: false,
        error: 'HOMOGRAPHY_SINGULAR',
        corners,
        stats: { totalMs: performance.now() - t0 }
      };
    }

    // 3. Timing track refinement & lens distortion compensation
    const timingRefiner = new TimingRefiner(rgba, width, height, H, [
      corners.TL,
      corners.TR,
      corners.BL,
      corners.BR
    ]);

    // 4. Pilot calibration with timing offset
    const pilotCalibrator = new PilotCalibrator(rgba, width, height, H, timingRefiner);

    // 5. Sample and decode each of the 4 stripes
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
        st.accumSymbols = new Uint8Array(count);
        st.accumMargins = new Float32Array(count);
        st.hasPrev = false;
        st.count = 0;
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
        st.curThresh
      );

      if (!sampleRes.ok) {
        st.count = 0;
        st.hasPrev = false;
        stripes[s] = { stripeIdx: s, ok: false, error: 'SAMPLE_OUT_OF_BOUNDS' };
        continue;
      }

      // Convert 1446 symbols into 542 packet bytes
      const symbols1446 = sampleRes.symbols.subarray(0, 1446);
      const packetBytes = symbolsToBytes(symbols1446, PACKET_TOTAL_BYTES);
      const byteMargins = sampleRes.margins
        ? symbolsMarginsToByteMargins(sampleRes.margins.subarray(0, 1446), PACKET_TOTAL_BYTES)
        : null;

      // Parse packet with RS decode + CRC32
      let packetRes = parsePacket(packetBytes, s, byteMargins);

      let mad = 0;
      if (st.hasPrev) {
        let diff = 0;
        const len = st.curRgb.length;
        for (let k = 0; k < len; k++) {
          diff += Math.abs(st.curRgb[k] - st.prevRgb[k]);
        }
        mad = diff / len;
      }

      if (packetRes.ok) {
        if (!st.hasPrev || mad > 18) {
          st.count = 1;
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
      } else {
        if (!st.hasPrev || mad > 18) {
          st.count = 1;
          st.sumRgb.set(st.curRgb);
          st.sumThresh.set(st.curThresh);
        } else {
          st.count++;
          const len = st.curRgb.length;
          for (let k = 0; k < len; k++) {
            st.sumRgb[k] += st.curRgb[k];
            st.sumThresh[k] += st.curThresh[k];
          }

          const inv = 1.0 / st.count;
          for (let i = 0; i < count; i++) {
            const i3 = i * 3;
            const rAvg = st.sumRgb[i3] * inv;
            const gAvg = st.sumRgb[i3 + 1] * inv;
            const bAvg = st.sumRgb[i3 + 2] * inv;
            const Tr = st.sumThresh[i3] * inv;
            const Tg = st.sumThresh[i3 + 1] * inv;
            const Tb = st.sumThresh[i3 + 2] * inv;

            const bR = rAvg >= Tr ? 1 : 0;
            const tgEff = Tg + (bR === 1 ? 10 : -5);
            const bG = gAvg >= tgEff ? 1 : 0;
            const tbEff = Tb + ((bR === 1 && bG === 1) ? 20 : -6);
            const bB = bAvg >= tbEff ? 1 : 0;

            st.accumSymbols[i] = (bR << 2) | (bG << 1) | bB;
            st.accumMargins[i] = Math.min(Math.abs(rAvg - Tr), Math.abs(gAvg - tgEff), Math.abs(bAvg - tbEff));
          }

          const accSym1446 = st.accumSymbols.subarray(0, 1446);
          const accPkt = symbolsToBytes(accSym1446, PACKET_TOTAL_BYTES);
          const accMargins = symbolsMarginsToByteMargins(st.accumMargins.subarray(0, 1446), PACKET_TOTAL_BYTES);

          packetRes = parsePacket(accPkt, s, accMargins);
        }
      }

      st.prevRgb.set(st.curRgb);
      st.hasPrev = true;

      if (packetRes.ok) {
        validStripesCount++;
        stripes[s] = {
          stripeIdx: s,
          ok: true,
          header: packetRes.header,
          payloadU32: packetRes.payloadU32,
          corrected: packetRes.corrected
        };
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
      corners,
      stripes,
      stats: {
        totalMs,
        validStripesCount,
        lockCount: this.lockCount
      }
    };
  }
}
