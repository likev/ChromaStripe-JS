/**
 * Frame renderer: Paints 80x80 grid with finders, timing, pilots, guards, and 4 stripe packets into RGBA buffer.
 * Ultra-fast Uint32Array packed word writes with precomputed LUT and cell offset caches.
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
  SYMBOL_COLORS,
  SYMBOL_COLORS_6BIT,
  SYMBOL_COLORS_5BIT,
  PAM4_LEVELS
} from './constants.js';
import { getLayout, getLayoutV2, rotateCoords } from './layout.js';
import { bytesToSymbols, bytesToSymbolsMultiBit } from '../core/bitpack.js';
import { getFillSymbols } from './scrambler.js';

/**
 * Endianness-safe conversion of [R, G, B, A] into a 32-bit integer matching native Uint32Array memory layout.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=255]
 * @returns {number}
 */
export function makeRgbaU32(r, g, b, a = 255) {
  const buf = new ArrayBuffer(4);
  const u8 = new Uint8Array(buf);
  u8[0] = r;
  u8[1] = g;
  u8[2] = b;
  u8[3] = a;
  return new Uint32Array(buf)[0];
}

export const COLOR_BLACK_U32 = makeRgbaU32(...COLOR_BLACK);
export const COLOR_WHITE_U32 = makeRgbaU32(...COLOR_WHITE);
export const COLOR_MAGENTA_U32 = makeRgbaU32(...COLOR_MAGENTA);
export const COLOR_CYAN_U32 = makeRgbaU32(...COLOR_CYAN);
export const COLOR_FLOOR_U32 = makeRgbaU32(...COLOR_FLOOR);

export const PILOT_COLORS_U32 = [
  COLOR_WHITE_U32,
  COLOR_FLOOR_U32,
  makeRgbaU32(40, 255, 255, 255), // Cyan
  makeRgbaU32(255, 40, 255, 255)  // Magenta
];

export const PILOT_COLORS_4PAM_U32 = [
  makeRgbaU32(40, 40, 40, 255),
  makeRgbaU32(112, 112, 112, 255),
  makeRgbaU32(184, 184, 184, 255),
  makeRgbaU32(255, 255, 255, 255)
];

export const SYMBOL_COLORS_U32 = new Uint32Array(
  SYMBOL_COLORS.map(c => makeRgbaU32(...c))
);

export const SYMBOL_COLORS_6BIT_U32 = new Uint32Array(
  SYMBOL_COLORS_6BIT.map(c => makeRgbaU32(...c))
);

export const SYMBOL_COLORS_5BIT_U32 = new Uint32Array(
  SYMBOL_COLORS_5BIT.map(c => makeRgbaU32(...c))
);

/**
 * Determines 32-bit packed RGBA color for a finder cell (u, v) in logical space.
 */
function getFinderColorU32(u, v, gridSize = GRID_SIZE) {
  const isRight = u >= gridSize - 8;
  const isBottom = v >= gridSize - 8;

  const lu = isRight ? u - (gridSize - 8) : u;
  const lv = isBottom ? v - (gridSize - 8) : v;

  const isSeparator =
    (isRight ? lu === 0 : lu === 7) ||
    (isBottom ? lv === 0 : lv === 7);

  if (isSeparator) {
    return COLOR_BLACK_U32;
  }

  const bu = isRight ? lu - 1 : lu;
  const bv = isBottom ? lv - 1 : lv;

  const isOuter = bu === 0 || bu === 6 || bv === 0 || bv === 6;
  if (isOuter) {
    return COLOR_BLACK_U32;
  }

  const isMiddle = bu === 1 || bu === 5 || bv === 1 || bv === 5;
  const isBR = isRight && isBottom;

  if (isMiddle) {
    return isBR ? COLOR_CYAN_U32 : COLOR_MAGENTA_U32;
  }

  return isBR ? COLOR_MAGENTA_U32 : COLOR_CYAN_U32;
}

const TEMPLATE_CACHE = new Map();
const CELL_OFFSETS_CACHE = new Map();
const INITIALIZED_BUFFERS = new WeakMap();

// Zero-allocation scratch buffers for symbols per stripe
const SYMBOL_SCRATCH = Array.from({ length: 8 }, () => new Uint8Array(2000));

function getStaticTemplate(imgDim, cellPx, corePx, guardPx, rotation, layout = null, is4Pam = false) {
  const activeLayout = layout || getLayout();
  const gridSize = activeLayout.gridSize || GRID_SIZE;
  const key = `${imgDim}_${cellPx}_${corePx}_${guardPx}_${rotation}_${gridSize}_${is4Pam}`;
  let template = TEMPLATE_CACHE.get(key);
  if (template) return template;

  const totalBytes = imgDim * imgDim * 4;
  template = new Uint8ClampedArray(totalBytes);
  const templateU32 = new Uint32Array(template.buffer);

  // Fill entire background with black and alpha = 255 in one native fill
  templateU32.fill(COLOR_BLACK_U32);

  const paintRectU32 = (x, y, w, h, colorU32) => {
    for (let py = y; py < y + h; py++) {
      const offset = py * imgDim + x;
      templateU32.fill(colorU32, offset, offset + w);
    }
  };

  // 1. Paint Finders (solid cells, no guard gaps)
  for (let v = 0; v < gridSize; v++) {
    for (let u = 0; u < gridSize; u++) {
      const idx = v * gridSize + u;
      if (activeLayout.cellClass[idx] === 1 /* FINDER */) {
        const { u: ru, v: rv } = rotateCoords(u, v, rotation, gridSize);
        const colorU32 = getFinderColorU32(u, v, gridSize);
        paintRectU32(ru * cellPx, rv * cellPx, cellPx, cellPx, colorU32);
      }
    }
  }

  // 2. Paint Timing Bars (8s x 8s core + guard)
  const paintTimingEdge = (edgeList) => {
    for (let i = 0; i < edgeList.length; i++) {
      const { r, c, isWhite } = edgeList[i];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation, gridSize);
      const colorU32 = isWhite ? COLOR_WHITE_U32 : COLOR_FLOOR_U32;
      paintRectU32(ru * cellPx + guardPx, rv * cellPx + guardPx, corePx, corePx, colorU32);
    }
  };
  paintTimingEdge(activeLayout.timingEdges.top);
  paintTimingEdge(activeLayout.timingEdges.bottom);
  paintTimingEdge(activeLayout.timingEdges.left);
  paintTimingEdge(activeLayout.timingEdges.right);

  // 3. Paint Pilot Blocks
  const pilotColorTable = is4Pam ? PILOT_COLORS_4PAM_U32 : PILOT_COLORS_U32;
  for (let i = 0; i < activeLayout.pilotBlocks.length; i++) {
    const { r: rBase, c: cBase } = activeLayout.pilotBlocks[i];
    const cellDefs = [
      { r: rBase, c: cBase, colorU32: pilotColorTable[0] },
      { r: rBase, c: cBase + 1, colorU32: pilotColorTable[1] },
      { r: rBase + 1, c: cBase, colorU32: pilotColorTable[2] },
      { r: rBase + 1, c: cBase + 1, colorU32: pilotColorTable[3] }
    ];
    for (let cd = 0; cd < 4; cd++) {
      const { r, c, colorU32 } = cellDefs[cd];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation, gridSize);
      paintRectU32(ru * cellPx + guardPx, rv * cellPx + guardPx, corePx, corePx, colorU32);
    }
  }

  TEMPLATE_CACHE.set(key, template);
  return template;
}

/**
 * Precomputes and caches 1D pixel start offsets for every data cell.
 */
function getStripeCellOffsets(imgDim, cellPx, corePx, guardPx, rotation, layout = null) {
  const activeLayout = layout || getLayout();
  const gridSize = activeLayout.gridSize || GRID_SIZE;
  const numStripes = activeLayout.numStripes || 4;
  const key = `${imgDim}_${cellPx}_${corePx}_${guardPx}_${rotation}_${gridSize}_${numStripes}`;
  let offsets = CELL_OFFSETS_CACHE.get(key);
  if (offsets) return offsets;

  offsets = new Array(numStripes);
  for (let s = 0; s < numStripes; s++) {
    const dataCells = activeLayout.stripeDataCells[s];
    const n = dataCells.length;
    const startOffsets = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const { r, c } = dataCells[i];
      const { u: ru, v: rv } = rotateCoords(c, r, rotation, gridSize);
      const x = ru * cellPx + guardPx;
      const y = rv * cellPx + guardPx;
      startOffsets[i] = y * imgDim + x;
    }
    offsets[s] = startOffsets;
  }
  CELL_OFFSETS_CACHE.set(key, offsets);
  return offsets;
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
  const version = options.version ?? (stripePackets.length === 8 ? 2 : 1);
  const gridSize = options.gridSize ?? (options.layout?.gridSize ?? GRID_SIZE);
  const numStripes = options.numStripes ?? stripePackets.length;
  const bitsPerCell = options.bitsPerCell ?? (version === 2 ? 6 : 3);
  const is4Pam = bitsPerCell >= 5;
  const colorLutU32 = (bitsPerCell === 6)
    ? SYMBOL_COLORS_6BIT_U32
    : (bitsPerCell === 5 ? SYMBOL_COLORS_5BIT_U32 : SYMBOL_COLORS_U32);
  const fallbackColors = (bitsPerCell === 6)
    ? SYMBOL_COLORS_6BIT
    : (bitsPerCell === 5 ? SYMBOL_COLORS_5BIT : SYMBOL_COLORS);

  const layout = options.layout || (
    (version === 2 || numStripes === 8 || gridSize !== GRID_SIZE)
      ? getLayoutV2({ gridSize, numStripes })
      : getLayout()
  );

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
  const imgDim = layout.gridSize * cellPx;
  const totalBytes = imgDim * imgDim * 4;
  const templateKey = `${imgDim}_${cellPx}_${corePx}_${guardPx}_${rotation}_${layout.gridSize}_${is4Pam}`;

  const rgba = (options.outRgba && options.outRgba.length === totalBytes)
    ? options.outRgba
    : new Uint8ClampedArray(totalBytes);

  const staticTemplate = getStaticTemplate(imgDim, cellPx, corePx, guardPx, rotation, layout, is4Pam);

  // If the provided buffer has already been initialized with this static template,
  // skip copying template to save ~2.5 MB of memory operations per frame.
  if (INITIALIZED_BUFFERS.get(rgba) !== templateKey) {
    rgba.set(staticTemplate);
    INITIALIZED_BUFFERS.set(rgba, templateKey);
  }

  const stripeOffsets = getStripeCellOffsets(imgDim, cellPx, corePx, guardPx, rotation, layout);

  // View buffer as Uint32Array for ultra-fast word stores
  const rgbaU32 = (rgba.byteOffset % 4 === 0)
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2)
    : null;

  // 4. Paint Data Stripes
  for (let s = 0; s < layout.numStripes; s++) {
    const packet = stripePackets[s];
    if (!packet) continue;
    const dataCells = layout.stripeDataCells[s];
    const n = dataCells.length;

    let scratch = SYMBOL_SCRATCH[s];
    if (!scratch || scratch.length < n) {
      scratch = new Uint8Array(n);
      SYMBOL_SCRATCH[s] = scratch;
    }

    if (bitsPerCell === 3 && n > 1446 && stripePackets.length === 4) {
      bytesToSymbols(packet, 1446, scratch);
      const fillCount = n - 1446;
      const fill = getFillSymbols(s, fillCount);
      scratch.set(fill, 1446);
    } else {
      bytesToSymbolsMultiBit(packet, bitsPerCell, n, scratch);
    }

    const startOffsets = stripeOffsets[s];

    if (rgbaU32) {
      // Fast path: 32-bit packed word stores
      if (corePx === 1) {
        for (let i = 0; i < n; i++) {
          rgbaU32[startOffsets[i]] = colorLutU32[scratch[i]];
        }
      } else if (corePx === 2) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          const off = startOffsets[i];
          rgbaU32[off] = cU32;
          rgbaU32[off + 1] = cU32;
          const off2 = off + imgDim;
          rgbaU32[off2] = cU32;
          rgbaU32[off2 + 1] = cU32;
        }
      } else if (corePx === 3) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32;
          off += imgDim;
          rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32;
          off += imgDim;
          rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32;
        }
      } else if (corePx === 4) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < 4; dy++) {
            rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32; rgbaU32[off + 3] = cU32;
            off += imgDim;
          }
        }
      } else if (corePx === 5) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < 5; dy++) {
            rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32; rgbaU32[off + 3] = cU32; rgbaU32[off + 4] = cU32;
            off += imgDim;
          }
        }
      } else if (corePx === 6) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < 6; dy++) {
            rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32; rgbaU32[off + 3] = cU32; rgbaU32[off + 4] = cU32; rgbaU32[off + 5] = cU32;
            off += imgDim;
          }
        }
      } else if (corePx === 7) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < 7; dy++) {
            rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32; rgbaU32[off + 3] = cU32; rgbaU32[off + 4] = cU32; rgbaU32[off + 5] = cU32; rgbaU32[off + 6] = cU32;
            off += imgDim;
          }
        }
      } else if (corePx === 8) {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < 8; dy++) {
            rgbaU32[off] = cU32; rgbaU32[off + 1] = cU32; rgbaU32[off + 2] = cU32; rgbaU32[off + 3] = cU32;
            rgbaU32[off + 4] = cU32; rgbaU32[off + 5] = cU32; rgbaU32[off + 6] = cU32; rgbaU32[off + 7] = cU32;
            off += imgDim;
          }
        }
      } else {
        for (let i = 0; i < n; i++) {
          const cU32 = colorLutU32[scratch[i]];
          let off = startOffsets[i];
          for (let dy = 0; dy < corePx; dy++) {
            for (let dx = 0; dx < corePx; dx++) {
              rgbaU32[off + dx] = cU32;
            }
            off += imgDim;
          }
        }
      }
    } else {
      // Fallback path for unaligned Uint8ClampedArray
      for (let i = 0; i < n; i++) {
        const [r, g, b, a] = fallbackColors[scratch[i]];
        let off = startOffsets[i] * 4;
        for (let dy = 0; dy < corePx; dy++) {
          let lineOff = off;
          for (let dx = 0; dx < corePx; dx++) {
            rgba[lineOff] = r;
            rgba[lineOff + 1] = g;
            rgba[lineOff + 2] = b;
            rgba[lineOff + 3] = a;
            lineOff += 4;
          }
          off += imgDim * 4;
        }
      }
    }
  }

  return { width: imgDim, height: imgDim, rgba, cellPx, corePx, guardPx };
}
