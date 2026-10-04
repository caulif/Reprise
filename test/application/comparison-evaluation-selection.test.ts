import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectComparisonEvaluationRows } from '../../scripts/comparison-evaluation-selection.js';
import { sha256 } from '../../src/core/identity.js';

test('single observation selection preserves case/order and gives independent ledger names', () => {
  const rows = [{ caseId: 'code-empty', repetition: 1, variant: 'original' as const },
    { caseId: 'code-empty', repetition: 2, variant: 'swapped' as const },
    { caseId: 'text-negation', repetition: 2, variant: 'swapped' as const }];
  const result = selectComparisonEvaluationRows(rows, ['--case', 'code-empty', '--repetition', '2', '--variant', 'swapped'], ['code-empty', 'text-negation']);
  assert.deepEqual(result.rows, [rows[1]]);
  assert.equal(result.ledgerFile, 'ledger-code-empty-r2-swapped.json');
  assert.equal(selectComparisonEvaluationRows(rows, ['--case', 'code-empty'], ['code-empty']).ledgerFile, 'ledger-code-empty.json');
  assert.deepEqual(selectComparisonEvaluationRows(rows, ['--repetition', '2', '--max-rows', '1'], ['code-empty', 'text-negation']).rows, [rows[1]]);
  assert.equal(selectComparisonEvaluationRows(rows, [], []).ledgerFile, 'ledger.json');
  for (const flags of [['--repetition', '0'], ['--repetition', '1.5'], ['--variant', 'wrong'], ['--variant'],
    ['--case', '../escape'], ['--variant', 'original', '--variant', 'blind'], ['--repetition', '3'], ['--unknown', '1']]) {
    assert.throws(() => selectComparisonEvaluationRows(rows, flags, ['code-empty']), /selected|option/);
  }
});

test('CLI rejects unavailable or invalid paid selection before input verification and model configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-evaluation-selection-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const suite = await readFile(new URL('../fixtures/comparison-evaluation/suite.json', import.meta.url), 'utf8');
  await writeFile(join(root, 'suite.json'), suite);
  await writeFile(join(root, 'plan.json'), JSON.stringify({ schemaVersion: 1, suiteHash: sha256(suite), rows: [{
    caseId: 'code-empty', repetition: 1, variant: 'original', dataDir: join(root, 'inputs', 'code-empty', '1', 'original', 'data'),
    experimentId: 'eval-code-empty', runId: 'fixture-run', inputIdentityHash: 'a'.repeat(64),
  }] }));
  const cli = fileURLToPath(new URL('../../scripts/comparison-evaluate.js', import.meta.url));
  const execute = promisify(execFile);
  for (const [flags, expected] of [[['--repetition', '2'], /No selected evaluation cases/], [['--variant', 'wrong'], /invalid real option/]] as const) {
    await assert.rejects(execute(process.execPath, [cli, 'real', root, join(root, 'missing-config'), ...flags],
      { env: { ...process.env, REPRISE_REAL_MODEL: '1' } }), error => error instanceof Error && expected.test(error.message));
  }
});
