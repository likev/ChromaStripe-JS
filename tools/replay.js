/**
 * Replay tool: Feeds pre-recorded video frames or raw RGBA frames into FrameDecoder and RxSession.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FrameDecoder } from '../src/vision/frameDecoder.js';
import { RxSession } from '../src/session/rxSession.js';

const args = process.argv.slice(2);
const dirArg = args[0] || 'data/sim/indoor-typical';

async function main() {
  const datasetDir = path.resolve(dirArg);
  const truthPath = path.join(datasetDir, 'truth.jsonl');

  if (!fs.existsSync(truthPath)) {
    console.error(`Dataset directory missing truth.jsonl: ${datasetDir}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(truthPath, 'utf8').trim().split('\n');
  console.log(`[Replay] Replaying ${lines.length} frames from ${datasetDir}...`);

  const decoder = new FrameDecoder();
  const rx = new RxSession();

  let decodedStripes = 0;
  let totalStripes = 0;

  for (const line of lines) {
    if (!line) continue;
    const meta = JSON.parse(line);
    const frameFile = path.join(datasetDir, meta.fileName);
    const rawBuffer = fs.readFileSync(frameFile);
    const rgba = new Uint8ClampedArray(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

    const res = decoder.decode(rgba, meta.width, meta.height);
    if (res.ok) {
      for (const stripe of res.stripes) {
        totalStripes++;
        if (stripe.ok) {
          decodedStripes++;
          await rx.ingestPacket(stripe.header, stripe.payloadU32);
        }
      }
    }

    if (rx.isComplete) {
      console.log(`[Replay] Transfer completed! File: ${rx.result.fileName}, SHA-256 Verified: ${rx.result.sha256Verified}`);
      break;
    }
  }

  const yieldPct = totalStripes > 0 ? (decodedStripes / totalStripes) * 100 : 0;
  console.log(`[Replay] Finished. Usable Stripe Yield: ${yieldPct.toFixed(1)}% (${decodedStripes}/${totalStripes})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
