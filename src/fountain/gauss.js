/**
 * Inactivation Gaussian Elimination over GF(2) using bit-packed rows.
 */

/**
 * Solves a system of M linear equations with N unknowns over GF(2) with 112-word RHS.
 *
 * @param {Array<{ mask: Uint32Array, rhs: Uint32Array }>} equations - List of equations
 * @param {number} numUnknowns - Number of unknowns (N)
 * @returns {{ success: boolean, rank: number, solution?: Uint32Array[] }}
 */
export function solveBinarySystem(equations, numUnknowns) {
  const numEqs = equations.length;
  if (numEqs === 0) {
    return { success: false, rank: 0, partialSolutions: [], reducedEquations: [] };
  }

  const numWords = Math.ceil(numUnknowns / 32);

  // Copy equations to avoid mutating inputs
  const matrix = new Array(numEqs);
  const rhs = new Array(numEqs);

  for (let i = 0; i < numEqs; i++) {
    matrix[i] = new Uint32Array(equations[i].mask);
    rhs[i] = new Uint32Array(equations[i].rhs);
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
      // No pivot found for this unknown
      continue;
    }

    // Swap pivot row into position 'rank'
    if (pivotRow !== rank) {
      const tempM = matrix[rank];
      matrix[rank] = matrix[pivotRow];
      matrix[pivotRow] = tempM;

      const tempR = rhs[rank];
      rhs[rank] = rhs[pivotRow];
      rhs[pivotRow] = tempR;
    }

    const pRow = matrix[rank];
    const pRhs = rhs[rank];

    // Eliminate bit in all other rows
    for (let r = 0; r < numEqs; r++) {
      if (r !== rank && (matrix[r][wordIdx] & bitMask) !== 0) {
        const row = matrix[r];
        const rowRhs = rhs[r];

        for (let w = wordIdx; w < numWords; w++) {
          row[w] ^= pRow[w];
        }
        for (let w = 0; w < 112; w++) {
          rowRhs[w] ^= pRhs[w];
        }
      }
    }

    rank++;
    if (rank === numUnknowns) {
      break;
    }
  }

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
      partialSolutions.push({ col: activeCols[0], value: rhs[r] });
    } else if (activeCols.length > 1) {
      reducedEquations.push({ cols: activeCols, mask: matrix[r], rhs: rhs[r] });
    }
  }

  // Consistency check: rows with all-zero mask must have all-zero rhs
  for (let r = rank; r < numEqs; r++) {
    for (let w = 0; w < 112; w++) {
      if (rhs[r][w] !== 0) {
        return { success: false, rank, partialSolutions, reducedEquations };
      }
    }
  }

  if (rank < numUnknowns) {
    return { success: false, rank, partialSolutions, reducedEquations };
  }

  // Each row i (0 <= i < numUnknowns) is now a single unknown
  const solution = new Array(numUnknowns);
  for (let i = 0; i < numUnknowns; i++) {
    solution[i] = rhs[i];
  }

  return { success: true, rank, solution, partialSolutions, reducedEquations };
}
