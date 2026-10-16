import { test, assert } from '../harness.js';
import { rsEncode, rsDecode, rsSyndromes } from '../../src/core/reedsolomon.js';
import { PRNG } from '../../src/core/prng.js';

test('reedsolomon: systematic encode produces zero syndromes', () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const parity = rsEncode(data, 4);
  const codeword = new Uint8Array([...data, ...parity]);

  const syndromes = rsSyndromes(codeword, 4);
  assert.strictEqual(syndromes, null, 'Clean codeword should have zero syndromes');
});

test('reedsolomon: corrects up to t errors for nsym=28 (t=14)', () => {
  const rng = new PRNG(1337);
  const k = 154;
  const nsym = 28;
  const t = 14;

  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = rng.nextBelow(256);

  const parity = rsEncode(data, nsym);
  const cleanCodeword = new Uint8Array(k + nsym);
  cleanCodeword.set(data, 0);
  cleanCodeword.set(parity, k);

  for (let errors = 1; errors <= t; errors++) {
    const corrupted = new Uint8Array(cleanCodeword);
    const chosenPositions = new Set();
    while (chosenPositions.size < errors) {
      chosenPositions.add(rng.nextBelow(corrupted.length));
    }

    for (const pos of chosenPositions) {
      const flip = rng.nextBelow(255) + 1;
      corrupted[pos] ^= flip;
    }

    const res = rsDecode(corrupted, nsym);
    assert.strictEqual(res.ok, true, `Failed to correct ${errors} errors`);
    assert.strictEqual(res.corrected, errors);
    assert.deepStrictEqual(res.codeword, cleanCodeword);
  }
});

test('reedsolomon: corrects up to t=13 errors for nsym=27', () => {
  const rng = new PRNG(2024);
  const k = 153;
  const nsym = 27;
  const t = 13;

  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = rng.nextBelow(256);

  const parity = rsEncode(data, nsym);
  const cleanCodeword = new Uint8Array(k + nsym);
  cleanCodeword.set(data, 0);
  cleanCodeword.set(parity, k);

  for (let errors = 1; errors <= t; errors++) {
    const corrupted = new Uint8Array(cleanCodeword);
    const chosenPositions = new Set();
    while (chosenPositions.size < errors) {
      chosenPositions.add(rng.nextBelow(corrupted.length));
    }

    for (const pos of chosenPositions) {
      const flip = rng.nextBelow(255) + 1;
      corrupted[pos] ^= flip;
    }

    const res = rsDecode(corrupted, nsym);
    assert.strictEqual(res.ok, true, `Failed to correct ${errors} errors`);
    assert.strictEqual(res.corrected, errors);
    assert.deepStrictEqual(res.codeword, cleanCodeword);
  }
});
