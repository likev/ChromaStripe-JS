import { test, assert } from '../harness.js';
import { gfMul, gfDiv, gfInv, gfAdd, EXP, LOG } from '../../src/core/gf256.js';

test('gf256: field axioms', () => {
  // Identity and zero
  for (let i = 0; i < 256; i++) {
    assert.strictEqual(gfMul(i, 0), 0);
    assert.strictEqual(gfMul(0, i), 0);
    assert.strictEqual(gfMul(i, 1), i);
    assert.strictEqual(gfMul(1, i), i);
    assert.strictEqual(gfAdd(i, 0), i);
    assert.strictEqual(gfAdd(i, i), 0);
  }

  // Inverses
  for (let i = 1; i < 256; i++) {
    const inv = gfInv(i);
    assert.strictEqual(gfMul(i, inv), 1);
    assert.strictEqual(gfDiv(i, i), 1);
  }

  // Associativity and distributivity sampling
  for (let i = 1; i < 20; i++) {
    for (let j = 1; j < 20; j++) {
      const k = (i * j + 7) % 255 + 1;
      // a * (b + c) == a * b + a * c
      const left = gfMul(i, gfAdd(j, k));
      const right = gfAdd(gfMul(i, j), gfMul(i, k));
      assert.strictEqual(left, right);
    }
  }
});
