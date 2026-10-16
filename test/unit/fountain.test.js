import { test, assert } from '../harness.js';
import { encodeDroplet } from '../../src/fountain/encoder.js';
import { FountainDecoder } from '../../src/fountain/decoder.js';
import { PRNG } from '../../src/core/prng.js';

test('fountain: encode and decode with sequential droplets', () => {
  for (const K of [1, 2, 5, 20]) {
    const rng = new PRNG(K);
    const sourceBlocks = new Array(K);
    for (let i = 0; i < K; i++) {
      sourceBlocks[i] = new Uint32Array(112);
      for (let w = 0; w < 112; w++) sourceBlocks[i][w] = rng.nextU32();
    }

    const decoder = new FountainDecoder(K);
    let seed = 0;
    while (!decoder.isComplete()) {
      const droplet = encodeDroplet(seed, sourceBlocks);
      decoder.addDroplet(seed, droplet);
      seed++;
      if (seed > K * 3) {
        throw new Error(`Failed to decode K=${K} within 3x droplets`);
      }
    }

    assert.strictEqual(decoder.isComplete(), true);
    for (let i = 0; i < K; i++) {
      assert.deepStrictEqual(decoder.solved[i], sourceBlocks[i]);
    }
  }
});

test('fountain: out-of-order and 30% loss recovery with GE', () => {
  const K = 30;
  const rng = new PRNG(999);
  const sourceBlocks = new Array(K);
  for (let i = 0; i < K; i++) {
    sourceBlocks[i] = new Uint32Array(112);
    for (let w = 0; w < 112; w++) sourceBlocks[i][w] = rng.nextU32();
  }

  const decoder = new FountainDecoder(K);
  let seed = 0;
  const receivedSeeds = [];

  // Generate sequence of seeds, dropping 30%
  while (!decoder.isComplete() && seed < 300) {
    if (rng.nextFloat() >= 0.30) {
      const droplet = encodeDroplet(seed, sourceBlocks);
      decoder.addDroplet(seed, droplet);
      receivedSeeds.push(seed);
    }
    seed++;
  }

  assert.strictEqual(decoder.isComplete(), true, `Decoder did not complete: solved ${decoder.solvedCount}/${K}`);
  for (let i = 0; i < K; i++) {
    assert.deepStrictEqual(decoder.solved[i], sourceBlocks[i]);
  }
});
