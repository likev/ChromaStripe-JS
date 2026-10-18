/**
 * Reed-Solomon encoder & decoder over GF(256) with primitive poly 0x11D.
 * Generator roots: alpha^0 ... alpha^(nsym - 1).
 */

import { EXP, LOG, gfMul, gfDiv, gfAdd, gfInv } from './gf256.js';

// Cache generator polynomials for common parity lengths
const GEN_CACHE = new Map();

/**
 * Computes generator polynomial g(x) = prod_{i=0}^{nsym-1} (x - alpha^i).
 * Roots are alpha^0 ... alpha^(nsym-1).
 * g is returned as Uint8Array of length nsym + 1, with g[0] = 1 (leading x^nsym).
 * @param {number} nsym - Number of parity symbols
 * @returns {Uint8Array}
 */
export function getGeneratorPoly(nsym) {
  if (GEN_CACHE.has(nsym)) {
    return GEN_CACHE.get(nsym);
  }
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    const root = EXP[i];
    const nextG = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      nextG[j] ^= g[j];
      nextG[j + 1] ^= gfMul(g[j], root);
    }
    g = nextG;
  }
  const result = new Uint8Array(g);
  GEN_CACHE.set(nsym, result);
  return result;
}

/**
 * Systematic RS encoding: computes nsym parity bytes for data.
 * @param {Uint8Array} data - Data bytes (k)
 * @param {number} nsym - Parity length (n - k)
 * @param {Uint8Array} [outParity] - Optional preallocated buffer of length nsym
 * @returns {Uint8Array} nsym parity bytes
 */
export function rsEncode(data, nsym, outParity) {
  const g = getGeneratorPoly(nsym);
  const parity = outParity || new Uint8Array(nsym);
  parity.fill(0);

  const k = data.length;
  for (let i = 0; i < k; i++) {
    const feedback = data[i] ^ parity[0];
    if (feedback !== 0) {
      for (let j = 1; j < nsym; j++) {
        parity[j - 1] = parity[j] ^ gfMul(g[j], feedback);
      }
      parity[nsym - 1] = gfMul(g[nsym], feedback);
    } else {
      for (let j = 1; j < nsym; j++) {
        parity[j - 1] = parity[j];
      }
      parity[nsym - 1] = 0;
    }
  }
  return parity;
}

/**
 * Computes syndrome polynomial S(x) = sum_{i=0}^{nsym-1} S_i x^i
 * S_i = c(alpha^i).
 * @param {Uint8Array} codeword - Codeword of length n
 * @param {number} nsym
 * @returns {Uint8Array} Array of nsym syndromes
 */
export function rsSyndromes(codeword, nsym) {
  const s = new Uint8Array(nsym);
  const n = codeword.length;
  let hasError = false;

  for (let i = 0; i < nsym; i++) {
    const alpha_i = EXP[i];
    let val = 0;
    for (let j = 0; j < n; j++) {
      val = codeword[j] ^ gfMul(val, alpha_i);
    }
    s[i] = val;
    if (val !== 0) hasError = true;
  }

  return hasError ? s : null;
}

/**
 * Berlekamp-Massey algorithm to find error locator polynomial Lambda(x).
 * @param {Uint8Array} s - Syndromes (length nsym)
 * @param {number} nsym
 * @returns {{ lambda: Uint8Array, degree: number } | null}
 */
function berlekampMassey(s, nsym) {
  let c = [1];
  let b = [1];
  let l = 0;
  let m = 1;
  let bVal = 1;

  for (let n = 0; n < nsym; n++) {
    let d = s[n];
    for (let i = 1; i <= l; i++) {
      if (c[i]) {
        d ^= gfMul(c[i], s[n - i]);
      }
    }

    if (d === 0) {
      m++;
    } else {
      const t = c.slice();
      const coeff = gfDiv(d, bVal);

      while (c.length < b.length + m) {
        c.push(0);
      }
      for (let i = 0; i < b.length; i++) {
        if (b[i]) {
          c[i + m] ^= gfMul(coeff, b[i]);
        }
      }

      if (2 * l <= n) {
        l = n + 1 - l;
        b = t;
        bVal = d;
        m = 1;
      } else {
        m++;
      }
    }
  }

  // Trim trailing zeros
  while (c.length > 0 && c[c.length - 1] === 0) {
    c.pop();
  }

  const degree = c.length - 1;
  if (degree * 2 > nsym) {
    return null; // More errors than error-correcting capability
  }

  return { lambda: new Uint8Array(c), degree };
}

/**
 * Chien search: finds error positions (roots of Lambda(x)).
 * @param {Uint8Array} lambda - Error locator poly: Lambda(x) = 1 + l1 x + ...
 * @param {number} n - Codeword length
 * @param {number} expectedErrors - Expected number of roots
 * @returns {number[] | null} Array of error indices [0..n-1], or null if mismatch
 */
function chienSearch(lambda, n, expectedErrors) {
  const errPos = [];
  const deg = lambda.length - 1;

  for (let pos = 0; pos < n; pos++) {
    // Evaluation point: x = alpha^{-(n - 1 - pos)}
    const expVal = (255 - ((n - 1 - pos) % 255)) % 255;
    const invX = EXP[expVal];

    // Evaluate Lambda(invX) = 1 + l1*invX + l2*(invX)^2 + ...
    let sum = 1;
    let xPow = 1;
    for (let j = 1; j <= deg; j++) {
      xPow = gfMul(xPow, invX);
      if (lambda[j]) {
        sum ^= gfMul(lambda[j], xPow);
      }
    }

    if (sum === 0) {
      errPos.push(pos);
    }
  }

  if (errPos.length !== expectedErrors) {
    return null;
  }
  return errPos;
}

/**
 * Forney algorithm to compute error values and correct codeword.
 * Generator roots start at alpha^0 (b_0 = 0), so X_i^{1 - 0} = X_i.
 *
 * @param {Uint8Array} codeword
 * @param {Uint8Array} syndromes
 * @param {Uint8Array} lambda
 * @param {number[]} errPos
 * @returns {boolean} true on success
 */
function forneyCorrection(codeword, syndromes, lambda, errPos) {
  const nsym = syndromes.length;
  const n = codeword.length;

  // Omega(x) = (S(x) * Lambda(x)) mod x^nsym
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let sum = 0;
    for (let j = 0; j <= i && j < lambda.length; j++) {
      if (lambda[j] && syndromes[i - j]) {
        sum ^= gfMul(lambda[j], syndromes[i - j]);
      }
    }
    omega[i] = sum;
  }

  for (let idx = 0; idx < errPos.length; idx++) {
    const pos = errPos[idx];
    const power = (n - 1 - pos) % 255;
    const Xi = EXP[power]; // Xi = alpha^(n - 1 - pos)
    const invXi = EXP[(255 - power) % 255]; // Xi^-1

    // Evaluate Omega(Xi^-1)
    let num = 0;
    let invXiPow = 1;
    for (let j = 0; j < nsym; j++) {
      if (omega[j]) {
        num ^= gfMul(omega[j], invXiPow);
      }
      invXiPow = gfMul(invXiPow, invXi);
    }

    // Evaluate Lambda'(Xi^-1) = sum_{k odd} lambda[k] * (Xi^-1)^(k - 1)
    let den = 0;
    let invXiKMinus1 = 1;
    for (let k = 1; k < lambda.length; k += 2) {
      if (lambda[k]) {
        den ^= gfMul(lambda[k], invXiKMinus1);
      }
      // Advance by (Xi^-1)^2
      if (k + 2 < lambda.length) {
        invXiKMinus1 = gfMul(invXiKMinus1, gfMul(invXi, invXi));
      }
    }

    if (den === 0) {
      return false;
    }

    // Y_i = (Xi * Omega(Xi^-1)) / Lambda'(Xi^-1)
    const errVal = gfMul(Xi, gfDiv(num, den));
    codeword[pos] ^= errVal;
  }

  return true;
}

/**
 * Polynomial multiplication in GF(256).
 */
function polyMul(p, q) {
  const res = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    if (!p[i]) continue;
    for (let j = 0; j < q.length; j++) {
      if (!q[j]) continue;
      res[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return res;
}

/**
 * Error-and-Erasure Reed-Solomon Decoder using Forney modified syndromes.
 * Corrects up to 2t + e <= nsym (where e = erasures.length, t = errors.length).
 *
 * @param {Uint8Array} codeword
 * @param {number} nsym
 * @param {number[]} [erasures=[]]
 * @param {boolean} [inPlace=false]
 * @returns {{ ok: boolean, corrected: number, codeword: Uint8Array }}
 */
export function rsDecodeErrata(codeword, nsym, erasures = [], inPlace = false) {
  const cw = inPlace ? codeword : new Uint8Array(codeword);
  const n = cw.length;
  const uniqueErasures = [...new Set(erasures)].filter(p => p >= 0 && p < n);
  const numErasures = uniqueErasures.length;

  if (numErasures > nsym) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  const syndromes = rsSyndromes(cw, nsym);
  if (!syndromes) {
    return { ok: true, corrected: 0, codeword: cw };
  }

  if (numErasures === 0) {
    return rsDecode(cw, nsym, true);
  }

  // 1. Compute erasure locator polynomial Gamma(x) = prod_{i=0}^{numErasures-1} (1 - X_i * x)
  let gamma = new Uint8Array([1]);
  for (let i = 0; i < numErasures; i++) {
    const pos = uniqueErasures[i];
    const power = (n - 1 - pos) % 255;
    const Xi = EXP[power];
    gamma = polyMul(gamma, new Uint8Array([1, Xi]));
  }

  // 2. Compute Forney modified syndromes: Xi(x) = (S(x) * Gamma(x)) mod x^nsym
  const modSyn = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let sum = 0;
    for (let j = 0; j <= i && j < gamma.length; j++) {
      if (gamma[j] && syndromes[i - j]) {
        sum ^= gfMul(gamma[j], syndromes[i - j]);
      }
    }
    modSyn[i] = sum;
  }

  // 3. Berlekamp-Massey on modified syndromes to find error locator lambda_err(x)
  let c = [1];
  let b = [1];
  let l = 0;
  let m = 1;
  let bVal = 1;

  for (let step = numErasures; step < nsym; step++) {
    let d = modSyn[step];
    for (let i = 1; i <= l; i++) {
      if (c[i] && (step - i) >= 0) {
        d ^= gfMul(c[i], modSyn[step - i]);
      }
    }

    if (d === 0) {
      m++;
    } else {
      const t = c.slice();
      const coeff = gfDiv(d, bVal);
      while (c.length < b.length + m) c.push(0);
      for (let i = 0; i < b.length; i++) {
        if (b[i]) c[i + m] ^= gfMul(coeff, b[i]);
      }
      if (2 * l <= step - numErasures) {
        l = step + 1 - numErasures - l;
        b = t;
        bVal = d;
        m = 1;
      } else {
        m++;
      }
    }
  }

  while (c.length > 0 && c[c.length - 1] === 0) c.pop();
  const numErrors = c.length - 1;

  // Bound check: 2 * numErrors + numErasures <= nsym
  if (2 * numErrors + numErasures > nsym) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  // 4. Combined locator poly: Lambda(x) = Gamma(x) * Lambda_err(x)
  const lambda = polyMul(gamma, new Uint8Array(c));

  // 5. Find error positions (roots of Lambda_err)
  const allPositions = uniqueErasures.slice();
  if (numErrors > 0) {
    const lambdaErr = new Uint8Array(c);
    const errPos = [];
    for (let pos = 0; pos < n; pos++) {
      if (uniqueErasures.includes(pos)) continue;
      const expVal = (255 - ((n - 1 - pos) % 255)) % 255;
      const invX = EXP[expVal];
      let sum = 1;
      let xPow = 1;
      for (let j = 1; j <= numErrors; j++) {
        xPow = gfMul(xPow, invX);
        if (lambdaErr[j]) sum ^= gfMul(lambdaErr[j], xPow);
      }
      if (sum === 0) {
        errPos.push(pos);
      }
    }
    if (errPos.length !== numErrors) {
      return { ok: false, corrected: 0, codeword: cw };
    }
    allPositions.push(...errPos);
  }

  // 6. Forney algorithm to compute error values using combined Lambda(x)
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let sum = 0;
    for (let j = 0; j <= i && j < lambda.length; j++) {
      if (lambda[j] && syndromes[i - j]) {
        sum ^= gfMul(lambda[j], syndromes[i - j]);
      }
    }
    omega[i] = sum;
  }

  for (let idx = 0; idx < allPositions.length; idx++) {
    const pos = allPositions[idx];
    const power = (n - 1 - pos) % 255;
    const Xi = EXP[power];
    const invXi = EXP[(255 - power) % 255];

    let num = 0;
    let invXiPow = 1;
    for (let j = 0; j < nsym; j++) {
      if (omega[j]) num ^= gfMul(omega[j], invXiPow);
      invXiPow = gfMul(invXiPow, invXi);
    }

    let den = 0;
    let invXiKMinus1 = 1;
    for (let k = 1; k < lambda.length; k += 2) {
      if (lambda[k]) den ^= gfMul(lambda[k], invXiKMinus1);
      if (k + 2 < lambda.length) {
        invXiKMinus1 = gfMul(invXiKMinus1, gfMul(invXi, invXi));
      }
    }

    if (den === 0) return { ok: false, corrected: 0, codeword: cw };
    const errVal = gfMul(Xi, gfDiv(num, den));
    cw[pos] ^= errVal;
  }

  // Verify syndromes are zero
  const post = rsSyndromes(cw, nsym);
  if (post !== null) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  return { ok: true, corrected: allPositions.length, codeword: cw };
}

/**
 * Decodes Reed-Solomon codeword in-place or returns a corrected copy.
 * Supports optional erasure list via Forney modified syndromes.
 *
 * @param {Uint8Array} codeword - Codeword of length n
 * @param {number} nsym - Number of parity symbols
 * @param {boolean} [inPlace=false]
 * @param {number[]} [erasures=[]] - Optional known erasure positions
 * @returns {{ ok: boolean, corrected: number, codeword: Uint8Array }}
 */
export function rsDecode(codeword, nsym, inPlace = false, erasures = []) {
  if (erasures && erasures.length > 0) {
    return rsDecodeErrata(codeword, nsym, erasures, inPlace);
  }

  const cw = inPlace ? codeword : new Uint8Array(codeword);
  const syndromes = rsSyndromes(cw, nsym);

  // No errors detected
  if (!syndromes) {
    return { ok: true, corrected: 0, codeword: cw };
  }

  const bm = berlekampMassey(syndromes, nsym);
  if (!bm || bm.degree === 0) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  const errPos = chienSearch(bm.lambda, cw.length, bm.degree);
  if (!errPos) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  const ok = forneyCorrection(cw, syndromes, bm.lambda, errPos);
  if (!ok) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  // Double-check: ensure all syndromes on corrected codeword are zero
  const postSyndromes = rsSyndromes(cw, nsym);
  if (postSyndromes !== null) {
    return { ok: false, corrected: 0, codeword: cw };
  }

  return { ok: true, corrected: errPos.length, codeword: cw };
}
