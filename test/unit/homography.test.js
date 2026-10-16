import { test, assert } from '../harness.js';
import { solveHomography, projectH } from '../../src/vision/homography.js';

test('homography: accurately solves affine translation and scale', () => {
  // Canonical: [(3.5, 3.5), (76.5, 3.5), (3.5, 76.5), (76.5, 76.5)]
  // Destination: scale by 10, translate by (100, 50)
  const corners = [
    { x: 3.5 * 10 + 100, y: 3.5 * 10 + 50 },
    { x: 76.5 * 10 + 100, y: 3.5 * 10 + 50 },
    { x: 3.5 * 10 + 100, y: 76.5 * 10 + 50 },
    { x: 76.5 * 10 + 100, y: 76.5 * 10 + 50 }
  ];

  const H = solveHomography(corners);
  assert.ok(H !== null);

  for (let i = 0; i < 4; i++) {
    const srcU = [3.5, 76.5, 3.5, 76.5][i];
    const srcV = [3.5, 3.5, 76.5, 76.5][i];
    const p = projectH(H, srcU, srcV);

    assert.ok(Math.abs(p.x - corners[i].x) < 1e-4);
    assert.ok(Math.abs(p.y - corners[i].y) < 1e-4);
  }
});

test('homography: accurately solves perspective tilt', () => {
  const corners = [
    { x: 120, y: 100 },
    { x: 680, y: 130 },
    { x: 80, y: 650 },
    { x: 720, y: 690 }
  ];

  const H = solveHomography(corners);
  assert.ok(H !== null);

  for (let i = 0; i < 4; i++) {
    const srcU = [3.5, 76.5, 3.5, 76.5][i];
    const srcV = [3.5, 3.5, 76.5, 76.5][i];
    const p = projectH(H, srcU, srcV);

    assert.ok(Math.abs(p.x - corners[i].x) < 1e-3, `X reprojection error at corner ${i}`);
    assert.ok(Math.abs(p.y - corners[i].y) < 1e-3, `Y reprojection error at corner ${i}`);
  }
});
