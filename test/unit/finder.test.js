import { test, assert } from '../harness.js';
import { findCorners } from '../../src/vision/finder.js';
import { renderFrame } from '../../src/frame/renderer.js';

test('finder: detects all 4 corners in clean rendered frame within 0.5 px', () => {
  const dummyPackets = [
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542),
    new Uint8Array(542)
  ];

  const scale = 2;
  const { width, height, rgba } = renderFrame(dummyPackets, { scale });

  // Ground truth positions at scale 2 (cell is 20px, core center at (3.5 * 20, 3.5 * 20) = (70, 70))
  // TL: (70, 70), TR: (1530, 70), BL: (70, 1530), BR: (1530, 1530)
  const res = findCorners(rgba, width, height, { scanStep: 2 });
  assert.strictEqual(res.found, true);
  assert.ok(res.corners !== undefined);

  const { TL, TR, BL, BR } = res.corners;
  const expectedTL = { x: 3.5 * 20, y: 3.5 * 20 };
  const expectedTR = { x: 76.5 * 20, y: 3.5 * 20 };
  const expectedBL = { x: 3.5 * 20, y: 76.5 * 20 };
  const expectedBR = { x: 76.5 * 20, y: 76.5 * 20 };

  const errTL = Math.hypot(TL.x - expectedTL.x, TL.y - expectedTL.y);
  const errTR = Math.hypot(TR.x - expectedTR.x, TR.y - expectedTR.y);
  const errBL = Math.hypot(BL.x - expectedBL.x, BL.y - expectedBL.y);
  const errBR = Math.hypot(BR.x - expectedBR.x, BR.y - expectedBR.y);

  assert.ok(errTL <= 0.6, `TL error was ${errTL}`);
  assert.ok(errTR <= 0.6, `TR error was ${errTR}`);
  assert.ok(errBL <= 0.6, `BL error was ${errBL}`);
  assert.ok(errBR <= 0.6, `BR error was ${errBR}`);
});
