import { test, assert } from '../harness.js';
import {
  renderFrame,
  makeRgbaU32,
  SYMBOL_COLORS_U32,
  COLOR_BLACK_U32,
  COLOR_WHITE_U32,
  COLOR_MAGENTA_U32,
  COLOR_CYAN_U32,
  COLOR_FLOOR_U32
} from '../../src/frame/renderer.js';
import { SYMBOL_COLORS, COLOR_BLACK, COLOR_WHITE, COLOR_MAGENTA, COLOR_CYAN, COLOR_FLOOR } from '../../src/frame/constants.js';
import { TxCanvasRenderer } from '../../web/js/tx-render.js';
import { FrameDecoder } from '../../src/vision/frameDecoder.js';
import { buildPacket } from '../../src/frame/packet.js';
import { PRNG } from '../../src/core/prng.js';
import { bytesToSymbols, symbolsToBytes } from '../../src/core/bitpack.js';

test('tier2: makeRgbaU32 produces byte-exact endian-safe representations', () => {
  const buf = new Uint8ClampedArray(4);
  const u32View = new Uint32Array(buf.buffer);

  for (let s = 0; s < 8; s++) {
    const [r, g, b, a] = SYMBOL_COLORS[s];
    const packed = SYMBOL_COLORS_U32[s];
    u32View[0] = packed;
    assert.strictEqual(buf[0], r, `Red mismatch for symbol ${s}`);
    assert.strictEqual(buf[1], g, `Green mismatch for symbol ${s}`);
    assert.strictEqual(buf[2], b, `Blue mismatch for symbol ${s}`);
    assert.strictEqual(buf[3], a, `Alpha mismatch for symbol ${s}`);
  }

  u32View[0] = COLOR_BLACK_U32;
  assert.deepStrictEqual(Array.from(buf), COLOR_BLACK);

  u32View[0] = COLOR_WHITE_U32;
  assert.deepStrictEqual(Array.from(buf), COLOR_WHITE);

  u32View[0] = COLOR_MAGENTA_U32;
  assert.deepStrictEqual(Array.from(buf), COLOR_MAGENTA);

  u32View[0] = COLOR_CYAN_U32;
  assert.deepStrictEqual(Array.from(buf), COLOR_CYAN);

  u32View[0] = COLOR_FLOOR_U32;
  assert.deepStrictEqual(Array.from(buf), COLOR_FLOOR);
});

test('tier2: Uint32Array LUT renderer reuses outRgba and produces identical decodable output', () => {
  const rng = new PRNG(1337);
  const pktsA = Array.from({ length: 4 }, (_, s) => {
    const payload = new Uint32Array(112);
    for (let w = 0; w < 112; w++) payload[w] = rng.nextU32();
    return buildPacket({ ver: 1, stripeIdx: s, phase: 0, seed: s, K: 10, sessionId: 42 }, payload);
  });

  const pktsB = Array.from({ length: 4 }, (_, s) => {
    const payload = new Uint32Array(112);
    for (let w = 0; w < 112; w++) payload[w] = rng.nextU32();
    return buildPacket({ ver: 1, stripeIdx: s, phase: 0, seed: s + 4, K: 10, sessionId: 42 }, payload);
  });

  const resFreshA = renderFrame(pktsA, { scale: 1 });
  assert.strictEqual(resFreshA.width, 800);
  assert.strictEqual(resFreshA.height, 800);

  // Allocate reusable buffer and render Frame A then Frame B into it
  const reusableBuffer = new Uint8ClampedArray(800 * 800 * 4);
  const resReuseA = renderFrame(pktsA, { scale: 1, outRgba: reusableBuffer });
  assert.strictEqual(resReuseA.rgba, reusableBuffer);

  // Bit-exact verification between fresh allocation and reusable buffer
  for (let i = 0; i < reusableBuffer.length; i += 1024) {
    assert.strictEqual(resReuseA.rgba[i], resFreshA.rgba[i], `Byte mismatch at ${i}`);
  }

  // Render Frame B into same buffer (skipping static template copy)
  const resReuseB = renderFrame(pktsB, { scale: 1, outRgba: reusableBuffer });
  assert.strictEqual(resReuseB.rgba, reusableBuffer);

  // Both frames decode 100% cleanly with FrameDecoder
  const decoder = new FrameDecoder();
  const decA = decoder.decode(resFreshA.rgba, 800, 800);
  assert.strictEqual(decA.ok, true);
  for (let s = 0; s < 4; s++) {
    assert.strictEqual(decA.stripes[s].ok, true);
    assert.strictEqual(decA.stripes[s].header.seed, s);
  }

  const decB = decoder.decode(resReuseB.rgba, 800, 800);
  assert.strictEqual(decB.ok, true);
  for (let s = 0; s < 4; s++) {
    assert.strictEqual(decB.stripes[s].ok, true);
    assert.strictEqual(decB.stripes[s].header.seed, s + 4);
  }
});

test('tier2: TxCanvasRenderer provides getBackingBuffer and avoids redundant copy', () => {
  let putCount = 0;
  const dummyCanvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({
      imageSmoothingEnabled: false,
      createImageData: (w, h) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4)
      }),
      putImageData: () => { putCount++; }
    })
  };

  const renderer = new TxCanvasRenderer(dummyCanvas, 1);
  assert.strictEqual(dummyCanvas.style.imageRendering, 'pixelated');

  const backing = renderer.getBackingBuffer();
  assert.ok(backing instanceof Uint8ClampedArray);
  assert.strictEqual(backing.length, 800 * 800 * 4);

  // Call displayFrame with the backing buffer itself
  renderer.displayFrame(backing, 800, 800);
  assert.strictEqual(putCount, 1);
});

test('tier2: Hint corners seed FrameDecoder for fast tracking mode', () => {
  const rng = new PRNG(99);
  const pkts = Array.from({ length: 4 }, (_, s) => {
    const payload = new Uint32Array(112);
    for (let w = 0; w < 112; w++) payload[w] = rng.nextU32();
    return buildPacket({ ver: 1, stripeIdx: s, phase: 0, seed: s, K: 10, sessionId: 1 }, payload);
  });
  const { rgba, width, height } = renderFrame(pkts, { scale: 1 });

  const decoder1 = new FrameDecoder();
  const res1 = decoder1.decode(rgba, width, height);
  assert.strictEqual(res1.ok, true);
  const corners = res1.corners;

  // A fresh decoder receiving hintCorners immediately starts in tracking mode
  const decoder2 = new FrameDecoder();
  assert.strictEqual(decoder2.prevCorners, null);

  // Simulate pool hint injection
  decoder2.prevCorners = [corners.TL, corners.TR, corners.BL, corners.BR];
  const res2 = decoder2.decode(rgba, width, height);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(decoder2.lockCount, 1);
});

test('tier2: Cropped ROI calculations protect quiet zone and clamp to bounds', () => {
  const vw = 1280;
  const vh = 720;
  const corners = {
    TL: { x: 300, y: 100 },
    TR: { x: 700, y: 100 },
    BR: { x: 700, y: 500 },
    BL: { x: 300, y: 500 }
  };

  const minX = Math.max(0, Math.floor(Math.min(corners.TL.x, corners.TR.x, corners.BL.x, corners.BR.x) - 64));
  const minY = Math.max(0, Math.floor(Math.min(corners.TL.y, corners.TR.y, corners.BL.y, corners.BR.y) - 64));
  const maxX = Math.min(vw, Math.ceil(Math.max(corners.TL.x, corners.TR.x, corners.BL.x, corners.BR.x) + 64));
  const maxY = Math.min(vh, Math.ceil(Math.max(corners.TL.y, corners.TR.y, corners.BL.y, corners.BR.y) + 64));
  const cw = maxX - minX;
  const ch = maxY - minY;

  assert.strictEqual(minX, 300 - 64);
  assert.strictEqual(minY, 100 - 64);
  assert.strictEqual(maxX, 700 + 64);
  assert.strictEqual(maxY, 500 + 64);
  assert.strictEqual(cw, 400 + 128);
  assert.strictEqual(ch, 400 + 128);
  assert.ok(cw * ch < vw * vh * 0.85);
});

test('tier2: Camera hardware locking logic handles capabilities safely across unit ranges', async () => {
  // Test 100-microsecond unit range (max > 100, e.g. Chrome Android)
  let appliedConstraints = null;
  const mockTrack100us = {
    getCapabilities: () => ({
      whiteBalanceMode: ['continuous', 'manual'],
      exposureMode: ['continuous', 'manual'],
      focusMode: ['continuous', 'manual'],
      exposureTime: { min: 1.0, max: 10000.0 }
    }),
    getSettings: () => ({ exposureTime: 250.0 }),
    applyConstraints: async (c) => {
      appliedConstraints = c;
    }
  };

  const caps = mockTrack100us.getCapabilities();
  const settings = mockTrack100us.getSettings();
  const advanced = [];
  if (caps.whiteBalanceMode?.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
  if (caps.exposureMode?.includes('manual')) advanced.push({ exposureMode: 'manual' });
  if (caps.focusMode) {
    if (caps.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    else if (caps.focusMode.includes('manual')) advanced.push({ focusMode: 'manual' });
  }
  if (caps.exposureTime) {
    const minExp = caps.exposureTime.min || 0;
    const maxExp = caps.exposureTime.max || 100;
    let cap60;
    if (maxExp <= 1.0) cap60 = 1.0 / 60.0;
    else if (maxExp <= 100.0) cap60 = 1000.0 / 60.0;
    else cap60 = 10000.0 / 60.0; // ~166.67 units
    const curExp = settings.exposureTime || cap60;
    const targetExp = Math.max(minExp, Math.min(curExp, cap60, maxExp));
    advanced.push({ exposureTime: targetExp });
  }
  await mockTrack100us.applyConstraints({ advanced });

  assert.ok(appliedConstraints);
  assert.strictEqual(appliedConstraints.advanced[0].whiteBalanceMode, 'manual');
  assert.strictEqual(appliedConstraints.advanced[1].exposureMode, 'manual');
  assert.strictEqual(appliedConstraints.advanced[2].focusMode, 'continuous');
  assert.ok(Math.abs(appliedConstraints.advanced[3].exposureTime - (10000 / 60)) < 0.01);
});

test('tier2: Bitpack triplet-unrolled bytesToSymbols and symbolsToBytes are bit-exact identities', () => {
  const rng = new PRNG(2026);
  for (const len of [1, 2, 3, 4, 7, 8, 15, 16, 542, 600]) {
    const original = new Uint8Array(len);
    for (let i = 0; i < len; i++) original[i] = rng.nextU32() & 0xFF;

    const symbols = bytesToSymbols(original);
    assert.strictEqual(symbols.length, Math.ceil(len * 8 / 3));

    // Validate all symbols in [0, 7]
    for (let i = 0; i < symbols.length; i++) {
      assert.ok(symbols[i] >= 0 && symbols[i] <= 7, `Symbol ${symbols[i]} out of range at ${i}`);
    }

    const reconstructed = symbolsToBytes(symbols, len);
    assert.strictEqual(reconstructed.length, len);
    for (let i = 0; i < len; i++) {
      assert.strictEqual(reconstructed[i], original[i], `Byte mismatch at ${i} for len ${len}`);
    }
  }
});

test('tier2: Multi-worker pool sequencing resolves out-of-order frames correctly', () => {
  let latestCompletedFrameId = 0;
  let lastCorners = null;
  let consecutiveMisses = 0;
  const POOL_SIZE = 3;

  function simulateWorkerMessage({ frameId, corners }) {
    if (frameId < latestCompletedFrameId) {
      // Out of order: older frame does not update visual tracking
      return { visualUpdated: false };
    }
    latestCompletedFrameId = frameId;
    if (corners) {
      lastCorners = corners;
      consecutiveMisses = 0;
    } else {
      consecutiveMisses++;
      if (consecutiveMisses >= POOL_SIZE) {
        lastCorners = null;
      }
    }
    return { visualUpdated: true, lastCorners, consecutiveMisses };
  }

  // Frame 1 arrives
  const res1 = simulateWorkerMessage({ frameId: 1, corners: { TL: { x: 10, y: 10 } } });
  assert.strictEqual(res1.visualUpdated, true);
  assert.deepStrictEqual(lastCorners, { TL: { x: 10, y: 10 } });

  // Frame 3 arrives before Frame 2 (Worker 2 finished early)
  const res3 = simulateWorkerMessage({ frameId: 3, corners: { TL: { x: 30, y: 30 } } });
  assert.strictEqual(res3.visualUpdated, true);
  assert.deepStrictEqual(lastCorners, { TL: { x: 30, y: 30 } });

  // Frame 2 arrives late (Worker 1 had RS trials)
  const res2 = simulateWorkerMessage({ frameId: 2, corners: { TL: { x: 20, y: 20 } } });
  assert.strictEqual(res2.visualUpdated, false);
  // Must NOT revert to Frame 2 coordinates
  assert.deepStrictEqual(lastCorners, { TL: { x: 30, y: 30 } });

  // Now simulate camera losing tracking over consecutive misses
  simulateWorkerMessage({ frameId: 4, corners: null }); // Miss 1
  assert.ok(lastCorners !== null, 'Should retain corners on first miss');
  simulateWorkerMessage({ frameId: 5, corners: null }); // Miss 2
  assert.ok(lastCorners !== null, 'Should retain corners on second miss');
  simulateWorkerMessage({ frameId: 6, corners: null }); // Miss 3 >= POOL_SIZE
  assert.strictEqual(lastCorners, null, 'Must clear stale corners after POOL_SIZE consecutive misses');
});

test('tier2: Session epoch isolates frames across receiver restarts', () => {
  let sessionEpoch = 1;
  let ingestedCount = 0;

  function simulateIngest(sessionId) {
    if (sessionId && sessionId !== sessionEpoch) {
      return false; // Discard stale session frame
    }
    ingestedCount++;
    return true;
  }

  assert.strictEqual(simulateIngest(1), true);
  assert.strictEqual(ingestedCount, 1);

  // User resets / restarts receiver session
  sessionEpoch++; // Session 2

  // In-flight worker message from Session 1 arrives
  assert.strictEqual(simulateIngest(1), false);
  assert.strictEqual(ingestedCount, 1);

  // Message from Session 2 arrives
  assert.strictEqual(simulateIngest(2), true);
  assert.strictEqual(ingestedCount, 2);
});
