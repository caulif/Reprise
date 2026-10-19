import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requiresFullChecks(paths) {
  return paths.length === 0 || paths.some(path =>
    !/^(?:README(?:\.[a-zA-Z-]+)?\.md|docs\/[^\s]+\.md)$/.test(path) ||
    /(?:^|\/)AGENTS(?:\.override)?\.md$/i.test(path) ||
    path.split('/').some(part => part.startsWith('.')));
}

export function verifyResults(full, results) {
  if (full !== 'true' && full !== 'false') throw new Error('Missing or invalid CI scope');
  for (const name of ['scope', 'static']) {
    if (results[name] !== 'success') throw new Error(`Required lane failed: ${name}=${results[name]}`);
  }
  for (const name of ['test', 'audit', 'coverage']) {
    const expected = full === 'true' ? 'success' : 'skipped';
    if (results[name] !== expected) throw new Error(`Required lane ${name}: expected ${expected}, got ${results[name]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'verify') {
    verifyResults(process.env.REPRISE_CI_FULL, Object.fromEntries(
      ['scope', 'static', 'test', 'audit', 'coverage'].map(name => [name, process.env[`REPRISE_CI_${name.toUpperCase()}`]]),
    ));
  } else if (process.argv.length === 2) {
    let full = true;
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      const { REPRISE_CI_BASE: base, REPRISE_CI_HEAD: head } = process.env;
      if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw new Error('Invalid PR commit identities');
      const mergeBase = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
      const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', mergeBase, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
      full = requiresFullChecks(paths);
    }
    console.log(`CI scope: ${full ? 'full' : 'documentation only'}`);
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
  } else throw new Error('Usage: ci-scope.mjs [verify]');
}
