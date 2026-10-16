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
    finderCenters
  };

  return memoizedLayout;
}

/**
 * Rotates logical cell coordinates by 0° or 90°.
 * @param {number} u - column [0, 79]
 * @param {number} v - row [0, 79]
 * @param {number} rotation - 0 or 90
 * @returns {{ u: number, v: number }}
 */
export function rotateCoords(u, v, rotation) {
  if (rotation === 90) {
    // 90 deg clockwise: (u, v) -> (79 - v, u)
    return { u: GRID_SIZE - 1 - v, v: u };
  }
  return { u, v };
}
