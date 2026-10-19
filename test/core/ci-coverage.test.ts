import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CI keeps all platform assertions, complete coverage shards and a fail-closed aggregate', async () => {
  const workflow = (await readFile('.github/workflows/check.yml', 'utf8')).replaceAll('\r\n', '\n');
  const verify = (text: string) => {
    const job = (name: string) => {
      const body = text.match(new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z]|$)`))?.[1];
      assert.ok(body, `missing job ${name}`);
      return body;
    };
    assert.match(job('scope'), /fetch-depth: 0/);
    assert.match(job('scope'), /node scripts\/ci-scope\.mjs/);
    assert.match(job('test'), /os: \[windows-latest, macos-latest\]/);
    assert.match(job('test'), /node scripts\/run-gates\.mjs test/);
    for (const name of ['test', 'audit', 'coverage-shards']) {
      assert.match(job(name), /needs: scope/);
      assert.match(job(name), /if: needs.scope.outputs.full == 'true'/);
    }
    const coverage = job('coverage');
    assert.match(coverage, /needs: coverage-shards/);
    assert.match(coverage, /node scripts\/coverage-shards\.mjs merge \.coverage-input/);
    assert.match(coverage, /pattern: coverage-shard-\*/);
    const shards = job('coverage-shards');
    assert.match(shards, /shard: \[1, 2, 3, 4\]/);
    assert.match(shards, /fail-fast: false/);
    assert.match(shards, /node scripts\/coverage-shards\.mjs run \$\{\{ matrix.shard \}\}\/4/);
    assert.match(shards, /if-no-files-found: error/);
    assert.match(shards, /npm run check:node/);
    assert.match(job('all-checks-passed'), /if: always\(\)/);
    assert.match(job('all-checks-passed'), /needs: \[scope, static, test, audit, coverage\]/);
    assert.match(job('all-checks-passed'), /node scripts\/ci-scope\.mjs verify/);
    for (const name of ['scope', 'static', 'test', 'audit', 'coverage']) {
      assert.ok(job('all-checks-passed').includes(`needs.${name}.result`));
    }
  };
  verify(workflow);
  for (const [from, to] of [
    ['needs: coverage-shards', 'needs: static'],
    ['shard: [1, 2, 3, 4]', 'shard: [1, 2, 3]'],
    ['coverage-shards.mjs merge', 'coverage-shards.mjs run'],
    ["if: needs.scope.outputs.full == 'true'", "if: false"],
    ['needs: [scope, static, test, audit, coverage]', 'needs: [scope, static, test, audit]'],
    ['REPRISE_CI_COVERAGE: ${{ needs.coverage.result }}', 'REPRISE_CI_COVERAGE: success'],
  ]) {
    assert.ok(from && to);
    assert.throws(() => verify(workflow.replace(from, to)));
  }
});
