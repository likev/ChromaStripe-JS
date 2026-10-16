/**
 * Direct Linear Transform (DLT) 4-point homography solver and projection.
 */

/**
 * Solves 3x3 projective homography matrix H mapping canonical finder centers
 * [(3.5, 3.5), (76.5, 3.5), (3.5, 76.5), (76.5, 76.5)] (TL, TR, BL, BR)
 * to observed camera coordinates [tl, tr, bl, br].
 *
 * @param {Array<{x: number, y: number}>} corners - [TL, TR, BL, BR] in camera pixels
 * @returns {Float64Array | null} 8 parameters [h00, h01, h02, h10, h11, h12, h20, h21]
 */
export function solveHomography(corners) {
  if (!corners || corners.length !== 4) return null;

  const src = [
    [3.5, 3.5],   // TL
    [76.5, 3.5],  // TR
    [3.5, 76.5],  // BL
    [76.5, 76.5]  // BR
  ];

  // 8x8 linear system: A * h = b
  const A = Array.from({ length: 8 }, () => new Float64Array(8));
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const { x, y } = corners[i];

    // Row 2*i: equation for x
    A[2 * i][0] = u;
    A[2 * i][1] = v;
    A[2 * i][2] = 1;
    A[2 * i][6] = -u * x;
    A[2 * i][7] = -v * x;
    b[2 * i] = x;

    // Row 2*i+1: equation for y
    A[2 * i + 1][3] = u;
    A[2 * i + 1][4] = v;
    A[2 * i + 1][5] = 1;
    A[2 * i + 1][6] = -u * y;
    A[2 * i + 1][7] = -v * y;
    b[2 * i + 1] = y;
  }

  // Gaussian elimination with partial pivoting on 8x8 system
  for (let col = 0; col < 8; col++) {
    let maxRow = col;
    let maxVal = Math.abs(A[col][col]);
    for (let r = col + 1; r < 8; r++) {
      const val = Math.abs(A[r][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }

    if (maxVal < 1e-12) return null; // Degenerate geometry

    // Swap pivot row
    if (maxRow !== col) {
      const tempRow = A[col];
      A[col] = A[maxRow];
      A[maxRow] = tempRow;

      const tempB = b[col];
      b[col] = b[maxRow];
      b[maxRow] = tempB;
    }

    const pivot = A[col][col];
    for (let r = col + 1; r < 8; r++) {
      const factor = A[r][col] / pivot;
      for (let c = col; c < 8; c++) {
        A[r][c] -= factor * A[col][c];
      }
      b[r] -= factor * b[col];
    }
  }

  // Back-substitution
  const h = new Float64Array(8);
  for (let r = 7; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < 8; c++) {
      sum -= A[r][c] * h[c];
    }
    h[r] = sum / A[r][r];
  }

  return h;
}

/**
 * Projects logical grid coordinates (u, v) into camera coordinates (x, y) using homography.
 *
 * @param {Float64Array|number[]} H - [h00, h01, h02, h10, h11, h12, h20, h21]
 * @param {number} u
 * @param {number} v
 * @returns {{ x: number, y: number }}
 */
export function projectH(H, u, v) {
  const denom = 1.0 / (H[6] * u + H[7] * v + 1.0);
  const x = (H[0] * u + H[1] * v + H[2]) * denom;
  const y = (H[3] * u + H[4] * v + H[5]) * denom;
  return { x, y };
}
