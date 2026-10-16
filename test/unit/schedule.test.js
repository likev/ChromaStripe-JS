import { test, assert } from '../harness.js';
import { getDropletIndices, permuteBlock, getDropletPhase } from '../../src/fountain/schedule.js';

test('schedule: phase 1 permutation is bijective for all K', () => {
  for (const K of [1, 2, 3, 7, 10, 64, 100, 257]) {
    const seen = new Set();
    for (let seed = 0; seed < K; seed++) {
      const block = permuteBlock(seed, K);
      assert.ok(block >= 0 && block < K);
      seen.add(block);
    }
    assert.strictEqual(seen.size, K, `Permutation not bijective for K=${K}`);
  }
});

test('schedule: phase boundaries and degree clamping', () => {
  const K = 20;
  // Systematic
  for (let s = 0; s < K; s++) {
    assert.strictEqual(getDropletPhase(s, K), 0);
    const indices = getDropletIndices(s, K);
    assert.strictEqual(indices.length, 1);
  }

  // Parity (alpha = 0.15 => ceil(3) = 3 parity blocks)
  for (let s = K; s < K + 3; s++) {
    assert.strictEqual(getDropletPhase(s, K), 1);
    const indices = getDropletIndices(s, K);
    assert.ok(indices.length >= 1 && indices.length <= 3);
  }

  // Fountain
  for (let s = K + 3; s < K + 20; s++) {
    assert.strictEqual(getDropletPhase(s, K), 2);
    const indices = getDropletIndices(s, K);
    assert.ok(indices.length >= 1 && indices.length <= K);
    // Indices must be distinct
    const set = new Set(indices);
    assert.strictEqual(set.size, indices.length);
  }
});
