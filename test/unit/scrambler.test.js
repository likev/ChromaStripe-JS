import { test, assert } from '../harness.js';
import { scramblePacket, getFillSymbols } from '../../src/frame/scrambler.js';

test('scrambler: is an involution', () => {
  const original = new Uint8Array(542);
  for (let i = 0; i < 542; i++) original[i] = (i * 17) & 0xFF;

  for (let stripeIdx = 0; stripeIdx < 4; stripeIdx++) {
    const copy = new Uint8Array(original);
    scramblePacket(copy, stripeIdx);
    // Should be different from original
    let diff = 0;
    for (let i = 0; i < 542; i++) {
      if (copy[i] !== original[i]) diff++;
    }
    assert.ok(diff > 500, 'Scrambled buffer did not change enough bytes');

    // Second scramble returns to original
    scramblePacket(copy, stripeIdx);
    assert.deepStrictEqual(copy, original);
  }
});

test('scrambler: fill symbols are in 0..7 and deterministic', () => {
  const f1 = getFillSymbols(1, 20);
  const f2 = getFillSymbols(1, 20);
  assert.strictEqual(f1.length, 20);
  assert.deepStrictEqual(f1, f2);

  for (let i = 0; i < 20; i++) {
    assert.ok(f1[i] >= 0 && f1[i] <= 7);
  }
});
