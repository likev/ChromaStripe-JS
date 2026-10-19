/**
 * Inactivation Gaussian Elimination over GF(2) using bit-packed rows with lazy-RHS evaluation.
 */

/**
 * Solves a system of M linear equations with N unknowns over GF(2) with 112-word RHS.
 * Uses an M-bit row transformation history bitmask H to eliminate rows without touching
 * the 112-word payloads, only evaluating RHS combinations for rows that yield solutions.
 *
 * @param {Array<{ mask: Uint32Array, rhs: Uint32Array }>} equations - List of equations
 * @param {number} numUnknowns - Number of unknowns (N)
 * @returns {{
 *   success: boolean,
 *   rank: number,
 *   solution?: Uint32Array[],
 *   partialSolutions: Array<{col: number, value: Uint32Array}>,
 *   reducedEquations: Array<{cols: number[], mask: Uint32Array, rhs: Uint32Array}>
 * }}
 */
export function solveBinarySystem(equations, numUnknowns) {
  const numEqs = equations.length;
  if (numEqs === 0) {
    return { success: false, rank: 0, partialSolutions: [], reducedEquations: [] };
  }

  const numWords = Math.ceil(numUnknowns / 32);
  const numWordsH = Math.ceil(numEqs / 32);

  // Copy matrix masks and initialize identity history matrix H
  const matrix = new Array(numEqs);
  const H = new Array(numEqs);

  for (let i = 0; i < numEqs; i++) {
    matrix[i] = new Uint32Array(equations[i].mask);
    const hRow = new Uint32Array(numWordsH);
    hRow[i >>> 5] |= (1 << (i & 31));
    H[i] = hRow;
  }

  let rank = 0;

  for (let col = 0; col < numUnknowns; col++) {
    const wordIdx = col >>> 5;
    const bitMask = 1 << (col & 31);

    // Find pivot row
    let pivotRow = -1;
    for (let r = rank; r < numEqs; r++) {
      if ((matrix[r][wordIdx] & bitMask) !== 0) {
        pivotRow = r;
        break;
      }
    }

    if (pivotRow === -1) {
      continue;
    }

    // Swap pivot row into position 'rank'
    if (pivotRow !== rank) {
      const tempM = matrix[rank];
      matrix[rank] = matrix[pivotRow];
      matrix[pivotRow] = tempM;

      const tempH = H[rank];
      H[rank] = H[pivotRow];
      H[pivotRow] = tempH;
    }

    const pRow = matrix[rank];
    const pH = H[rank];

    // Eliminate bit in all other rows
    for (let r = 0; r < numEqs; r++) {
      if (r !== rank && (matrix[r][wordIdx] & bitMask) !== 0) {
        const row = matrix[r];
        const rowH = H[r];

        for (let w = wordIdx; w < numWords; w++) {
          row[w] ^= pRow[w];
        }
        for (let w = 0; w < numWordsH; w++) {
          rowH[w] ^= pH[w];
        }
      }
    }

    rank++;
    if (rank === numUnknowns) {
      break;
    }
  }

  // Lazy RHS evaluation helper: evaluates the linear combination of original RHS payloads
  const words = equations[0]?.rhs?.length || 112;
  const evalRhs = (hRow) => {
    const out = new Uint32Array(words);
    for (let i = 0; i < numEqs; i++) {
      if ((hRow[i >>> 5] & (1 << (i & 31))) !== 0) {
        const eqRhs = equations[i].rhs;
        for (let w = 0; w < words; w++) {
          out[w] ^= eqRhs[w];
        }
      }
    }
    return out;
  };

  // Collect solutions and reduced equations from reduced row echelon form
  const partialSolutions = [];
  const reducedEquations = [];

  for (let r = 0; r < rank; r++) {
    const activeCols = [];
    for (let c = 0; c < numUnknowns; c++) {
      if ((matrix[r][c >>> 5] & (1 << (c & 31))) !== 0) {
        activeCols.push(c);
      }
    }
    if (activeCols.length === 1) {
      partialSolutions.push({ col: activeCols[0], value: evalRhs(H[r]) });
    } else if (activeCols.length > 1) {
      reducedEquations.push({ cols: activeCols, mask: matrix[r], rhs: evalRhs(H[r]) });
    }
  }

  // Consistency check: rows with all-zero mask must evaluate to all-zero RHS
  for (let r = rank; r < numEqs; r++) {
    let hasH = false;
    for (let w = 0; w < numWordsH; w++) {
      if (H[r][w] !== 0) {
        hasH = true;
        break;
      }
    }
    if (hasH) {
      const rowRhs = evalRhs(H[r]);
      for (let w = 0; w < words; w++) {
        if (rowRhs[w] !== 0) {
          return { success: false, rank, partialSolutions, reducedEquations };
        }
      }
    }
  }

  if (rank < numUnknowns) {
    return { success: false, rank, partialSolutions, reducedEquations };
  }

  // When rank === numUnknowns, each solved row has exactly one active column
  const solution = new Array(numUnknowns);
  for (let i = 0; i < partialSolutions.length; i++) {
    const { col, value } = partialSolutions[i];
    solution[col] = value;
  }

  return { success: true, rank, solution, partialSolutions, reducedEquations };
}
