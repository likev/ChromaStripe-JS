import { test, assert } from '../harness.js';
import { sha256Sync, digestSha256, toHex } from '../../src/core/sha256.js';

test('sha256: matches known standard test vectors', async () => {
  // Empty string
  const empty = new Uint8Array(0);
  const hEmpty = toHex(sha256Sync(empty));
  assert.strictEqual(hEmpty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // "abc"
  const abc = new TextEncoder().encode('abc');
  const hAbc = toHex(sha256Sync(abc));
  assert.strictEqual(hAbc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // Async version
  const hAsync = toHex(await digestSha256(abc));
  assert.strictEqual(hAsync, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
