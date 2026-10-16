/**
 * Camera simulation: Sensor noise (shot + read) and quantization to RGBA8.
 */

import { toSRGB } from './display.js';
import { PRNG } from '../../src/core/prng.js';

export function applySensorNoiseAndQuantize(buf, w, h, options = {}) {
  const readNoise = (options.readNoise ?? 1.5) / 255.0;
  const shotNoise = options.shotNoise ?? 0.01;
  const rng = new PRNG(options.seed || 999);

  const totalPixels = w * h;
  const outRgba = new Uint8ClampedArray(totalPixels * 4);

  // Box-Muller normal distribution generator
  let haveSpare = false;
  let spare = 0;
  const randNormal = () => {
    if (haveSpare) {
      haveSpare = false;
      return spare;
    }
    const u = Math.max(1e-12, rng.nextFloat());
    const v = rng.nextFloat();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2.0 * Math.PI * v);
    haveSpare = true;
    return mag * Math.cos(2.0 * Math.PI * v);
  };

  for (let i = 0; i < totalPixels; i++) {
    const srcIdx = i * 3;
    const dstIdx = i * 4;

    for (let c = 0; c < 3; c++) {
      const signal = buf[srcIdx + c];
      // Shot noise proportional to sqrt(signal) + read noise
      const sigma = Math.sqrt(signal * shotNoise + readNoise * readNoise);
      const noisy = signal + randNormal() * sigma;
      outRgba[dstIdx + c] = toSRGB(noisy);
    }
    outRgba[dstIdx + 3] = 255; // Alpha
  }

  return outRgba;
}
