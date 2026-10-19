/**
 * Layout compiler: Frozen v1 80x80 cell geometry, classifications, and stripe mappings.
 */

import {
  GRID_SIZE,
  TOTAL_CELLS,
  CELL_TYPE,
  STRIPE_ROWS,
  STRIPE_DATA_CAPACITIES
} from './constants.js';

let memoizedLayout = null;

/**
 * Builds and returns the static layout descriptor.
 */
export function getLayout() {
  if (memoizedLayout) return memoizedLayout;

  const cellClass = new Uint8Array(TOTAL_CELLS);
  const cellStripe = new Int8Array(TOTAL_CELLS).fill(-1);

  // 1. Finder zones: 8x8 at 4 corners
  // TL: cols 0..7, rows 0..7
  // TR: cols 72..79, rows 0..7
  // BL: cols 0..7, rows 72..79
  // BR: cols 72..79, rows 72..79
  const isFinder = (r, c) => {
    return (
      (r < 8 && c < 8) ||
      (r < 8 && c >= 72) ||
      (r >= 72 && c < 8) ||
      (r >= 72 && c >= 72)
    );
  };

  // 2. Timing tracks: row 0, row 79, col 0, col 79 outside finders
  const isTiming = (r, c) => {
    if (isFinder(r, c)) return false;
    return r === 0 || r === 79 || c === 0 || c === 79;
  };

  // 3. Pilot blocks: 16 2x2 blocks at {9, 10} + 20*i
  const pilotOffsets = [9, 29, 49, 69];
  const pilotBlocks = [];
  const pilotCellsSet = new Set();

  for (let rIdx = 0; rIdx < 4; rIdx++) {
    const rBase = pilotOffsets[rIdx];
    for (let cIdx = 0; cIdx < 4; cIdx++) {
      const cBase = pilotOffsets[cIdx];
      pilotBlocks.push({ r: rBase, c: cBase, index: rIdx * 4 + cIdx });
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          pilotCellsSet.add((rBase + dr) * GRID_SIZE + (cBase + dc));
        }
      }
    }
  }

  // Classify all 6,400 cells
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const idx = r * GRID_SIZE + c;
      if (isFinder(r, c)) {
        cellClass[idx] = CELL_TYPE.FINDER;
      } else if (isTiming(r, c)) {
        cellClass[idx] = CELL_TYPE.TIMING;
      } else if (pilotCellsSet.has(idx)) {
        cellClass[idx] = CELL_TYPE.PILOT;
      } else {
        cellClass[idx] = CELL_TYPE.DATA;
      }
    }
  }

  // Group data cells by stripe
  const stripeDataCells = [[], [], [], []];
  for (let s = 0; s < 4; s++) {
    const [rStart, rEnd] = STRIPE_ROWS[s];
    for (let r = rStart; r <= rEnd; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const idx = r * GRID_SIZE + c;
        if (cellClass[idx] === CELL_TYPE.DATA) {
          cellStripe[idx] = s;
          stripeDataCells[s].push({ r, c, idx });
        }
      }
    }
  }

  // Assert capacities match specification
  for (let s = 0; s < 4; s++) {
    if (stripeDataCells[s].length !== STRIPE_DATA_CAPACITIES[s]) {
      throw new Error(
        `Stripe ${s} capacity mismatch: expected ${STRIPE_DATA_CAPACITIES[s]}, got ${stripeDataCells[s].length}`
      );
    }
  }

  // Timing cells ordered along edges
  const timingEdges = {
    top: [],    // row 0, cols 8..71
    bottom: [], // row 79, cols 8..71
    left: [],   // col 0, rows 8..71
    right: []   // col 79, rows 8..71
  };
  for (let c = 8; c <= 71; c++) {
    timingEdges.top.push({ r: 0, c, isWhite: ((c - 8) & 1) === 0 });
    timingEdges.bottom.push({ r: 79, c, isWhite: ((c - 8) & 1) === 0 });
  }
  for (let r = 8; r <= 71; r++) {
    timingEdges.left.push({ r, c: 0, isWhite: ((r - 8) & 1) === 0 });
    timingEdges.right.push({ r, c: 79, isWhite: ((r - 8) & 1) === 0 });
  }

  // Canonical finder centers (u, v) in logical grid coords
  const finderCenters = {
    TL: { u: 3.5, v: 3.5 },
    TR: { u: 76.5, v: 3.5 },
    BL: { u: 3.5, v: 76.5 },
    BR: { u: 76.5, v: 76.5 }
  };

  memoizedLayout = {
    cellClass,
    cellStripe,
    stripeDataCells,
    pilotBlocks,
    timingEdges,
    finderCenters,
    gridSize: GRID_SIZE,
    numStripes: 4
  };

  return memoizedLayout;
}

const memoizedLayoutsV2 = new Map();

/**
 * Builds and returns the layout descriptor for v2 with configurable grid size and micro-stripes.
 * Supports adaptive grid density: 80x80, 96x96, 112x112 with 8 micro-stripes.
 * Reclaims all data cells for maximum goodput.
 *
 * @param {object} [options]
 * @param {number} [options.gridSize=80] - 80, 96, or 112
 * @param {number} [options.numStripes=8] - Number of micro-stripes (default 8)
 * @returns {object} Layout descriptor
 */
export function getLayoutV2(options = {}) {
  const gridSize = options.gridSize || GRID_SIZE;
  const numStripes = options.numStripes || 8;
  const key = `${gridSize}_${numStripes}`;

  const cached = memoizedLayoutsV2.get(key);
  if (cached) return cached;

  const totalCells = gridSize * gridSize;
  const cellClass = new Uint8Array(totalCells);
  const cellStripe = new Int8Array(totalCells).fill(-1);

  // 1. Finder zones: 8x8 at 4 corners
  const isFinder = (r, c) => {
    return (
      (r < 8 && c < 8) ||
      (r < 8 && c >= gridSize - 8) ||
      (r >= gridSize - 8 && c < 8) ||
      (r >= gridSize - 8 && c >= gridSize - 8)
    );
  };

  // 2. Timing tracks: edges outside finders
  const isTiming = (r, c) => {
    if (isFinder(r, c)) return false;
    return r === 0 || r === gridSize - 1 || c === 0 || c === gridSize - 1;
  };

  // 3. Pilot blocks: 16 2x2 blocks arranged in 4x4 spatial lattice
  const pilotOffsets = (gridSize === 80)
    ? [9, 29, 49, 69]
    : (gridSize === 96)
      ? [9, 34, 59, 84]
      : (gridSize === 112)
        ? [9, 39, 69, 99]
        : [9, Math.round(9 + (gridSize - 20) / 3), Math.round(9 + 2 * (gridSize - 20) / 3), gridSize - 11];

  const pilotBlocks = [];
  const pilotCellsSet = new Set();

  for (let rIdx = 0; rIdx < 4; rIdx++) {
    const rBase = pilotOffsets[rIdx];
    for (let cIdx = 0; cIdx < 4; cIdx++) {
      const cBase = pilotOffsets[cIdx];
      pilotBlocks.push({ r: rBase, c: cBase, index: rIdx * 4 + cIdx });
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          pilotCellsSet.add((rBase + dr) * gridSize + (cBase + dc));
        }
      }
    }
  }

  // Classify all cells
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      if (isFinder(r, c)) {
        cellClass[idx] = CELL_TYPE.FINDER;
      } else if (isTiming(r, c)) {
        cellClass[idx] = CELL_TYPE.TIMING;
      } else if (pilotCellsSet.has(idx)) {
        cellClass[idx] = CELL_TYPE.PILOT;
      } else {
        cellClass[idx] = CELL_TYPE.DATA;
      }
    }
  }

  // Micro-stripe partitions: 8 horizontal stripes
  const rowsPerStripe = gridSize / numStripes;
  const stripeDataCells = Array.from({ length: numStripes }, () => []);
  const stripeRows = [];

  for (let s = 0; s < numStripes; s++) {
    const rStart = Math.round(s * rowsPerStripe);
    const rEnd = Math.round((s + 1) * rowsPerStripe) - 1;
    stripeRows.push([rStart, rEnd]);

    for (let r = rStart; r <= rEnd; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        if (cellClass[idx] === CELL_TYPE.DATA) {
          cellStripe[idx] = s;
          stripeDataCells[s].push({ r, c, idx });
        }
      }
    }
  }

  // Timing edges outside finders
  const timingEdges = {
    top: [],
    bottom: [],
    left: [],
    right: []
  };
  for (let c = 8; c <= gridSize - 9; c++) {
    timingEdges.top.push({ r: 0, c, isWhite: ((c - 8) & 1) === 0 });
    timingEdges.bottom.push({ r: gridSize - 1, c, isWhite: ((c - 8) & 1) === 0 });
  }
  for (let r = 8; r <= gridSize - 9; r++) {
    timingEdges.left.push({ r, c: 0, isWhite: ((r - 8) & 1) === 0 });
    timingEdges.right.push({ r, c: gridSize - 1, isWhite: ((r - 8) & 1) === 0 });
  }

  const finderCenters = {
    TL: { u: 3.5, v: 3.5 },
    TR: { u: gridSize - 3.5, v: 3.5 },
    BL: { u: 3.5, v: gridSize - 3.5 },
    BR: { u: gridSize - 3.5, v: gridSize - 3.5 }
  };

  const layout = {
    cellClass,
    cellStripe,
    stripeDataCells,
    stripeRows,
    pilotBlocks,
    timingEdges,
    finderCenters,
    gridSize,
    numStripes
  };

  memoizedLayoutsV2.set(key, layout);
  return layout;
}

/**
 * Rotates logical cell coordinates by 0° or 90°.
 * @param {number} u - column [0, gridSize - 1]
 * @param {number} v - row [0, gridSize - 1]
 * @param {number} rotation - 0 or 90
 * @param {number} [gridSize=80] - Grid dimension
 * @returns {{ u: number, v: number }}
 */
export function rotateCoords(u, v, rotation, gridSize = GRID_SIZE) {
  if (rotation === 90) {
    return { u: gridSize - 1 - v, v: u };
  }
  return { u, v };
}

