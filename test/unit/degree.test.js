import { test, assert } from '../harness.js';
import { sampleResidualDegree, sampleSolitonDegree } from '../../src/fountain/degree.js';
import { PRNG } from '../../src/core/prng.js';

test('degree: degrees never exceed K for various K', () => {
  const rng = new PRNG(101);
  for (const K of [1, 2, 3, 5, 10, 50, 1000]) {
    for (let i = 0; i < 500; i++) {
      const dResidual = sampleResidualDegree(rng, K);
      assert.ok(dResidual >= 1 && dResidual <= K, `Residual degree ${dResidual} out of bounds for K=${K}`);

      const dSoliton = sampleSolitonDegree(rng, K);
      assert.ok(dSoliton >= 1 && dSoliton <= K, `Soliton degree ${dSoliton} out of bounds for K=${K}`);
    }
  }
});
