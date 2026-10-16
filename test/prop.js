/**
 * Property-based testing framework and test suite for ChromaStripe-JS.
 * Driven by seeded PRNG with failing-seed reporting and replay (PROP_SEED=...).
 */

import { PRNG } from '../src/core/prng.js';
import { bytesToSymbols, symbolsToBytes } from '../src/core/bitpack.js';
import { scramblePacket } from '../src/frame/scrambler.js';
import { crc32, crc32Incremental } from '../src/core/crc.js';
import { sampleResidualDegree, sampleSolitonDegree } from '../src/fountain/degree.js';
import { getDropletIndices } from '../src/fountain/schedule.js';
import { rsEncode, rsDecode } from '../src/core/reedsolomon.js';
import { encodeManifest, decodeManifest } from '../src/session/manifest.js';
import { FountainDecoder } from '../src/fountain/decoder.js';
import { encodeDroplet } from '../src/fountain/encoder.js';
import { fileURLToPath } from 'node:url';

const baseSeed = process.env.PROP_SEED
  ? parseInt(process.env.PROP_SEED, 10)
  : (Math.floor(Math.random() * 0x7FFFFFFF) || 1234567);

console.log(`[Property Testing] Active PRNG Base Seed: ${baseSeed}`);

export class PropertyRunner {
  constructor(seed = baseSeed) {
    this.baseSeed = seed;
    this.totalChecked = 0;
    this.failed = false;
  }

  forAll(name, generator, property, trials = 100) {
    process.stdout.write(`- Testing property "${name}" (${trials} trials)... `);
    for (let t = 0; t < trials; t++) {
      // Independent trial seed for reproducible shrinkage/replay
      const trialSeed = (this.baseSeed ^ (t * 2654435761)) >>> 0;
      const rng = new PRNG(trialSeed);
      const val = generator(rng, t);

      try {
        const ok = property(val, rng);
        if (ok === false) {
          throw new Error('Property returned false');
        }
        this.totalChecked++;
      } catch (err) {
        this.failed = true;
        console.log(`FAILED!`);
        console.error(`\n======================================================`);
        console.error(`PROPERTY FAILURE: "${name}"`);
        console.error(`Iteration: ${t + 1}/${trials}`);
        console.error(`Failing Seed: ${trialSeed}`);
        console.error(`Reproduce with: PROP_SEED=${trialSeed} node test/prop.js`);
        console.error(`Error message: ${err.message}`);
        console.error(`Input sample:`, typeof val === 'object' && val?.length ? `Array/Buffer of len ${val.length}` : val);
        console.error(`======================================================\n`);
        throw err;
      }
    }
    console.log(`PASSED (${trials}/${trials})`);
  }
}

// Common property generators
export const Gen = {
  bytes: (minLen = 0, maxLen = 1000) => (rng) => {
    const len = minLen + rng.nextBelow(maxLen - minLen + 1);
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = rng.nextBelow(256);
    return buf;
  },

  int: (min, max) => (rng) => {
    return min + rng.nextBelow(max - min + 1);
  },

  unicodeString: (minLen = 1, maxLen = 50) => (rng) => {
    const len = minLen + rng.nextBelow(maxLen - minLen + 1);
    const chars = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.!@#%^&*()📁文件مستند🎉日本語');
    let str = '';
    for (let i = 0; i < len; i++) {
      const idx = rng.nextBelow(chars.length);
      str += chars[idx];
    }
    return str;
  }
};

export async function runProperties() {
  const runner = new PropertyRunner(baseSeed);

  // 1. Bitpack round-trip
  runner.forAll(
    'bitpack: bytesToSymbols -> symbolsToBytes is lossless identity for all lengths',
    Gen.bytes(0, 800),
    (bytes) => {
      const symbols = bytesToSymbols(bytes);
      const recovered = symbolsToBytes(symbols, bytes.length);
      if (recovered.length !== bytes.length) return false;
      for (let i = 0; i < bytes.length; i++) {
        if (recovered[i] !== bytes[i]) return false;
      }
      return true;
    },
    200
  );

  // 2. Scrambler is an involution: f(f(x)) === x
  runner.forAll(
    'scrambler: scramblePacket is an involution (f(f(x)) == x)',
    (rng) => {
      const s = rng.nextBelow(4);
      const len = 542;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = rng.nextBelow(256);
      return { s, bytes };
    },
    ({ s, bytes }) => {
      const orig = new Uint8Array(bytes);
      const buf = new Uint8Array(bytes);
      scramblePacket(buf, s);
      scramblePacket(buf, s);
      for (let i = 0; i < orig.length; i++) {
        if (buf[i] !== orig[i]) return false;
      }
      return true;
    },
    200
  );

  // 3. CRC32 incremental matches one-shot
  runner.forAll(
    'crc32: incremental calculation with arbitrary chunking matches one-shot',
    Gen.bytes(1, 1500),
    (buf, rng) => {
      const expected = crc32(buf);
      let running = 0;
      let pos = 0;
      while (pos < buf.length) {
        const chunkLen = Math.min(buf.length - pos, 1 + rng.nextBelow(64));
        const chunk = buf.subarray(pos, pos + chunkLen);
        running = crc32Incremental(chunk, running);
        pos += chunkLen;
      }
      return running === expected;
    },
    200
  );

  // 4. Fountain degree and droplet indices never exceed K
  runner.forAll(
    'degree & schedule: droplet degree and indices never exceed K for any seed and K in [1, 500]',
    (rng) => {
      const K = 1 + rng.nextBelow(500);
      const seed = rng.nextU32();
      return { K, seed };
    },
    ({ K, seed }, rng) => {
      const dRes = sampleResidualDegree(rng, K);
      const dSol = sampleSolitonDegree(rng, K);
      const indices = getDropletIndices(seed, K);
      if (dRes < 1 || dRes > K) return false;
      if (dSol < 1 || dSol > K) return false;
      if (indices.length < 1 || indices.length > K) return false;
      for (const idx of indices) {
        if (idx < 0 || idx >= K) return false;
      }
      return true;
    },
    500
  );

  // 5. Reed-Solomon corrects any e <= t random errors
  runner.forAll(
    'reedsolomon: corrects up to t symbol errors for arbitrary message and error locations',
    (rng) => {
      const nsym = 28;
      const t = nsym >>> 1; // 14 errors
      const k = 255 - nsym;
      const msg = new Uint8Array(k);
      for (let i = 0; i < k; i++) msg[i] = rng.nextBelow(256);

      const errCount = rng.nextBelow(t + 1); // 0..14 errors
      const errPositions = new Set();
      while (errPositions.size < errCount) {
        errPositions.add(rng.nextBelow(255));
      }

      return { nsym, t, k, msg, errPositions };
    },
    ({ nsym, k, msg, errPositions }, rng) => {
      const parity = rsEncode(msg, nsym);
      const codeword = new Uint8Array(k + nsym);
      codeword.set(msg, 0);
      codeword.set(parity, k);

      // Inject errors
      for (const pos of errPositions) {
        const delta = 1 + rng.nextBelow(255);
        codeword[pos] ^= delta;
      }

      const decoded = rsDecode(codeword, nsym);
      if (!decoded.ok) return false;
      for (let i = 0; i < k; i++) {
        if (decoded.codeword[i] !== msg[i]) return false;
      }
      return true;
    },
    150
  );

  // 6. Manifest encode/decode round-trip
  runner.forAll(
    'manifest: encodeManifest and decodeManifest are lossless for unicode names',
    (rng) => {
      const fileName = Gen.unicodeString(1, 30)(rng);
      const mimeType = 'application/octet-stream';
      const originalSize = rng.nextBelow(500000);
      const payloadSize = originalSize;
      const sha256Bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) sha256Bytes[i] = rng.nextBelow(256);
      return {
        fileName,
        mimeType,
        originalSize,
        payloadSize,
        sha256Bytes,
        isCompressed: false
      };
    },
    (metadata) => {
      const manifestBytes = encodeManifest(metadata);
      const res = decodeManifest(manifestBytes);
      if (!res || !res.manifest) return false;
      const m = res.manifest;
      return (
        m.fileName === metadata.fileName &&
        m.mimeType === metadata.mimeType &&
        m.originalSize === metadata.originalSize &&
        m.payloadSize === metadata.payloadSize
      );
    },
    100
  );

  // 7. Fountain encoder / decoder end-to-end
  runner.forAll(
    'fountain: recovers random K source blocks with inactivation GE',
    (rng) => {
      const K = 3 + rng.nextBelow(12); // K in 3..14
      const sourceBlocks = Array.from({ length: K }, () => {
        const u32 = new Uint32Array(112);
        for (let w = 0; w < 112; w++) u32[w] = rng.nextU32();
        return u32;
      });
      return { K, sourceBlocks };
    },
    ({ K, sourceBlocks }, rng) => {
      const decoder = new FountainDecoder(K);
      let seed = rng.nextU32();

      // Transmit droplets with 25% random loss
      while (!decoder.isComplete() && decoder.receivedCount < Math.max(64, K * 6)) {
        if (rng.nextFloat() > 0.25) {
          const droplet = encodeDroplet(seed, sourceBlocks);
          decoder.addDroplet(seed, droplet);
        }
        seed = (seed + 1) >>> 0;
      }

      if (!decoder.isComplete()) return false;
      for (let i = 0; i < K; i++) {
        const blk = decoder.solved[i];
        for (let w = 0; w < 112; w++) {
          if (blk[w] !== sourceBlocks[i][w]) return false;
        }
      }
      return true;
    },
    50
  );

  console.log(`\n[Property Testing] All ${runner.totalChecked} randomized trials PASSED successfully!`);
}

// Run automatically when invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runProperties().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
