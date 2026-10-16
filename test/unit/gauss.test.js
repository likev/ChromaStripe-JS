import { test, assert } from '../harness.js';
import { solveBinarySystem } from '../../src/fountain/gauss.js';
import { PRNG } from '../../src/core/prng.js';

test('gauss: solves small 3x3 binary system', () => {
  // eq0: x0 = 2 (mask 0b001)
  // eq1: x0 ^ x1 = 3 (mask 0b011) => x1 = 2 ^ 3 = 1
  // eq2: x1 ^ x2 = 5 (mask 0b110) => x2 = 1 ^ 5 = 4
  const numUnknowns = 3;

  const eq0 = { mask: new Uint32Array([0b001]), rhs: new Uint32Array(112) };
  eq0.rhs[0] = 2;
  const eq1 = { mask: new Uint32Array([0b011]), rhs: new Uint32Array(112) };
  eq1.rhs[0] = 3;
  const eq2 = { mask: new Uint32Array([0b110]), rhs: new Uint32Array(112) };
  eq2.rhs[0] = 5;

  const res = solveBinarySystem([eq0, eq1, eq2], numUnknowns);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.rank, 3);
  assert.strictEqual(res.solution[0][0], 2);
  assert.strictEqual(res.solution[1][0], 1);
  assert.strictEqual(res.solution[2][0], 4);
});

test('gauss: detects linearly dependent system', () => {
  // eq0: x0 ^ x1 = 3
  // eq1: x1 ^ x2 = 5
  // eq2: x0 ^ x2 = 6 (dependent on eq0 and eq1 in GF(2))
  const numUnknowns = 3;

  const eq0 = { mask: new Uint32Array([0b011]), rhs: new Uint32Array(112) };
  eq0.rhs[0] = 3;
  const eq1 = { mask: new Uint32Array([0b110]), rhs: new Uint32Array(112) };
  eq1.rhs[0] = 5;
  const eq2 = { mask: new Uint32Array([0b101]), rhs: new Uint32Array(112) };
  eq2.rhs[0] = 6;

  const res = solveBinarySystem([eq0, eq1, eq2], numUnknowns);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.rank, 2);
});

test('gauss: solves 100 unknowns binary system within budget', () => {
  const rng = new PRNG(777);
  const N = 100;
  const words = Math.ceil(N / 32);

  // Generate random true solution
  const trueSolution = new Array(N);
  for (let i = 0; i < N; i++) {
    trueSolution[i] = new Uint32Array(112);
    for (let w = 0; w < 112; w++) trueSolution[i][w] = rng.nextU32();
  }

  // Generate N linearly independent equations (triangular + random)
  const equations = [];
  for (let i = 0; i < N; i++) {
    const mask = new Uint32Array(words);
    mask[i >>> 5] |= (1 << (i & 31)); // Ensure diagonal

    for (let j = i + 1; j < N; j++) {
      if (rng.nextFloat() < 0.2) {
        mask[j >>> 5] |= (1 << (j & 31));
      }
    }

    const rhs = new Uint32Array(112);
    for (let j = 0; j < N; j++) {
      if ((mask[j >>> 5] & (1 << (j & 31))) !== 0) {
        for (let w = 0; w < 112; w++) rhs[w] ^= trueSolution[j][w];
      }
    }
    equations.push({ mask, rhs });
  }

  const t0 = performance.now();
  const res = solveBinarySystem(equations, N);
  const elapsed = performance.now() - t0;

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.rank, N);
  for (let i = 0; i < N; i++) {
    assert.deepStrictEqual(res.solution[i], trueSolution[i]);
  }
  assert.ok(elapsed < 100, `GE took too long: ${elapsed}ms`);
});
