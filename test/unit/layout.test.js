import { test, assert } from '../harness.js';
import { getLayout, rotateCoords } from '../../src/frame/layout.js';
import { CELL_TYPE, TOTAL_CELLS } from '../../src/frame/constants.js';

test('layout: verifies cell counts and non-overlapping classifications', () => {
  const layout = getLayout();
  assert.strictEqual(layout.cellClass.length, TOTAL_CELLS);

  let finders = 0, timing = 0, pilots = 0, data = 0;
  for (let i = 0; i < TOTAL_CELLS; i++) {
    const c = layout.cellClass[i];
    if (c === CELL_TYPE.FINDER) finders++;
    else if (c === CELL_TYPE.TIMING) timing++;
    else if (c === CELL_TYPE.PILOT) pilots++;
    else if (c === CELL_TYPE.DATA) data++;
  }

  assert.strictEqual(finders, 256, 'Expected 4 * 64 finder cells');
  assert.strictEqual(timing, 256, 'Expected 4 * 64 timing cells');
  assert.strictEqual(pilots, 64, 'Expected 16 * 4 pilot cells');
  assert.strictEqual(data, 5824, 'Expected 5824 data cells');
  assert.strictEqual(finders + timing + pilots + data, TOTAL_CELLS);
});

test('layout: stripe capacities reproduce [1446, 1466, 1466, 1446]', () => {
  const layout = getLayout();
  assert.strictEqual(layout.stripeDataCells[0].length, 1446);
  assert.strictEqual(layout.stripeDataCells[1].length, 1466);
  assert.strictEqual(layout.stripeDataCells[2].length, 1466);
  assert.strictEqual(layout.stripeDataCells[3].length, 1446);
});

test('layout: 90-degree rotation is a bijection', () => {
  const seen = new Set();
  for (let v = 0; v < 80; v++) {
    for (let u = 0; u < 80; u++) {
      const { u: ru, v: rv } = rotateCoords(u, v, 90);
      assert.ok(ru >= 0 && ru < 80);
      assert.ok(rv >= 0 && rv < 80);
      seen.add(rv * 80 + ru);
    }
  }
  assert.strictEqual(seen.size, 6400);
});
