import { test, assert } from '../harness.js';
import { PilotCalibrator } from '../../src/vision/pilots.js';
import { renderFrame } from '../../src/frame/renderer.js';
import { solveHomography } from '../../src/vision/homography.js';

test('pilots: computes consistent thresholds on clean frame', () => {
  const dummyPackets = [
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542)
  ];
  const { width, height, rgba } = renderFrame(dummyPackets, { scale: 1 });

  const canonicalCorners = [
    { x: 3.5 * 10, y: 3.5 * 10 },
    { x: 76.5 * 10, y: 3.5 * 10 },
    { x: 3.5 * 10, y: 76.5 * 10 },
    { x: 76.5 * 10, y: 76.5 * 10 }
  ];
  const H = solveHomography(canonicalCorners);
  const calibrator = new PilotCalibrator(rgba, width, height, H);

  // In clean rendering, high is 255 and low is 40, so midpoint threshold is (255 + 40)/2 = 147.5
  for (let u = 10; u < 70; u += 15) {
    for (let v = 10; v < 70; v += 15) {
      const { Tr, Tg, Tb } = calibrator.getThresholds(u, v);
      assert.ok(Tr >= 140 && Tr <= 155, `Tr was ${Tr}`);
      assert.ok(Tg >= 140 && Tg <= 155, `Tg was ${Tg}`);
      assert.ok(Tb >= 140 && Tb <= 155, `Tb was ${Tb}`);
    }
  }
});
