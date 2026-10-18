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

test('reedsolomon: corrects pure erasures up to e=nsym', () => {
  const rng = new PRNG(9999);
  const k = 154;
  const nsym = 28;

  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = rng.nextBelow(256);

  const parity = rsEncode(data, nsym);
  const cleanCodeword = new Uint8Array(k + nsym);
  cleanCodeword.set(data, 0);
  cleanCodeword.set(parity, k);

  const corrupted = new Uint8Array(cleanCodeword);
  const erasurePositions = [];
  while (erasurePositions.length < nsym) {
    const pos = rng.nextBelow(corrupted.length);
    if (!erasurePositions.includes(pos)) {
      erasurePositions.push(pos);
      corrupted[pos] ^= rng.nextBelow(255) + 1;
    }
  }

  const res = rsDecode(corrupted, nsym, false, erasurePositions);
  assert.strictEqual(res.ok, true, 'Failed to correct 28 erasures');
  assert.strictEqual(res.corrected, nsym);
  assert.deepStrictEqual(res.codeword, cleanCodeword);
});

test('reedsolomon: corrects mixed errors and erasures (2t + e <= nsym)', () => {
  const rng = new PRNG(777);
  const k = 154;
  const nsym = 28;

  const data = new Uint8Array(k);
  for (let i = 0; i < k; i++) data[i] = rng.nextBelow(256);

  const parity = rsEncode(data, nsym);
  const cleanCodeword = new Uint8Array(k + nsym);
  cleanCodeword.set(data, 0);
  cleanCodeword.set(parity, k);

  // 8 erasures + 8 errors = 16 corruptions (2*8 + 8 = 24 <= 28)
  const corrupted = new Uint8Array(cleanCodeword);
  const erasures = [10, 20, 30, 40, 50, 60, 70, 80];
  const errors = [5, 15, 25, 35, 45, 55, 65, 75];

  for (const pos of erasures) corrupted[pos] ^= 0x3A;
  for (const pos of errors) corrupted[pos] ^= 0x9F;

  // Standard RS decode without erasures must fail (16 > 14)
  const failedStandard = rsDecode(corrupted, nsym);
  assert.strictEqual(failedStandard.ok, false);

  // With erasures, decode succeeds and corrects all 16 corruptions
  const res = rsDecode(corrupted, nsym, false, erasures);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.corrected, 16);
  assert.deepStrictEqual(res.codeword, cleanCodeword);
});
