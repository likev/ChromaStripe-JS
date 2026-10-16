/**
 * Microbenchmark harness: Warm-up + N iterations, median, p95, ops/s.
 */

export async function benchmark(name, fn, options = {}) {
  const warmup = options.warmup ?? 200;
  const iterations = options.iterations ?? 1000;

  // Warm-up phase
  for (let i = 0; i < warmup; i++) {
    const res = fn();
    if (res instanceof Promise) await res;
  }

  // Measurement phase
  const times = new Float64Array(iterations);
  const startOverall = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const res = fn();
    if (res instanceof Promise) await res;
    times[i] = performance.now() - t0;
  }

  const totalTime = performance.now() - startOverall;

  // Compute statistics
  const sorted = Array.from(times).sort((a, b) => a - b);
  const median = sorted[Math.floor(iterations * 0.50)];
  const p95 = sorted[Math.floor(iterations * 0.95)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const opsPerSec = (iterations / (totalTime / 1000));

  return {
    name,
    iterations,
    totalTimeMs: totalTime,
    medianMs: median,
    p95Ms: p95,
    minMs: min,
    maxMs: max,
    opsPerSec
  };
}
