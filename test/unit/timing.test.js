import { test, assert } from '../harness.js';
import { TimingRefiner } from '../../src/vision/timing.js';
import { renderFrame } from '../../src/frame/renderer.js';
import { solveHomography } from '../../src/vision/homography.js';

test('timing: computes bounded residuals on rendered frame', () => {
  const dummyPackets = [
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542)
  ];
  const { width, height, rgba } = renderFrame(dummyPackets, { scale: 1 });

  const corners = [
    { x: 35, y: 35 },
    { x: 765, y: 35 },
    { x: 35, y: 765 },
    { x: 765, y: 765 }
  ];
  const H = solveHomography(corners);
  const refiner = new TimingRefiner(rgba, width, height, H);

  for (let v = 0; v < 80; v += 10) {
    for (let u = 0; u < 80; u += 10) {
      const { du, dv } = refiner.getOffset(u, v);
      assert.ok(Math.abs(du) <= 0.4, `du ${du} exceeded bound`);
      assert.ok(Math.abs(dv) <= 0.4, `dv ${dv} exceeded bound`);
    }
  }
});
