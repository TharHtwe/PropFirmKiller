const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  if (!(diff <= tolerance)) {
    throw new Error(`${label || 'value'}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

export async function runAll() {
  let passed = 0;
  const failed = [];
  console.log(`Running ${registered.length} tests\n`);
  for (const item of registered) {
    try {
      await item.fn();
      passed++;
      console.log('  ok   ' + item.name);
    } catch (err) {
      failed.push({ name: item.name, message: String((err && err.message) || err) });
      console.log('  FAIL ' + item.name);
      console.log('       ' + String((err && err.message) || err));
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) process.exitCode = 1;
  return { passed, failed };
}
