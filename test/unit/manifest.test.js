import { test, assert } from '../harness.js';
import { encodeManifest, decodeManifest } from '../../src/session/manifest.js';

test('manifest: encode and decode round-trip with unicode', () => {
  const sha256Bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sha256Bytes[i] = i + 1;

  const originalMeta = {
    fileName: '🚀_test_файл.png',
    mimeType: 'image/png',
    originalSize: 123456,
    payloadSize: 98765,
    sha256Bytes,
    isCompressed: true
  };

  const encoded = encodeManifest(originalMeta);
  assert.ok(encoded.length > 49);

  const decoded = decodeManifest(encoded);
  assert.ok(decoded !== null);
  assert.strictEqual(decoded.manifest.fileName, originalMeta.fileName);
  assert.strictEqual(decoded.manifest.mimeType, originalMeta.mimeType);
  assert.strictEqual(decoded.manifest.originalSize, originalMeta.originalSize);
  assert.strictEqual(decoded.manifest.payloadSize, originalMeta.payloadSize);
  assert.strictEqual(decoded.manifest.isCompressed, originalMeta.isCompressed);
  assert.deepStrictEqual(decoded.manifest.sha256Bytes, originalMeta.sha256Bytes);
});
