/**
 * End-to-end throughput and frame processing benchmark.
 */

import { TxSession } from '../src/session/txSession.js';
import { RxSession } from '../src/session/rxSession.js';
import { FrameDecoder } from '../src/vision/frameDecoder.js';
import { getCorpusFile } from '../sim/corpus.js';

async function runE2EBenchmark() {
  console.log('\n=============================================');
  console.log('--- ChromaStripe-JS: E2E Throughput Bench ---');
  console.log('=============================================\n');

  const file = getCorpusFile('C1:64KB');

  // 1. Benchmark v1 Baseline (3-bit RGB, 4 Stripes, 448B/stripe)
  console.log('--- Benchmarking v1 Baseline (3-bit RGB, 4 Stripes) ---');
  const txV1 = new TxSession(file.data, { fileName: file.name, scale: 1, version: 1 });
  await txV1.init();

  const rxV1 = new RxSession();
  const decoderV1 = new FrameDecoder({ version: 1 });

  const tStartV1 = performance.now();
  let framesCountV1 = 0;
  let totalDecodeMsV1 = 0;

  while (!rxV1.isComplete && framesCountV1 < 100) {
    const frame = txV1.getNextFrame();

    const t0 = performance.now();
    const decRes = decoderV1.decode(frame.rgba, frame.width, frame.height);
    totalDecodeMsV1 += (performance.now() - t0);

    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rxV1.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
    }
    framesCountV1++;
  }

  const elapsedSecV1 = (performance.now() - tStartV1) / 1000.0;
  const netKB = file.data.length / 1024.0;
  const throughputV1 = netKB / elapsedSecV1;
  const meanFrameMsV1 = totalDecodeMsV1 / framesCountV1;
  const goodput60fpsV1 = (framesCountV1 > 0) ? (netKB / (framesCountV1 / 60.0)) : 0;

  console.log(`v1 Transferred ${netKB.toFixed(1)} KB in ${framesCountV1} frames (${elapsedSecV1.toFixed(2)}s)`);
  console.log(`v1 Mean Vision Decode per frame: ${meanFrameMsV1.toFixed(2)} ms`);
  console.log(`v1 Effective Simulated Throughput: ${throughputV1.toFixed(1)} KB/s`);
  console.log(`v1 Streaming Goodput @ 60 FPS: ${goodput60fpsV1.toFixed(1)} KB/s`);
  console.log(`v1 SHA-256 Verified: ${rxV1.result?.sha256Verified}\n`);

  // 2. Benchmark v2 Standard (6-bit 4-PAM, 8 Micro-Stripes, 80x80, Single-Codeword RS)
  console.log('--- Benchmarking v2 Standard (6-bit 4-PAM, 8 Micro-Stripes, 80x80 Single-Codeword) ---');
  const txV2Std = new TxSession(file.data, {
    fileName: file.name,
    scale: 1,
    version: 2,
    gridSize: 80,
    bitsPerCell: 6,
    numStripes: 8
  });
  await txV2Std.init();

  const rxV2Std = new RxSession();
  const decoderV2Std = new FrameDecoder({
    version: 2,
    gridSize: 80,
    bitsPerCell: 6,
    numStripes: 8
  });

  const tStartV2Std = performance.now();
  let framesCountV2Std = 0;
  let totalDecodeMsV2Std = 0;

  while (!rxV2Std.isComplete && framesCountV2Std < 100) {
    const frame = txV2Std.getNextFrame();

    const t0 = performance.now();
    const decRes = decoderV2Std.decode(frame.rgba, frame.width, frame.height);
    totalDecodeMsV2Std += (performance.now() - t0);

    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rxV2Std.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
    }
    framesCountV2Std++;
  }

  const elapsedSecV2Std = (performance.now() - tStartV2Std) / 1000.0;
  const throughputV2Std = netKB / elapsedSecV2Std;
  const meanFrameMsV2Std = totalDecodeMsV2Std / framesCountV2Std;
  const goodput60fpsV2Std = (framesCountV2Std > 0) ? (netKB / (framesCountV2Std / 60.0)) : 0;

  console.log(`v2 Standard Transferred ${netKB.toFixed(1)} KB in ${framesCountV2Std} frames (${elapsedSecV2Std.toFixed(2)}s)`);
  console.log(`v2 Standard Mean Vision Decode per frame: ${meanFrameMsV2Std.toFixed(2)} ms (Single-codeword RS eliminates interleaving)`);
  console.log(`v2 Standard Effective Simulated Throughput: ${throughputV2Std.toFixed(1)} KB/s`);
  console.log(`v2 Standard Streaming Goodput @ 60 FPS: ${goodput60fpsV2Std.toFixed(1)} KB/s`);
  console.log(`v2 Standard SHA-256 Verified: ${rxV2Std.result?.sha256Verified}\n`);

  // 3. Benchmark v2 Turbo (96x96 Adaptive High-Density Grid, 6-bit 4-PAM, 8 Micro-Stripes, 448B/stripe)
  console.log('--- Benchmarking v2 Turbo (96x96 Grid, 6-bit 4-PAM, 8 Micro-Stripes, 3.5 KB/frame) ---');
  const txV2Turbo = new TxSession(file.data, {
    fileName: file.name,
    scale: 1,
    version: 2,
    turbo: true,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8
  });
  await txV2Turbo.init();

  const rxV2Turbo = new RxSession();
  const decoderV2Turbo = new FrameDecoder({
    version: 2,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8
  });

  const tStartV2Turbo = performance.now();
  let framesCountV2Turbo = 0;
  let totalDecodeMsV2Turbo = 0;

  while (!rxV2Turbo.isComplete && framesCountV2Turbo < 100) {
    const frame = txV2Turbo.getNextFrame();

    const t0 = performance.now();
    const decRes = decoderV2Turbo.decode(frame.rgba, frame.width, frame.height);
    totalDecodeMsV2Turbo += (performance.now() - t0);

    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) {
          await rxV2Turbo.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
    }
    framesCountV2Turbo++;
  }

  const elapsedSecV2Turbo = (performance.now() - tStartV2Turbo) / 1000.0;
  const throughputV2Turbo = netKB / elapsedSecV2Turbo;
  const meanFrameMsV2Turbo = totalDecodeMsV2Turbo / framesCountV2Turbo;
  const goodput60fpsV2Turbo = (framesCountV2Turbo > 0) ? (netKB / (framesCountV2Turbo / 60.0)) : 0;

  console.log(`v2 Turbo Transferred ${netKB.toFixed(1)} KB in ${framesCountV2Turbo} frames (${elapsedSecV2Turbo.toFixed(2)}s)`);
  console.log(`v2 Turbo Mean Vision Decode per frame: ${meanFrameMsV2Turbo.toFixed(2)} ms`);
  console.log(`v2 Turbo Effective Simulated Throughput: ${throughputV2Turbo.toFixed(1)} KB/s`);
  console.log(`v2 Turbo Streaming Goodput @ 60 FPS: ${goodput60fpsV2Turbo.toFixed(1)} KB/s`);
  console.log(`v2 Turbo SHA-256 Verified: ${rxV2Turbo.result?.sha256Verified}`);

  console.log(`\n>>> Incompressible 60 FPS Goodput: ${(goodput60fpsV1).toFixed(1)} KB/s (v1) → ${(goodput60fpsV2Turbo).toFixed(1)} KB/s (v2 Turbo: ${(goodput60fpsV2Turbo / goodput60fpsV1).toFixed(2)}x physical link speedup!) <<<\n`);

  // 4. Benchmark structured data with Pre-Compression (C2:json)
  console.log('--- Benchmarking Structured Payload with Stronger Pre-Compression (C2:json) ---');
  const jsonFile = getCorpusFile('C2:json');
  const netJsonKB = jsonFile.data.length / 1024.0;

  // v1 baseline on JSON
  const txJsonV1 = new TxSession(jsonFile.data, { fileName: jsonFile.name, scale: 1, version: 1 });
  await txJsonV1.init();
  const rxJsonV1 = new RxSession();
  const decoderJsonV1 = new FrameDecoder({ version: 1 });
  let framesJsonV1 = 0;
  const tStartJsonV1 = performance.now();
  while (!rxJsonV1.isComplete && framesJsonV1 < 100) {
    const frame = txJsonV1.getNextFrame();
    const decRes = decoderJsonV1.decode(frame.rgba, frame.width, frame.height);
    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) await rxJsonV1.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesJsonV1++;
  }
  const elapsedJsonV1 = (performance.now() - tStartJsonV1) / 1000.0;
  const throughputJsonV1 = netJsonKB / elapsedJsonV1;
  const goodput60fpsJsonV1 = (netJsonKB / (framesJsonV1 / 60.0));

  console.log(`v1 Structured: ${netJsonKB.toFixed(1)} KB in ${framesJsonV1} frames (${elapsedJsonV1.toFixed(2)}s) -> Goodput @ 60 FPS: ${goodput60fpsJsonV1.toFixed(1)} KB/s`);

  // v2 Turbo on JSON (compressAuto + CSv2 + 96x96 Turbo)
  const txJsonV2 = new TxSession(jsonFile.data, {
    fileName: jsonFile.name,
    scale: 1,
    version: 2,
    turbo: true,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8
  });
  await txJsonV2.init();
  const rxJsonV2 = new RxSession();
  const decoderJsonV2 = new FrameDecoder({
    version: 2,
    gridSize: 96,
    bitsPerCell: 6,
    numStripes: 8
  });
  let framesJsonV2 = 0;
  const tStartJsonV2 = performance.now();
  while (!rxJsonV2.isComplete && framesJsonV2 < 100) {
    const frame = txJsonV2.getNextFrame();
    const decRes = decoderJsonV2.decode(frame.rgba, frame.width, frame.height);
    if (decRes.ok) {
      for (const stripe of decRes.stripes) {
        if (stripe.ok) await rxJsonV2.ingestPacket(stripe.header, stripe.payloadU32);
      }
    }
    framesJsonV2++;
  }
  const elapsedJsonV2 = (performance.now() - tStartJsonV2) / 1000.0;
  const throughputJsonV2 = netJsonKB / elapsedJsonV2;
  const goodput60fpsJsonV2 = (netJsonKB / (framesJsonV2 / 60.0));

  console.log(`v2 Structured: ${netJsonKB.toFixed(1)} KB in ${framesJsonV2} frames (${elapsedJsonV2.toFixed(2)}s) -> Goodput @ 60 FPS: ${goodput60fpsJsonV2.toFixed(1)} KB/s`);
  console.log(`v2 Structured SHA-256 Verified: ${rxJsonV2.result?.sha256Verified}`);

  console.log(`\n========================================================================`);
  console.log(`>>> Tier 3 v2 Turbo Throughput: ${goodput60fpsJsonV1.toFixed(1)} KB/s (v1) → ${goodput60fpsJsonV2.toFixed(1)} KB/s (v2 Turbo) <<<`);
  console.log(`========================================================================\n`);
}

runE2EBenchmark().catch(err => {
  console.error(err);
  process.exit(1);
});
