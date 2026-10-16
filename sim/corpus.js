/**
 * Deterministic test corpus generator for simulation and verification.
 */

import { PRNG } from '../src/core/prng.js';

export function getCorpusFile(id, options = {}) {
  const rng = new PRNG(options.seed || 12345);

  switch (id) {
    case 'C0:0B':
      return { name: 'empty.bin', data: new Uint8Array(0), mime: 'application/octet-stream' };
    case 'C0:1B':
      return { name: 'one_byte.bin', data: new Uint8Array([42]), mime: 'application/octet-stream' };
    case 'C0:447B':
      return { name: 'boundary_447.bin', data: generatePrngBytes(447, rng), mime: 'application/octet-stream' };
    case 'C0:448B':
      return { name: 'exact_block_448.bin', data: generatePrngBytes(448, rng), mime: 'application/octet-stream' };
    case 'C0:449B':
      return { name: 'boundary_449.bin', data: generatePrngBytes(449, rng), mime: 'application/octet-stream' };

    case 'C1:64KB':
      return { name: 'random_64k.bin', data: generatePrngBytes(64 * 1024, rng), mime: 'application/octet-stream' };
    case 'C1:1MB':
      return { name: 'random_1m.bin', data: generatePrngBytes(1024 * 1024, rng), mime: 'application/octet-stream' };
    case 'C1:10MB':
      return { name: 'random_10m.bin', data: generatePrngBytes(10 * 1024 * 1024, rng), mime: 'application/octet-stream' };

    case 'C2:text': {
      const sentence = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.\n';
      const repeated = sentence.repeat(options.repeat || 500);
      return { name: 'text.txt', data: new TextEncoder().encode(repeated), mime: 'text/plain' };
    }
    case 'C2:json': {
      const obj = [];
      for (let i = 0; i < 500; i++) {
        obj.push({ id: i, name: `Item ${i}`, active: i % 2 === 0, values: [i, i * 2, i * 3] });
      }
      return { name: 'data.json', data: new TextEncoder().encode(JSON.stringify(obj)), mime: 'application/json' };
    }

    case 'C3:zeros': {
      const size = options.size || 65536;
      return { name: 'all_zeros.bin', data: new Uint8Array(size), mime: 'application/octet-stream' };
    }
    case 'C3:ones': {
      const size = options.size || 65536;
      const data = new Uint8Array(size);
      data.fill(0xFF);
      return { name: 'all_ones.bin', data, mime: 'application/octet-stream' };
    }

    case 'C5:unicode':
      return {
        name: '📁_文件_مستند_🎉.txt',
        data: new TextEncoder().encode('ChromaStripe Optical File Transfer System 🌟 Unicode Test\n'),
        mime: 'text/plain'
      };

    default:
      return { name: 'default.bin', data: generatePrngBytes(1024, rng), mime: 'application/octet-stream' };
  }
}

function generatePrngBytes(length, rng) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = rng.nextBelow(256);
  }
  return buf;
}
