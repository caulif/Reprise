import assert from 'node:assert/strict';

export function parseTestConcurrency(args) {
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== '--concurrency' || !/^[1-9]\d*$/.test(args[1])) {
    throw new Error('Expected --concurrency followed by one positive integer');
  }
  const concurrency = Number(args[1]);
  if (!Number.isSafeInteger(concurrency)) throw new Error('Test concurrency must be a safe positive integer');
  return concurrency;
}

export function selfTestTestConcurrency() {
  assert.equal(parseTestConcurrency([]), undefined);
  assert.equal(parseTestConcurrency(['--concurrency', '2']), 2);
  for (const args of [
    ['--concurrency'], ['--concurrency', '0'], ['--concurrency', '-1'], ['--concurrency', '1.5'],
    ['--concurrency', 'NaN'], ['--concurrency', 'Infinity'], ['--concurrency', ' 2'],
    ['--concurrency', '02'], ['--concurrency', '9007199254740992'],
    ['--concurrency', '2', '--concurrency', '3'], ['--unknown', '2'],
  ]) assert.throws(() => parseTestConcurrency(args), /positive integer/);
}
