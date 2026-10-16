import { test, assert } from '../harness.js';
import { bytesToSymbols, symbolsToBytes } from '../../src/core/bitpack.js';

test('bitpack: round trip for various lengths', () => {
  for (const len of [1, 2, 3, 4, 10, 542]) {
    const original = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      original[i] = (i * 37 + 13) & 0xFF;
    }

    const symbols = bytesToSymbols(original);
    const expectedSymbols = Math.ceil(len * 8 / 3);
    assert.strictEqual(symbols.length, expectedSymbols);

    // All symbols in 0..7
    for (let i = 0; i < symbols.length; i++) {
      assert.ok(symbols[i] >= 0 && symbols[i] <= 7);
    }

    const recovered = symbolsToBytes(symbols, len);
    assert.deepStrictEqual(recovered, original);
  }
});

test('bitpack: 542 bytes packs to 1446 cells exactly', () => {
  const bytes = new Uint8Array(542);
  const symbols = bytesToSymbols(bytes, 1446);
  assert.strictEqual(symbols.length, 1446);

  const recovered = symbolsToBytes(symbols, 542);
  assert.strictEqual(recovered.length, 542);
});
