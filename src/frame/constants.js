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

// Protocol Version 2 (Evolution)
export const PROTOCOL_VERSION_V2 = 2;
export const MAGIC_MANIFEST_V2 = 'CSv2';

export const SUPPORTED_GRID_SIZES = [80, 96, 112];
export const MODULATION_MODES = {
  RGB_3BIT: 3,
  PAM_5BIT: 5,
  PAM_6BIT: 6
};

export const RS_RATE_MODES = {
  STANDARD: 0,
  HIGH_RATE: 1
};

export const V2_NUM_STRIPES = 8;
export const V2_PAYLOAD_WORDS = 56;
export const V2_PAYLOAD_BYTES = 224; // 56 * 4

// V2 Single-Codeword RS (N <= 255)
// Data = 12 (header) + 224 (payload) = 236 bytes
export const V2_RS_PARITY_HIGH_RATE = 14; // t = 7, total packet = 250 bytes
export const V2_RS_PARITY_STANDARD = 18;  // t = 9, total packet = 254 bytes
export const V2_PACKET_BYTES_HIGH_RATE = 250;
export const V2_PACKET_BYTES_STANDARD = 254;

// V2 Turbo High-Throughput (N <= 255 per codeword, 2 interleaved codewords)
// Data = 12 (header) + 448 (payload) = 460 bytes (2x 230 bytes)
export const V2_TURBO_PAYLOAD_WORDS = 112;
export const V2_TURBO_PAYLOAD_BYTES = 448;
export const V2_TURBO_PACKET_BYTES_HIGH_RATE = 488;
export const V2_TURBO_PACKET_BYTES_STANDARD = 496;

// 4-PAM Gray-coded levels & thresholds:
// Gray mapping: 00 -> 40, 01 -> 112, 11 -> 184, 10 -> 255
export const PAM4_LEVELS = [40, 112, 184, 255];
export const PAM4_GRAY_TO_LEVEL = [0, 1, 3, 2];
export const PAM4_LEVEL_TO_GRAY = [0, 1, 3, 2];
export const PAM4_THRESHOLDS = [76, 148, 220]; // (40+112)/2, (112+184)/2, (184+255)/2

// 64-state [4x4x4] 6-bit constellation (R: 4-PAM, G: 4-PAM, B: 4-PAM)
export const SYMBOL_COLORS_6BIT = Array.from({ length: 64 }, (_, s) => {
  const bR = (s >>> 4) & 3;
  const bG = (s >>> 2) & 3;
  const bB = s & 3;
  return [
    PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bR]],
    PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bG]],
    PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bB]],
    255
  ];
});

// 32-state [4x4x2] 5-bit constellation (R: 4-PAM, G: 4-PAM, B: 2-PAM)
export const SYMBOL_COLORS_5BIT = Array.from({ length: 32 }, (_, s) => {
  const bR = (s >>> 3) & 3;
  const bG = (s >>> 1) & 3;
  const bB = s & 1;
  return [
    PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bR]],
    PAM4_LEVELS[PAM4_GRAY_TO_LEVEL[bG]],
    bB ? 255 : 40,
    255
  ];
});

