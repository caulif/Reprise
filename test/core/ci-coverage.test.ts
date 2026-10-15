import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('serial CI coverage has enough job time without relaxing coverage or aggregate gates', async () => {
  const workflow = (await readFile('.github/workflows/check.yml', 'utf8')).replaceAll('\r\n', '\n');
  const verify = (text: string) => {
    const coverage = text.match(/\n {2}coverage:\n([\s\S]*?)(?=\n {2}all-checks-passed:)/)?.[1];
    assert.ok(coverage);
    assert.ok(Number(coverage.match(/timeout-minutes: (\d+)/)?.[1]) >= 30);
    assert.match(coverage, /npm run test:coverage -- --concurrency 1/);
    assert.match(text, /needs: \[static, test, audit, coverage\]/);
    assert.match(text, /needs.coverage.result.*success/);
  };
  verify(workflow);
  assert.throws(() => verify(workflow.replace('timeout-minutes: 30', 'timeout-minutes: 15')));
  assert.throws(() => verify(workflow.replace('needs: [static, test, audit, coverage]', 'needs: [static, test, audit]')));
});
