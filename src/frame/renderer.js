/**
 * Frame renderer: Paints 80x80 grid with finders, timing, pilots, guards, and 4 stripe packets into RGBA buffer.
 */

import {
  GRID_SIZE,
  CELL_BASE_PX,
  CORE_BASE_PX,
  GUARD_BASE_PX,
  COLOR_BLACK,
  COLOR_WHITE,
  COLOR_MAGENTA,
  COLOR_CYAN,
  COLOR_FLOOR,
  SYMBOL_COLORS
} from './constants.js';
import { getLayout, rotateCoords } from './layout.js';
import { bytesToSymbols } from '../core/bitpack.js';
import { getFillSymbols } from './scrambler.js';

/**
 * Determines RGB color for a finder cell (u, v) in logical space.
 */
function getFinderColor(u, v) {
  // Determine which corner: TL, TR, BL, BR
  const isRight = u >= 72;
  const isBottom = v >= 72;

  // Local coordinates within 8x8 corner [0..7, 0..7]
  const lu = isRight ? u - 72 : u;
  const lv = isBottom ? v - 72 : v;

  // Separator: inner edges of the 8x8 zone
  // For TL: col 7 or row 7
  // For TR: col 0 or row 7
  // For BL: col 7 or row 0
  // For BR: col 0 or row 0
  const isSeparator =
    (isRight ? lu === 0 : lu === 7) ||
    (isBottom ? lv === 0 : lv === 7);

  if (isSeparator) {
    return COLOR_BLACK;
  }

  // Bullseye 7x7 local coords [0..6, 0..6]
  const bu = isRight ? lu - 1 : lu;
  const bv = isBottom ? lv - 1 : lv;

  const isOuter = bu === 0 || bu === 6 || bv === 0 || bv === 6;
  if (isOuter) {
    return COLOR_BLACK;
  }

  const isMiddle = bu === 1 || bu === 5 || bv === 1 || bv === 5;
  const isBR = isRight && isBottom;

  if (isMiddle) {
    // Standard: Magenta; BR inverted: Cyan
    return isBR ? COLOR_CYAN : COLOR_MAGENTA;
  }

  // Core 3x3 (bu, bv in 2..4)
  // Standard: Cyan; BR inverted: Magenta
  return isBR ? COLOR_MAGENTA : COLOR_CYAN;
}

/**
 * Renders a full frame (4 stripe packets) into an RGBA buffer.
 *
 * @param {Uint8Array[]} stripePackets - 4 packets, each Uint8Array(542)
 * @param {object} [options]
 * @param {number} [options.scale=1] - Pixel scale s
 * @param {number} [options.rotation=0] - 0 or 90 degrees
 * @param {number} [options.corePx] - Core pixel size
 * @param {number} [options.guardPx] - Guard pixel size
 * @param {number} [options.cellPx] - Cell pixel size
 * @param {Uint8ClampedArray} [options.outRgba] - Optional preallocated buffer
 * @returns {{ width: number, height: number, rgba: Uint8ClampedArray, cellPx: number, corePx: number, guardPx: number }}
 */
export function renderFrame(stripePackets, options = {}) {
  const rotation = options.rotation === 90 ? 90 : 0;
  let corePx, guardPx, cellPx;
  if (options.corePx !== undefined && options.corePx !== null) {
    corePx = Math.max(1, options.corePx | 0);
    guardPx = options.guardPx !== undefined && options.guardPx !== null ? Math.max(0, options.guardPx | 0) : GUARD_BASE_PX;
    cellPx = options.cellPx !== undefined && options.cellPx !== null ? Math.max(corePx + 2 * guardPx, options.cellPx | 0) : (corePx + 2 * guardPx);
  } else if (options.cellPx !== undefined && options.cellPx !== null) {
    cellPx = Math.max(1, options.cellPx | 0);
    guardPx = options.guardPx !== undefined && options.guardPx !== null ? Math.max(0, options.guardPx | 0) : GUARD_BASE_PX;
    corePx = Math.max(1, cellPx - 2 * guardPx);
  } else {
    const scale = Math.max(1, (options.scale | 0) || 1);
    guardPx = options.guardPx !== undefined && options.guardPx !== null ? Math.max(0, options.guardPx | 0) : GUARD_BASE_PX * scale;
    corePx = CORE_BASE_PX * scale;
    cellPx = corePx + 2 * guardPx;
  }
  const imgDim = GRID_SIZE * cellPx;

  const totalBytes = imgDim * imgDim * 4;
  const rgba = (options.outRgba && options.outRgba.length === totalBytes)
    ? options.outRgba
    : new Uint8ClampedArray(totalBytes);
  // Fill entire background with black
  rgba.fill(0);
  // Set alpha channel to 255
  for (let i = 3; i < totalBytes; i += 4) {
    rgba[i] = 255;
  }

  const layout = getLayout();

  // Helper to paint a cell core (or solid block for finder)
  const paintRect = (x, y, w, h, color) => {
    const [r, g, b, a] = color;
    for (let py = y; py < y + h; py++) {
      let offset = (py * imgDim + x) * 4;
      for (let px = 0; px < w; px++) {
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = a;
        offset += 4;
      }
    }
  };

  // 1. Paint Finders (solid cells, no guard gaps)
  for (let v = 0; v < GRID_SIZE; v++) {
    for (let u = 0; u < GRID_SIZE; u++) {
      const idx = v * GRID_SIZE + u;
      if (layout.cellClass[idx] === 1 /* FINDER */) {
        const { u: ru, v: rv } = rotateCoords(u, v, rotation);
        const color = getFinderColor(u, v);
        paintRect(ru * cellPx, rv * cellPx, cellPx, cellPx, color);
      }
    }
  }

  // 2. Paint Timing Bars (8s x 8s core + guard)
  const paintTimingEdge = (edgeList) => {
    for (let i = 0; i < edgeList.length; i++) {
      const { r, c, isWhite } = edgeList[i];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation);
      const color = isWhite ? COLOR_WHITE : COLOR_FLOOR;
      paintRect(ru * cellPx + guardPx, rv * cellPx + guardPx, corePx, corePx, color);
    }
  };
  paintTimingEdge(layout.timingEdges.top);
  paintTimingEdge(layout.timingEdges.bottom);
  paintTimingEdge(layout.timingEdges.left);
  paintTimingEdge(layout.timingEdges.right);

  // 3. Paint Pilot Blocks
  // [W (255,255,255) | K (40,40,40)]
  // [C (40,255,255)  | M (255,40,255)]
  const pilotColors = [
    COLOR_WHITE,
    COLOR_FLOOR,
    [40, 255, 255, 255], // Cyan
    [255, 40, 255, 255]  // Magenta
  ];

  for (let i = 0; i < layout.pilotBlocks.length; i++) {
    const { r: rBase, c: cBase } = layout.pilotBlocks[i];
    const cellDefs = [
      { r: rBase, c: cBase, color: pilotColors[0] },
      { r: rBase, c: cBase + 1, color: pilotColors[1] },
      { r: rBase + 1, c: cBase, color: pilotColors[2] },
      { r: rBase + 1, c: cBase + 1, color: pilotColors[3] }
    ];
    for (let cd = 0; cd < 4; cd++) {
      const { r, c, color } = cellDefs[cd];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation);
      paintRect(ru * cellPx + guardPx, rv * cellPx + guardPx, corePx, corePx, color);
    }
  }

  // 4. Paint Data Stripes
  for (let s = 0; s < 4; s++) {
    const packet = stripePackets[s];
    const dataCells = layout.stripeDataCells[s];
    const symbols = bytesToSymbols(packet, 1446);

    let allSymbols = symbols;
    if (dataCells.length > 1446) {
      const fillCount = dataCells.length - 1446;
      const fill = getFillSymbols(s, fillCount);
      allSymbols = new Uint8Array(dataCells.length);
      allSymbols.set(symbols, 0);
      allSymbols.set(fill, 1446);
    }

    for (let cIdx = 0; cIdx < dataCells.length; cIdx++) {
      const { r, c } = dataCells[cIdx];
      const sym = allSymbols[cIdx];
      const color = SYMBOL_COLORS[sym];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation);
      paintRect(ru * cellPx + guardPx, rv * cellPx + guardPx, corePx, corePx, color);
    }
  }

  return { width: imgDim, height: imgDim, rgba, cellPx, corePx, guardPx };
}
