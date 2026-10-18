/**
 * Camera simulation: Rolling shutter timing model.
 */

export class ShutterTiming {
  /**
   * @param {object} options
   * @param {number} [options.fps=30]
   * @param {number} [options.readoutMs=20]
   * @param {number} [options.exposureMs=16]
   * @param {number} [options.refreshHz=60]
   * @param {number} [options.txHold=4]
   */
  constructor(options = {}) {
    this.fps = options.fps ?? 30;
    this.readoutMs = options.readoutMs !== undefined ? options.readoutMs : 20;
    this.exposureMs = options.exposureMs !== undefined ? options.exposureMs : 16;
    this.refreshHz = options.refreshHz ?? 60;
    this.txHold = options.txHold ?? 4;

    this.tHoldMs = (this.txHold / this.refreshHz) * 1000; // ms per TX frame
  }

  /**
   * Calculates exposure interval for camera row y.
   *
   * @param {number} tC - Capture timestamp (ms)
   * @param {number} y - Camera row index [0, H-1]
   * @param {number} H - Total camera height
   * @returns {{ tStart: number, tEnd: number }}
   */
  getRowExposure(tC, y, H) {
    const rowOffset = (y / Math.max(1, H - 1)) * this.readoutMs;
    const tStart = tC + rowOffset;
    return { tStart, tEnd: tStart + this.exposureMs };
  }

  /**
   * Computes the TX frames visible to row y during its exposure window and their weights.
   *
   * @param {number} tC
   * @param {number} y
   * @param {number} H
   * @returns {Array<{ frameIdx: number, weight: number }>}
   */
  getTxFrameBlend(tC, y, H) {
    const { tStart, tEnd } = this.getRowExposure(tC, y, H);
    const startFrame = Math.floor(tStart / this.tHoldMs);
    const endFrame = Math.floor(tEnd / this.tHoldMs);

    if (startFrame === endFrame) {
      return [{ frameIdx: startFrame, weight: 1.0 }];
    }

    const blend = [];
    const totalExp = tEnd - tStart;

    for (let f = startFrame; f <= endFrame; f++) {
      const fStart = f * this.tHoldMs;
      const fEnd = (f + 1) * this.tHoldMs;

      const overlapStart = Math.max(tStart, fStart);
      const overlapEnd = Math.min(tEnd, fEnd);
      const duration = Math.max(0, overlapEnd - overlapStart);

      if (duration > 0) {
        blend.push({ frameIdx: f, weight: duration / totalExp });
      }
    }

    return blend;
  }
}
