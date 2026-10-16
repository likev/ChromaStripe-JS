/**
 * ChromaStripe-JS v1 frozen constants and layout parameters.
 */

export const GRID_SIZE = 80;
export const TOTAL_CELLS = GRID_SIZE * GRID_SIZE; // 6,400

export const CELL_BASE_PX = 10;
export const CORE_BASE_PX = 8;
export const GUARD_BASE_PX = 1; // 1px guard on each side = 2px black between cores

export const QUIET_ZONE_CELLS = 2;
export const QUIET_ZONE_COLOR = [128, 128, 128, 255]; // Mid-gray

// Cell classification enums
export const CELL_TYPE = {
  DATA: 0,
  FINDER: 1,
  TIMING: 2,
  PILOT: 3
};

// Stripe row partitions: [startRow, endRow] inclusive
export const STRIPE_ROWS = [
  [0, 20],   // Height 21: 1,446 data cells
  [21, 39],  // Height 19: 1,466 data cells
  [40, 58],  // Height 19: 1,466 data cells
  [59, 79]   // Height 21: 1,446 data cells
];

export const STRIPE_DATA_CAPACITIES = [1446, 1466, 1466, 1446];
export const PACKET_CELL_CAPACITY = 1446; // Fixed packet capacity required
export const PACKET_TOTAL_BYTES = 542;
export const HEADER_BYTES = 12;
export const PAYLOAD_BYTES = 448; // 112 * 4 (Uint32Array(112))
export const RS_PARITY_BYTES = 82; // 28 + 27 + 27 across 3 interleaved codewords

// Colors (R, G, B, A)
export const COLOR_BLACK = [0, 0, 0, 255];
export const COLOR_WHITE = [255, 255, 255, 255];
export const COLOR_MAGENTA = [255, 0, 255, 255];
export const COLOR_CYAN = [0, 255, 255, 255];
export const COLOR_FLOOR = [40, 40, 40, 255];

// Data 3-bit symbol constellation: (b2 ? 255 : 40, b1 ? 255 : 40, b0 ? 255 : 40)
export const SYMBOL_COLORS = [
  [40, 40, 40, 255],     // 0: (0,0,0) Dark floor
  [40, 40, 255, 255],    // 1: (0,0,1) Blue
  [40, 255, 40, 255],    // 2: (0,1,0) Green
  [40, 255, 255, 255],   // 3: (0,1,1) Cyan
  [255, 40, 40, 255],    // 4: (1,0,0) Red
  [255, 40, 255, 255],   // 5: (1,0,1) Magenta
  [255, 255, 40, 255],   // 6: (1,1,0) Yellow
  [255, 255, 255, 255]   // 7: (1,1,1) White
];

// Protocol version
export const PROTOCOL_VERSION = 1;
export const MAGIC_MANIFEST = 'CSv1';
