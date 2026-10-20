import { test, assert } from '../harness.js';
import {
  PROTOCOL_VERSION_V2,
  MAGIC_MANIFEST_V2,
  SUPPORTED_GRID_SIZES,
  MODULATION_MODES,
  RS_RATE_MODES,
  V2_NUM_STRIPES,
  V2_PAYLOAD_WORDS,
  V2_PAYLOAD_BYTES,
  V2_RS_PARITY_HIGH_RATE,
  V2_RS_PARITY_STANDARD,
  V2_PACKET_BYTES_HIGH_RATE,
  V2_PACKET_BYTES_STANDARD,
  PAM4_LEVELS,
  PAM4_GRAY_TO_LEVEL,
  PAM4_THRESHOLDS
} from '../../src/frame/constants.js';
import { getLayoutV2, rotateCoords } from '../../src/frame/layout.js';
import { bytesToSymbolsMultiBit, symbolsToBytesMultiBit, symbolsMarginsToByteMarginsMultiBit } from '../../src/core/bitpack.js';
import { buildPacketV2, parsePacketV2 } from '../../src/frame/packet.js';
import { sliceCell4Pam } from '../../src/vision/sampler.js';
import { PilotCalibrator } from '../../src/vision/pilots.js';
import {
  compressGzip,
  decompressGzip,
  compressDeflate,
  decompressDeflate,
  compressDeflateRaw,
  decompressDeflateRaw,
  applyDeltaFilter,
  invertDeltaFilter,
  compressAuto,
  decompressFormatted,
  COMPRESSION_FORMATS
} from '../../src/session/compression.js';
import { encodeManifest, decodeManifest } from '../../src/session/manifest.js';
import { TxSession } from '../../src/session/txSession.js';
import { RxSession } from '../../src/session/rxSession.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';

test('tier3: 4-PAM Gray coding mapping and slicing with soft margins', () => {
  // PAM4_LEVELS = [40, 112, 184, 255]
  // Gray to level: [0 -> 40, 1 -> 112, 3 -> 184, 2 -> 255]
  // Invert: 40 -> 0 (00b), 112 -> 1 (01b), 184 -> 3 (11b), 255 -> 2 (10b)
  const thresh9 = [
    76, 148, 220,  // R thresholds
    76, 148, 220,  // G thresholds
    76, 148, 220   // B thresholds
  ];

  // Test ideal constellation points for all 64 6-bit symbols
  for (let rBit = 0; rBit < 4; rBit++) {
    const rVal = PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[rBit]];
    for (let gBit = 0; gBit < 4; gBit++) {
      const gVal = PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[gBit]];
      for (let bBit = 0; bBit < 4; bBit++) {
        const bVal = PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bBit]];
        const expectedSym = (rBit << 4) | (gBit << 2) | bBit;
        const res = sliceCell4Pam(rVal, gVal, bVal, thresh9);
        assert.strictEqual(res.sym, expectedSym, `Mismatch for bits (${rBit}, ${gBit}, ${bBit})`);
        assert.ok(res.margin > 15, `Margin ${res.margin} should be strongly confident for ideal point`);
      }
    }
  }

  // Test Gray code property: adjacent level steps change exactly 1 bit
  for (let lvl = 0; lvl < 3; lvl++) {
    const bitA = [0, 1, 3, 2].indexOf(lvl); // level lvl
    const bitB = [0, 1, 3, 2].indexOf(lvl + 1); // adjacent level lvl + 1
    const diff = bitA ^ bitB;
    const hammingDist = (diff & 1) + ((diff >>> 1) & 1);
    assert.strictEqual(hammingDist, 1, `Adjacent levels ${lvl} and ${lvl + 1} must have Hamming distance 1`);
  }
});

test('tier3: 6-bit multi-bit packing round-trips losslessly', () => {
  const byteCounts = [1, 2, 3, 4, 10, 56, 224, 250, 254, 500];
  for (const n of byteCounts) {
    const original = new Uint8Array(n);
    for (let i = 0; i < n; i++) original[i] = (i * 101 + 37) & 0xFF;

    const symbols = bytesToSymbolsMultiBit(original, 6);
    const recovered = symbolsToBytesMultiBit(symbols, 6, n);

    assert.strictEqual(recovered.length, n);
    for (let i = 0; i < n; i++) {
      assert.strictEqual(recovered[i], original[i], `Byte mismatch at index ${i} for length ${n}`);
    }
  }
});

test('tier3: 8 micro-stripes layout and cell reclamation geometry', () => {
  for (const gridSize of SUPPORTED_GRID_SIZES) {
    const layout = getLayoutV2({ gridSize, numStripes: 8 });
    assert.strictEqual(layout.gridSize, gridSize);
    assert.strictEqual(layout.numStripes, 8);
    assert.strictEqual(layout.stripeDataCells.length, 8);

    const totalCells = gridSize * gridSize;
    assert.strictEqual(layout.cellClass.length, totalCells);

    // Verify non-overlapping stripe cells
    const cellOwner = new Int8Array(totalCells).fill(-1);
    let totalDataCells = 0;

    for (let s = 0; s < 8; s++) {
      const cells = layout.stripeDataCells[s];
      assert.ok(cells.length >= 350, `Grid ${gridSize} stripe ${s} has sufficient cells: ${cells.length}`);
      totalDataCells += cells.length;

      for (const { r, c } of cells) {
        assert.ok(r >= 0 && r < gridSize);
        assert.ok(c >= 0 && c < gridSize);
        const idx = r * gridSize + c;
        assert.strictEqual(cellOwner[idx], -1, `Cell (${r}, ${c}) doubly allocated!`);
        cellOwner[idx] = s;
        assert.strictEqual(layout.cellClass[idx], 0, `Cell (${r}, ${c}) must be classified as data (0)`);
      }
    }

    // Verify cell reclamation: reclaimed data cells should be significantly higher than naive quiet zones
    assert.ok(totalDataCells > (gridSize * gridSize * 0.5), `Reclaimed cells ${totalDataCells} exceeds 50% of grid`);
  }
});

test('tier3: single-codeword RS error correction without interleaving', () => {
  const payloadU32 = new Uint32Array(V2_PAYLOAD_WORDS);
  for (let i = 0; i < V2_PAYLOAD_WORDS; i++) payloadU32[i] = (i * 0xdeadbeef + 0x12345678) >>> 0;

  // 1. High-rate mode: nsym=14, t=7 byte errors correctable
  const headerHigh = { stripeIdx: 3, phase: 1, seed: 12345, K: 20, sessionId: 999, rateMode: RS_RATE_MODES.HIGH_RATE };
  const pktHigh = buildPacketV2(headerHigh, payloadU32);
  assert.strictEqual(pktHigh.length, V2_PACKET_BYTES_HIGH_RATE); // 250 bytes

  // Clean parse
  const cleanRes = parsePacketV2(pktHigh, 3);
  assert.strictEqual(cleanRes.ok, true);
  assert.strictEqual(cleanRes.corrected, 0);
  assert.strictEqual(cleanRes.header.stripeIdx, 3);
  assert.strictEqual(cleanRes.header.rateMode, RS_RATE_MODES.HIGH_RATE);

  // Corrupt 7 arbitrary bytes across header, payload, and parity
  const corruptedHigh = new Uint8Array(pktHigh);
  const errorIndices = [2, 10, 50, 100, 150, 200, 245];
  for (const idx of errorIndices) {
    corruptedHigh[idx] ^= 0x5a;
  }
  const recHigh = parsePacketV2(corruptedHigh, 3);
  assert.strictEqual(recHigh.ok, true, 'Single-codeword RS must correct up to 7 byte errors');
  assert.strictEqual(recHigh.corrected, 7);
  for (let i = 0; i < V2_PAYLOAD_WORDS; i++) {
    assert.strictEqual(recHigh.payloadU32[i], payloadU32[i]);
  }

  // 2. Standard rate mode: nsym=18, t=9 byte errors correctable
  const headerStd = { stripeIdx: 5, phase: 2, seed: 67890, K: 30, sessionId: 777, rateMode: RS_RATE_MODES.STANDARD };
  const pktStd = buildPacketV2(headerStd, payloadU32);
  assert.strictEqual(pktStd.length, V2_PACKET_BYTES_STANDARD); // 254 bytes

  const corruptedStd = new Uint8Array(pktStd);
  const errorIndicesStd = [0, 5, 25, 75, 120, 180, 210, 230, 252]; // 9 byte errors
  for (const idx of errorIndicesStd) {
    corruptedStd[idx] ^= 0xa5;
  }
  const recStd = parsePacketV2(corruptedStd, 5);
  assert.strictEqual(recStd.ok, true, 'Single-codeword RS must correct up to 9 byte errors for nsym=18');
  assert.strictEqual(recStd.corrected, 9);
  for (let i = 0; i < V2_PAYLOAD_WORDS; i++) {
    assert.strictEqual(recStd.payloadU32[i], payloadU32[i]);
  }

  // 3. Uncorrectable error count triggers CRC / RS rejection
  const fatalHigh = new Uint8Array(pktHigh);
  for (let i = 0; i < 15; i++) fatalHigh[i * 10] ^= 0xff; // 15 errors > t=7
  const fatalRes = parsePacketV2(fatalHigh, 3);
  assert.strictEqual(fatalRes.ok, false);
});

test('tier3: pre-compression formats (gzip, deflate, deflate-raw, delta) and CSv2 manifest', async () => {
  // 1. Text input with high repetitive patterns
  const sampleText = new TextEncoder().encode('ChromaStripe protocol evolution v2 higher order constellation! '.repeat(50));
  const autoText = await compressAuto(sampleText);
  assert.strictEqual(autoText.isCompressed, true);
  assert.ok(autoText.data.length < sampleText.length * 0.3);

  const decompText = await decompressFormatted(autoText.data, autoText.format);
  assert.strictEqual(new TextDecoder().decode(decompText), new TextDecoder().decode(sampleText));

  // 2. Linear telemetry ramp input (ideal for delta pre-filter)
  const ramp = new Uint8Array(1000);
  for (let i = 0; i < 1000; i++) ramp[i] = (i * 3) & 0xFF;
  const filtered = applyDeltaFilter(ramp);
  const inverted = invertDeltaFilter(filtered);
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual(inverted[i], ramp[i]);
  }

  const autoRamp = await compressAuto(ramp);
  assert.strictEqual(autoRamp.isCompressed, true);
  const decompRamp = await decompressFormatted(autoRamp.data, autoRamp.format);
  for (let i = 0; i < 1000; i++) {
    assert.strictEqual(decompRamp[i], ramp[i]);
  }

  // 3. CSv2 manifest round-trip
  const fakeSha = new Uint8Array(32).fill(0x42);
  const manifestBytes = encodeManifest({
    fileName: 'telemetry_v2.bin',
    mimeType: 'application/octet-stream',
    originalSize: ramp.length,
    payloadSize: autoRamp.data.length,
    sha256Bytes: fakeSha,
    isCompressed: autoRamp.isCompressed,
    compressionFormat: autoRamp.format,
    version: 2
  });

  // Verify magic "CSv2"
  assert.strictEqual(manifestBytes[0], 0x43);
  assert.strictEqual(manifestBytes[1], 0x53);
  assert.strictEqual(manifestBytes[2], 0x76);
  assert.strictEqual(manifestBytes[3], 0x32); // '2'

  const decodedManifest = decodeManifest(manifestBytes);
  assert.ok(decodedManifest !== null);
  assert.strictEqual(decodedManifest.manifest.version, 2);
  assert.strictEqual(decodedManifest.manifest.fileName, 'telemetry_v2.bin');
  assert.strictEqual(decodedManifest.manifest.originalSize, ramp.length);
  assert.strictEqual(decodedManifest.manifest.compressionFormat, autoRamp.format);
});

test('tier3: end-to-end transmit, vision decode, and exact SHA-256 reconstruction (80x80 v2 Turbo)', async () => {
  const originalStr = 'ChromaStripe Tier 3 Turbo: 6-bit 4-PAM with 8 micro-stripes and single-codeword RS! '.repeat(25);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'turbo.txt',
    mimeType: 'text/plain',
    version: 2,
    gridSize: 80,
    bitsPerCell: 6,
    numStripes: 8,
    rateMode: RS_RATE_MODES.HIGH_RATE,
    turbo: false, // explicit single-codeword mode (default auto-selects dual-codeword when it fits)
    scale: 1
  });
  await tx.init();

  assert.strictEqual(tx.version, 2);
  assert.strictEqual(tx.numStripes, 8);
  assert.strictEqual(tx.payloadBytes, 224);

  const rx = new RxSession();
  const frameDecoder = new FrameDecoder({
    version: 2,
    gridSize: 80,
    bitsPerCell: 6,
    numStripes: 8
  });

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 40) {
    const frame = tx.getNextFrame();
    assert.strictEqual(frame.packets.length, 8);

    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true, `Frame ${framesProcessed} vision decode must succeed`);
    assert.strictEqual(decRes.stripes.length, 8);

    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.ok(rx.result !== null);
  assert.strictEqual(rx.result.fileName, 'turbo.txt');
  assert.strictEqual(rx.result.mimeType, 'text/plain');
  assert.strictEqual(rx.result.sha256Verified, true);

  const decodedStr = new TextDecoder().decode(rx.result.data);
  assert.strictEqual(decodedStr, originalStr);
});

test('tier3: end-to-end transmit and decode with auto-detection across 96x96 grid', async () => {
  const originalStr = 'ChromaStripe Adaptive 96x96 Grid Density Test Vector! '.repeat(20);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'dense96.txt',
    mimeType: 'text/plain',
    version: 2,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8,
    scale: 1
  });
  await tx.init();

  const rx = new RxSession();
  // Decoder initialized in 'auto' version mode with gridSize 96
  const frameDecoder = new FrameDecoder({
    version: 'auto',
    gridSize: 96
  });

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 40) {
    const frame = tx.getNextFrame();
    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true);

    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(rx.result.fileName, 'dense96.txt');
  assert.strictEqual(rx.result.sha256Verified, true);
  assert.strictEqual(new TextDecoder().decode(rx.result.data), originalStr);
});

test('tier3: dual-codeword Turbo packet (488B) error correction and E2E transfer', async () => {
  // Test dual-codeword RS math & corruption correction
  const payloadU32 = new Uint32Array(112);
  for (let i = 0; i < 112; i++) payloadU32[i] = 0x11223344 + i * 7;
  const header = { stripeIdx: 3, phase: 1, seed: 99999, K: 10, sessionId: 42 };

  const packet = buildPacketV2(header, payloadU32);
  assert.strictEqual(packet.length, 488); // 12 + 448 + 28 = 488

  // Corrupt 6 bytes in cw0 (indices 0, 2, 4, 6, 8, 10) and 6 bytes in cw1 (indices 1, 3, 5, 7, 9, 11)
  const corrupted = new Uint8Array(packet);
  for (let i = 0; i < 12; i++) {
    corrupted[14 + i] ^= 0x5A;
  }
  const parseRes = parsePacketV2(corrupted, 3);
  assert.strictEqual(parseRes.ok, true);
  assert.strictEqual(parseRes.header.seed, 99999);
  assert.strictEqual(parseRes.header.sessionId, 42);
  assert.strictEqual(parseRes.payloadU32.length, 112);
  assert.strictEqual(parseRes.payloadU32[0], payloadU32[0]);

  // E2E transfer of Turbo session on 96x96
  const originalStr = 'ChromaStripe 448B Turbo Payload High-Throughput Stream! '.repeat(25);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'turbo96.txt',
    mimeType: 'text/plain',
    version: 2,
    turbo: true,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8,
    scale: 1
  });
  await tx.init();
  assert.strictEqual(tx.payloadBytes, 448);

  const rx = new RxSession();
  const frameDecoder = new FrameDecoder({ version: 2, gridSize: 96, bitsPerCell: 6, numStripes: 8 });

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 30) {
    const frame = tx.getNextFrame();
    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true);
    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(rx.result.fileName, 'turbo96.txt');
  assert.strictEqual(rx.result.sha256Verified, true);
  assert.strictEqual(new TextDecoder().decode(rx.result.data), originalStr);
});

test('tier3: 5-bit PAM modulation end-to-end transmit and decode', async () => {
  const originalStr = 'ChromaStripe 5-bit PAM RG Modulation Test Vector! '.repeat(15);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'pam5.txt',
    mimeType: 'text/plain',
    version: 2,
    gridSize: 80,
    bitsPerCell: 5,
    numStripes: 8,
    scale: 1
  });
  await tx.init();

  const rx = new RxSession();
  const frameDecoder = new FrameDecoder({
    version: 2,
    gridSize: 80,
    bitsPerCell: 5,
    numStripes: 8
  });

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 40) {
    const frame = tx.getNextFrame();
    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true);

    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(rx.result.fileName, 'pam5.txt');
  assert.strictEqual(rx.result.sha256Verified, true);
  assert.strictEqual(new TextDecoder().decode(rx.result.data), originalStr);
});

test('tier3: 112x112 ultra-density grid end-to-end transmit and decode', async () => {
  const originalStr = 'ChromaStripe 112x112 Ultra-Density Grid Test Stream! '.repeat(20);
  const originalBytes = new TextEncoder().encode(originalStr);

  const tx = new TxSession(originalBytes, {
    fileName: 'ultra112.txt',
    mimeType: 'text/plain',
    version: 2,
    gridSize: 112,
    bitsPerCell: 6,
    numStripes: 8,
    scale: 1
  });
  await tx.init();

  const rx = new RxSession();
  const frameDecoder = new FrameDecoder({
    version: 2,
    gridSize: 112,
    bitsPerCell: 6,
    numStripes: 8
  });

  let framesProcessed = 0;
  while (!rx.isComplete && framesProcessed < 40) {
    const frame = tx.getNextFrame();
    const decRes = frameDecoder.decode(frame.rgba, frame.width, frame.height);
    assert.strictEqual(decRes.ok, true);

    for (const stripe of decRes.stripes) {
      if (stripe.ok) {
        await rx.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesProcessed++;
  }

  assert.strictEqual(rx.isComplete, true);
  assert.strictEqual(rx.result.fileName, 'ultra112.txt');
  assert.strictEqual(rx.result.sha256Verified, true);
  assert.strictEqual(new TextDecoder().decode(rx.result.data), originalStr);
});

test('tier3: non-latching auto-detect interleaving v1 and v2 frames seamlessly', async () => {
  const bytesV1 = new TextEncoder().encode('Payload for v1 session frame test');
  const txV1 = new TxSession(bytesV1, { fileName: 'v1.txt', version: 1, scale: 1 });
  await txV1.init();

  const bytesV2 = new TextEncoder().encode('Payload for v2 session frame test');
  const txV2 = new TxSession(bytesV2, { fileName: 'v2.txt', version: 2, scale: 1 });
  await txV2.init();

  const frameDecoder = new FrameDecoder({ version: 'auto' });

  // Frame 1: v1 frame
  const f1 = txV1.getNextFrame();
  const r1 = frameDecoder.decode(f1.rgba, f1.width, f1.height);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.stats.version, 1);
  assert.strictEqual(frameDecoder.version, 'auto'); // Must not latch!

  // Frame 2: v2 frame
  const f2 = txV2.getNextFrame();
  const r2 = frameDecoder.decode(f2.rgba, f2.width, f2.height);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.stats.version, 2);
  assert.strictEqual(frameDecoder.version, 'auto'); // Must not latch!

  // Frame 3: v1 frame again
  const f3 = txV1.getNextFrame();
  const r3 = frameDecoder.decode(f3.rgba, f3.width, f3.height);
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.stats.version, 1);
  assert.strictEqual(frameDecoder.version, 'auto'); // Must not latch!

  // Frame 4: v2 frame again
  const f4 = txV2.getNextFrame();
  const r4 = frameDecoder.decode(f4.rgba, f4.width, f4.height);
  assert.strictEqual(r4.ok, true);
  assert.strictEqual(r4.stats.version, 2);
  assert.strictEqual(frameDecoder.version, 'auto'); // Must not latch!
});
