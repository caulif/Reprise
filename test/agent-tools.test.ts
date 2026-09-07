import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('retired comparison and observation paging tools are gone', async () => {
  const root = join(process.cwd(), 'src/infrastructure');
  const files = await readdir(root);
  assert.equal(files.includes('agent-tools.ts'), false);
  assert.equal(files.includes('observation-page.ts'), false);
  assert.equal(files.includes('recovery-observation-tools.ts'), false);
  const recoveryTools = await readFile(join(root, 'recovery-tools.ts'), 'utf8');
  assert.doesNotMatch(recoveryTools, /recoveryObservationTools|read_artifact|write_comparison_report|evidenceTools|comparisonReportTool/);
});
