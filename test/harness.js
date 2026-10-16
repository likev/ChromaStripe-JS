/**
 * Test harness supporting both Node.js (via node:test & node:assert)
 * and in-browser execution.
 */

let testFn;
let assertObj;

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  const nodeTest = await import('node:test');
  const nodeAssert = await import('node:assert/strict');
  testFn = nodeTest.test;
  assertObj = nodeAssert.default || nodeAssert;
} else {
  // Browser test runner environment
  const browserTests = [];
  testFn = (name, fn) => {
    browserTests.push({ name, fn });
  };
  testFn.runAll = async (reporter) => {
    let passed = 0;
    let failed = 0;
    for (const t of browserTests) {
      try {
        await t.fn();
        passed++;
        if (reporter?.onPass) reporter.onPass(t.name);
      } catch (err) {
        failed++;
        if (reporter?.onFail) reporter.onFail(t.name, err);
      }
    }
    return { passed, failed, total: browserTests.length };
  };

  assertObj = {
    equal: (a, b, msg) => {
      if (a != b) throw new Error(msg || `Expected ${a} == ${b}`);
    },
    strictEqual: (a, b, msg) => {
      if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`);
    },
    notStrictEqual: (a, b, msg) => {
      if (a === b) throw new Error(msg || `Expected ${a} !== ${b}`);
    },
    deepStrictEqual: (a, b, msg) => {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(msg || `Deep strict equal failed:\n${JSON.stringify(a)}\nvs\n${JSON.stringify(b)}`);
      }
    },
    ok: (val, msg) => {
      if (!val) throw new Error(msg || `Expected truthy value, got ${val}`);
    },
    throws: (fn, regOrMsg) => {
      let threw = false;
      try {
        fn();
      } catch (e) {
        threw = true;
      }
      if (!threw) throw new Error(`Expected function to throw`);
    }
  };
}

export const test = testFn;
export const assert = assertObj;
export default { test, assert };
