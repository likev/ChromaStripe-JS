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
import { symbolsToBytes } from '../core/bitpack.js';
import { parsePacket } from '../frame/packet.js';
import { PACKET_TOTAL_BYTES } from '../frame/constants.js';

export class FrameDecoder {
  constructor() {
    this.layout = getLayout();
    this.prevCorners = null;
    this.lockCount = 0;
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
      const sampleRes = sampleStripeCells(
        rgba,
        width,
        height,
        H,
        timingRefiner,
        pilotCalibrator,
        dataCells
      );

      if (!sampleRes.ok) {
        stripes[s] = { stripeIdx: s, ok: false, error: 'SAMPLE_OUT_OF_BOUNDS' };
        continue;
      }

      // Convert 1446 symbols into 542 packet bytes
      const symbols1446 = sampleRes.symbols.subarray(0, 1446);
      const packetBytes = symbolsToBytes(symbols1446, PACKET_TOTAL_BYTES);

      // Parse packet with RS decode + CRC32
      const packetRes = parsePacket(packetBytes, s);

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
