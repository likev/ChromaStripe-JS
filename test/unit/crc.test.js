import { test, assert } from '../harness.js';
import { crc32, crc16 } from '../../src/core/crc.js';

test('crc: standard vector "123456789"', () => {
  const data = new TextEncoder().encode('123456789');
  const c32 = crc32(data);
  // IEEE 802.3 golden vector: 0xCBF43926
  assert.strictEqual(c32, 0xCBF43926);

  const c16 = crc16(data);
  // Standard CRC16-CCITT golden vector: 0x29B1
  assert.strictEqual(c16, 0x29B1);
});

test('crc: incremental matches one-shot', () => {
  const part1 = new TextEncoder().encode('12345');
  const part2 = new TextEncoder().encode('6789');

  const c32Part1 = crc32(part1);
  const c32Full = crc32(part2, c32Part1);
  assert.strictEqual(c32Full, 0xCBF43926);
});
