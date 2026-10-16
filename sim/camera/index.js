/**
 * Synthetic camera pipeline orchestrator (Level 2).
 */

import { ShutterTiming } from './timing.js';
import { CameraGeometry } from './geometry.js';
import { toLinear } from './display.js';
import { applyPSF } from './optics.js';
import { applyLighting } from './lighting.js';
import { applyColorTransform } from './color.js';
import { applySensorNoiseAndQuantize } from './sensor.js';
import { applyChroma420, applyDCT } from './codec.js';
import { renderBackground } from './background.js';

export class SyntheticCamera {
  /**
   * @param {object} scenario - Scenario configuration object
   */
  constructor(scenario = {}) {
    this.scenario = scenario;
    this.camW = scenario.camera?.width || 1280;
    this.camH = scenario.camera?.height || 720;
    this.fps = scenario.camera?.fps || 30;

    this.timing = new ShutterTiming({
      fps: this.fps,
      readoutMs: scenario.camera?.readoutMs ?? 20,
      exposureMs: Array.isArray(scenario.camera?.exposureMs) ? scenario.camera.exposureMs[0] : (scenario.camera?.exposureMs ?? 16),
      refreshHz: scenario.display?.refreshHz ?? 60,
      txHold: scenario.display?.txHold ?? 4
    });

    this.geometry = new CameraGeometry({
      camW: this.camW,
      camH: this.camH,
      codeHeightFrac: Array.isArray(scenario.geometry?.codeHeightFrac) ? scenario.geometry.codeHeightFrac[0] : (scenario.geometry?.codeHeightFrac ?? 0.75),
      yawDeg: Array.isArray(scenario.geometry?.yawDeg) ? scenario.geometry.yawDeg[0] : (scenario.geometry?.yawDeg ?? 0),
      pitchDeg: Array.isArray(scenario.geometry?.pitchDeg) ? scenario.geometry.pitchDeg[0] : (scenario.geometry?.pitchDeg ?? 0),
      rollDeg: Array.isArray(scenario.geometry?.rollDeg) ? scenario.geometry.rollDeg[0] : (scenario.geometry?.rollDeg ?? 0),
      k1: Array.isArray(scenario.geometry?.k1) ? scenario.geometry.k1[0] : (scenario.geometry?.k1 ?? 0),
      k2: Array.isArray(scenario.geometry?.k2) ? scenario.geometry.k2[0] : (scenario.geometry?.k2 ?? 0),
      shakeX: scenario.geometry?.shakeX ?? 0,
      shakeY: scenario.geometry?.shakeY ?? 0
    });
  }

  /**
   * Captures a single synthetic camera frame at timestamp tC.
   *
   * @param {number} tC - Capture time (ms)
   * @param {Map<number, { width: number, height: number, rgba: Uint8ClampedArray }>} txFrames - Map of frameNo -> rendered TX frame
   * @returns {{
   *   width: number,
   *   height: number,
   *   rgba: Uint8ClampedArray,
   *   truth: object
   * }}
   */
  captureFrame(tC, txFrames) {
    const w = this.camW;
    const h = this.camH;

    // 1. Initialize background
    const bg = renderBackground(w, h, this.scenario.background?.distractors ?? 2);
    const linearBuf = new Float32Array(bg);

    const tearRows = [];
    let prevFrames = null;

    // 2. Project screen pixels into camera plane
    for (let y = 0; y < h; y++) {
      const blend = this.timing.getTxFrameBlend(tC, y, h);

      // Track rolling-shutter tear rows
      const frameKey = blend.map(b => `${b.frameIdx}:${b.weight.toFixed(2)}`).join(',');
      if (prevFrames !== null && prevFrames !== frameKey) {
        tearRows.push(y);
      }
      prevFrames = frameKey;

      const rowOffset = y * w * 3;

      for (let x = 0; x < w; x++) {
        const { u, v } = this.geometry.unproject(x, y);

        // Check if inside screen grid [0, 80)
        if (u >= 0 && u < 80 && v >= 0 && v < 80) {
          let rLin = 0, gLin = 0, bLin = 0;

          // Time-weighted exposure blend across TX frames
          for (let b = 0; b < blend.length; b++) {
            const { frameIdx, weight } = blend[b];
            const txFrame = txFrames.get(frameIdx);

            if (txFrame) {
              const txW = txFrame.width;
              const txH = txFrame.height;
              const txPx = Math.max(0, Math.min(txW - 1, Math.floor((u / 80.0) * txW)));
              const txPy = Math.max(0, Math.min(txH - 1, Math.floor((v / 80.0) * txH)));
              const txOffset = (txPy * txW + txPx) * 4;

              rLin += toLinear(txFrame.rgba[txOffset]) * weight;
              gLin += toLinear(txFrame.rgba[txOffset + 1]) * weight;
              bLin += toLinear(txFrame.rgba[txOffset + 2]) * weight;
            }
          }

          const outIdx = rowOffset + x * 3;
          linearBuf[outIdx] = rLin;
          linearBuf[outIdx + 1] = gLin;
          linearBuf[outIdx + 2] = bLin;
        }
      }
    }

    // 3. Optics (Gaussian PSF blur)
    const psfSigma = Array.isArray(this.scenario.optics?.psfSigma)
      ? this.scenario.optics.psfSigma[0]
      : (this.scenario.optics?.psfSigma ?? 0.8);
    const blurredBuf = applyPSF(linearBuf, w, h, psfSigma);

    // 4. Lighting (glare, gradient, vignetting)
    const litBuf = applyLighting(blurredBuf, w, h, {
      glare: this.scenario.lighting?.glare ? {
        x: w * 0.7,
        y: h * 0.3,
        radius: (this.scenario.lighting.glare.radiusFrac?.[0] ?? 0.2) * h,
        intensity: this.scenario.lighting.glare.intensity?.[0] ?? 0.3
      } : null,
      gradient: this.scenario.lighting?.gradient?.[0] ?? 0.1,
      vignette: this.scenario.lighting?.vignette ?? 0.2,
      ambient: this.scenario.lighting?.ambient?.[0] ?? 0.02
    });

    // 5. Color transform (crosstalk, AWB, saturation, black level)
    const coloredBuf = applyColorTransform(litBuf, w, h, {
      crosstalkDiag: this.scenario.color?.crosstalkDiag?.[0] ?? 0.90,
      awbGains: this.scenario.color?.awbGain ? [this.scenario.color.awbGain[0], 1.0, 1.05] : [1.0, 1.0, 1.0],
      saturation: this.scenario.color?.saturation?.[0] ?? 1.0,
      blackLevel: this.scenario.color?.blackLevel ?? 4
    });

    // 6. Sensor noise and quantization to sRGB RGBA8
    let rgba8 = applySensorNoiseAndQuantize(coloredBuf, w, h, {
      readNoise: this.scenario.sensor?.readNoise?.[0] ?? 1.5,
      shotNoise: this.scenario.sensor?.shot ?? 0.015,
      seed: Math.floor(tC) & 0x7FFFFFFF
    });

    // 7. BT.601 4:2:0 chroma subsampling
    if (this.scenario.sensor?.chroma420 !== false) {
      rgba8 = applyChroma420(rgba8, w, h);
    }

    // 8. 8x8 block DCT quantization (if configured)
    if (this.scenario.sensor?.dctQuality) {
      rgba8 = applyDCT(rgba8, w, h, this.scenario.sensor.dctQuality);
    }

    const corners = this.geometry.getGroundTruthCorners();

    return {
      width: w,
      height: h,
      rgba: rgba8,
      truth: {
        tC,
        corners,
        H: this.geometry.H,
        tearRows
      }
    };
  }
}
