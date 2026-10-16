/**
 * Dataset generation: Renders simulated camera frames and exports raw RGBA + truth.jsonl metadata.
 */

import { SyntheticCamera } from './camera/index.js';
import { TxSession } from '../src/session/txSession.js';
import { getCorpusFile } from './corpus.js';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}

const scenarioName = getArg('--scenario', 'indoor-typical');
const numFrames = parseInt(getArg('--frames', '10'), 10);
const outDir = getArg('--out', `data/sim/${scenarioName}`);

async function main() {
  const scenarioPath = path.resolve(`sim/scenarios/${scenarioName}.json`);
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[Dataset] Generating ${numFrames} frames for '${scenarioName}' into ${outDir}`);

  const file = getCorpusFile('C1:64KB');
  const tx = new TxSession(file.data, { fileName: file.name });
  await tx.init();

  const camera = new SyntheticCamera(scenario);
  const txFramesMap = new Map();
  for (let f = 0; f < numFrames; f++) {
    txFramesMap.set(f, tx.getNextFrame());
  }

  const truthFile = path.join(outDir, 'truth.jsonl');
  const truthStream = fs.createWriteStream(truthFile, { flags: 'w' });

  for (let f = 0; f < numFrames; f++) {
    const tC = f * (1000 / camera.fps);
    const frame = camera.captureFrame(tC, txFramesMap);

    const frameFileName = `frame_${String(f).padStart(5, '0')}.rgba`;
    const framePath = path.join(outDir, frameFileName);
    fs.writeFileSync(framePath, Buffer.from(frame.rgba.buffer));

    const truthRecord = {
      frameIdx: f,
      tC,
      fileName: frameFileName,
      width: frame.width,
      height: frame.height,
      corners: frame.truth.corners,
      H: Array.from(frame.truth.H),
      tearRows: frame.truth.tearRows
    };
    truthStream.write(JSON.stringify(truthRecord) + '\n');
  }

  truthStream.end();
  console.log(`[Dataset] Complete: exported ${numFrames} frames and ${truthFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
