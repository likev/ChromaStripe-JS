import { test, assert } from '../harness.js';
import { xorshift32, seedMix, nextBelow, PRNG } from '../../src/core/prng.js';

test('prng: xorshift32 never returns 0 even with 0 input', () => {
  const s0 = xorshift32(0);
  assert.ok(s0 !== 0);

  let state = 12345678;
  for (let i = 0; i < 1000; i++) {
    state = xorshift32(state);
    assert.ok(state !== 0, `state became 0 at iteration ${i}`);
  }
});

test('prng: seedMix produces non-zero distinct outputs for close seeds', () => {
  const m1 = seedMix(1);
  const m2 = seedMix(2);
  const m0 = seedMix(0);
  assert.ok(m1 !== 0);
  assert.ok(m2 !== 0);
  assert.ok(m0 !== 0);
  assert.ok(m1 !== m2);
});

test('prng: nextBelow produces numbers strictly in [0, n - 1]', () => {
  const rng = new PRNG(42);
  const counts = new Uint32Array(5);
  for (let i = 0; i < 5000; i++) {
    const val = rng.nextBelow(5);
    assert.ok(val >= 0 && val < 5);
    counts[val]++;
  }
  for (let i = 0; i < 5; i++) {
    assert.ok(counts[i] > 800, `Bucket ${i} was too low: ${counts[i]}`);
  }
});
