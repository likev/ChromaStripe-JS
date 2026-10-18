import { spawn } from 'node:child_process';
import { FrameDecoder } from '../src/vision/frameDecoder.js';
import { RxSession } from '../src/session/rxSession.js';

const ffmpeg = spawn('ffmpeg', [
  '-i', '/root/upload/files/VID20261018001853.mp4',
  '-f', 'rawvideo',
  '-pix_fmt', 'rgba',
  '-'
]);

const width = 720;
const height = 1280;
const frameSize = width * height * 4;

const decoder = new FrameDecoder();
const rx = new RxSession();

let frameCount = 0;
let validPacketsCount = 0;
let buffer = Buffer.alloc(0);

const decodedPackets = [];

ffmpeg.stdout.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= frameSize) {
    const frameBuffer = buffer.subarray(0, frameSize);
    buffer = buffer.subarray(frameSize);
    frameCount++;

    const rgba = new Uint8ClampedArray(frameBuffer.buffer, frameBuffer.byteOffset, frameSize);
    const res = decoder.decode(rgba, width, height);

    if (res.ok) {
      for (const stripe of res.stripes) {
        if (stripe.ok) {
          validPacketsCount++;
          decodedPackets.push({
            frame: frameCount,
            stripe: stripe.stripeIdx,
            header: stripe.header,
            corrected: stripe.corrected
          });
          console.log(`[Frame ${frameCount}] Stripe ${stripe.stripeIdx} OK! Seed: ${stripe.header.seed}, K: ${stripe.header.K}, Session: ${stripe.header.sessionId}, Corrected: ${stripe.corrected}`);
          try {
            await rx.ingestPacket(stripe.header, stripe.payloadU32);
          } catch (e) {
            console.error(`Ingest error: ${e.message}`);
          }
        }
      }
    }
  }
});

ffmpeg.stderr.on('data', () => {}); // silence ffmpeg stderr

ffmpeg.on('close', (code) => {
  console.log(`\n=== Summary ===`);
  console.log(`Total frames: ${frameCount}`);
  console.log(`Valid packets: ${validPacketsCount}`);
  console.log(`RxSession complete: ${rx.isComplete}`);
  if (rx.isComplete) {
    console.log(`RxSession result:`, rx.result);
  } else {
    console.log(`RxSession progress:`, rx.getProgress());
  }
  const uniqueSeeds = [...new Set(decodedPackets.map(p => p.header.seed))];
  console.log(`Unique seeds (${uniqueSeeds.length}):`, uniqueSeeds);
});
