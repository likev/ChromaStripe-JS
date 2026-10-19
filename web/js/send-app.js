/**
 * Sender web application logic: File ingestion, frame pacing, fullscreen, and HUD.
 */

import { TxSession } from '../../src/session/txSession.js';
import { TxCanvasRenderer, computeAutoCorePx, getDimensionsForCorePx } from './tx-render.js';
import { formatBytes, formatTime } from './ui.js';
import { getDropletPhase } from '../../src/fountain/schedule.js';

let session = null;
let renderer = null;
let isRunning = false;
let isPaused = false;
let animFrameId = null;

let vsyncCount = 0;
let txHold = 4; // Default: Normal (15 fps on 60 Hz)
let rotation = 0;
let startTime = 0;
let totalFramesSent = 0;
let selectedSize = 'auto'; // 'auto' or integer string e.g. '5', '6', '7', '8'
let currentFile = null;

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileStats = document.getElementById('fileStats');
const changeFileBtn = document.getElementById('changeFileBtn');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const rotateBtn = document.getElementById('rotateBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const speedSelect = document.getElementById('speedSelect');
const sizeSelect = document.getElementById('sizeSelect');
const versionSelect = document.getElementById('versionSelect');
const gridSelect = document.getElementById('gridSelect');
const rateModeSelect = document.getElementById('rateModeSelect');
const rateModeField = document.getElementById('rateModeField');
const modSelect = document.getElementById('modSelect');
const modField = document.getElementById('modField');
const canvas = document.getElementById('txCanvas');
const hud = document.getElementById('hud');

/**
 * Updates TX dimensions on session, canvas, renderer, and size selector labels.
 */
function updateTxDimensions() {
  const gridSize = gridSelect ? parseInt(gridSelect.value, 10) : 80;
  const autoCorePx = computeAutoCorePx({ guardPx: 1, gridSize });
  const autoDims = getDimensionsForCorePx(autoCorePx, 1, gridSize);

  // Update Auto option label to ALWAYS show the auto-detected resolution
  if (sizeSelect) {
    const autoOpt = sizeSelect.querySelector('option[value="auto"]');
    if (autoOpt) {
      autoOpt.textContent = `Auto [Fit Screen] (${autoDims.dim}x${autoDims.dim})`;
    }
  }

  const corePx = selectedSize !== 'auto' ? parseInt(selectedSize, 10) : autoCorePx;
  const { guardPx, cellPx, dim } = getDimensionsForCorePx(corePx, 1, gridSize);

  if (session) {
    session.corePx = corePx;
    session.guardPx = guardPx;
    session.gridSize = gridSize;
  }

  if (renderer) {
    renderer.setSize(dim);
  } else if (canvas) {
    canvas.width = dim;
    canvas.height = dim;
  }

  return { corePx, guardPx, cellPx, dim, autoCorePx, autoDim: autoDims.dim };
}

// File Selection Handler
async function handleFile(file) {
  if (!file) return;
  currentFile = file;

  // If a transmission was previously running, stop it cleanly
  if (isRunning) {
    isRunning = false;
    isPaused = false;
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    startBtn.style.display = 'inline-block';
    pauseBtn.style.display = 'none';
    hud.style.display = 'none';
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  const { corePx, guardPx } = updateTxDimensions();

  const version = versionSelect ? parseInt(versionSelect.value, 10) : 2;
  const gridSize = gridSelect ? parseInt(gridSelect.value, 10) : 80;
  const rateMode = rateModeSelect ? parseInt(rateModeSelect.value, 10) : 1;
  const bitsPerCell = modSelect ? parseInt(modSelect.value, 10) : (version === 2 ? 6 : 3);

  session = new TxSession(bytes, {
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    scale: 1,
    rotation,
    corePx,
    guardPx,
    version,
    gridSize,
    rateMode,
    bitsPerCell
  });

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatBytes(bytes.length);
  if (dropZone) dropZone.style.display = 'none';
  if (fileStats) fileStats.style.display = 'block';

  await session.init();

  document.getElementById('blockCount').textContent = session.K;
  const numStripes = session.numStripes || 4;
  const dropletsPerSec = (60 / txHold) * numStripes;
  const estSec = Math.ceil(session.K / dropletsPerSec);
  document.getElementById('estTime').textContent = formatTime(estSec);

  startBtn.disabled = false;
  updateTxDimensions();
}

if (versionSelect) {
  versionSelect.addEventListener('change', () => {
    const isV2 = versionSelect.value === '2';
    if (rateModeField) rateModeField.style.display = isV2 ? 'block' : 'none';
    if (modField) modField.style.display = isV2 ? 'block' : 'none';
    if (currentFile) handleFile(currentFile);
  });
}

if (gridSelect) {
  gridSelect.addEventListener('change', () => {
    updateTxDimensions();
    if (currentFile) handleFile(currentFile);
  });
}

if (rateModeSelect) {
  rateModeSelect.addEventListener('change', () => {
    if (currentFile) handleFile(currentFile);
  });
}

if (modSelect) {
  modSelect.addEventListener('change', () => {
    if (currentFile) handleFile(currentFile);
  });
}

// Drag & drop listeners
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFile(fileInput.files[0]);
  }
});

if (changeFileBtn) {
  changeFileBtn.addEventListener('click', () => fileInput.click());
}

// Size setting
if (sizeSelect) {
  sizeSelect.addEventListener('change', () => {
    selectedSize = sizeSelect.value;
    updateTxDimensions();
  });
}

// Speed setting
speedSelect.addEventListener('change', () => {
  txHold = parseInt(speedSelect.value, 10);
  if (session && session.K) {
    const numStripes = session.numStripes || 4;
    const dropletsPerSec = (60 / txHold) * numStripes;
    const estSec = Math.ceil(session.K / dropletsPerSec);
    const estTimeEl = document.getElementById('estTime');
    if (estTimeEl) estTimeEl.textContent = formatTime(estSec);
  }
});

// Rotation toggle
rotateBtn.addEventListener('click', () => {
  rotation = rotation === 0 ? 90 : 0;
  if (session) session.rotation = rotation;
  rotateBtn.textContent = `Rotate (${rotation}°)`;
});

// Fullscreen & Wake Lock
fullscreenBtn.addEventListener('click', async () => {
  const container = document.getElementById('canvasArea');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl) {
    if (container.requestFullscreen) {
      await container.requestFullscreen().catch(() => {});
    } else if (container.webkitRequestFullscreen) {
      container.webkitRequestFullscreen();
    }
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
});

// Fullscreen change listener to update auto-dimensions
const onFullscreenChange = () => {
  updateTxDimensions();
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  fullscreenBtn.textContent = isFs ? 'Exit Fullscreen' : 'Fullscreen';
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

// Window resize listener to update auto-dimensions
window.addEventListener('resize', () => {
  updateTxDimensions();
});

// Start Transmission Loop
startBtn.addEventListener('click', () => {
  if (!session) return;

  startBtn.style.display = 'none';
  pauseBtn.style.display = 'inline-block';
  hud.style.display = 'grid';

  const settingsPanel = document.getElementById('settingsPanel');
  if (settingsPanel) settingsPanel.open = false;

  const { dim } = updateTxDimensions();
  renderer = new TxCanvasRenderer(canvas, 1, dim);
  isRunning = true;
  isPaused = false;
  vsyncCount = 0;
  totalFramesSent = 0;
  startTime = performance.now();
  lastFrameTime = 0;

  requestAnimationFrame(renderLoop);
});

pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  if (!isPaused) lastFrameTime = 0;
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
});

let lastFrameTime = 0;

// Main render loop with timestamp-based pacing (immune to 60/90/120 Hz VSync jitter)
function renderLoop(now) {
  if (!isRunning) return;

  if (!isPaused) {
    const targetIntervalMs = (txHold / 60) * 1000;
    if (!lastFrameTime || (now - lastFrameTime) >= targetIntervalMs - 4) {
      lastFrameTime = now;
      const backingBuffer = renderer ? renderer.getBackingBuffer() : null;
      const frame = session.getNextFrame(backingBuffer);
      renderer.displayFrame(frame.rgba, frame.width, frame.height);
      totalFramesSent++;

      // Update HUD
      const phaseNum = getDropletPhase(frame.seeds[0], session.K);
      const phaseNames = ['Systematic', 'Parity', 'Fountain'];
      document.getElementById('hudPhase').textContent = phaseNames[phaseNum];
      const lastSeed = frame.seeds[frame.seeds.length - 1];
      document.getElementById('hudSeeds').textContent = `${lastSeed + 1}`;
      const elapsed = (performance.now() - startTime) / 1000.0;
      document.getElementById('hudTime').textContent = formatTime(elapsed);
      document.getElementById('hudFps').textContent = (totalFramesSent / Math.max(1, elapsed)).toFixed(1);
    }
  }

  animFrameId = requestAnimationFrame(renderLoop);
}

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (isRunning) pauseBtn.click();
  } else if (e.key === 'r' || e.key === 'R') {
    rotateBtn.click();
  }
});

// Initial dimension calculation on load
updateTxDimensions();
