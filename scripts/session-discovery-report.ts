import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeSessionAdapter } from '../src/products/packs/claude-code/sessions.js';
import { codexSessionAdapter } from '../src/products/packs/codex/sessions.js';
import { resetSessionDiscoveryCacheStats, sessionDiscoveryCacheStats, sessionDiscoveryDiagnosticDetails } from '../src/products/shared/session-files.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value?.startsWith('--')) args.set(value.slice(2), process.argv[index + 1] ?? '');
}
const product = args.get('product');
if (product !== 'codex' && product !== 'claude-code') throw new Error('--product must be codex or claude-code');
const limit = Number(args.get('limit') ?? 5_000);
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
const adapter = product === 'codex' ? codexSessionAdapter : claudeSessionAdapter;
const refresh = process.argv.includes('--refresh');
resetSessionDiscoveryCacheStats();
const page = await adapter.discover({ limit, ...(refresh ? { refresh: true } : {}) });
await adapter.discover({ limit });
const cacheStats = sessionDiscoveryCacheStats();
const cache = { unchanged: cacheStats.unchanged, 're-read': cacheStats.reread };
const diagnosticDetails = sessionDiscoveryDiagnosticDetails();
const diagnostics = Object.fromEntries(page.diagnostics.map((entry) => [entry.code, entry.count]));
const evidence = Object.fromEntries([...new Set(page.items.map((item) => item.evidenceLevel ?? 'transcript'))].map((key) => [key, page.items.filter((item) => (item.evidenceLevel ?? 'transcript') === key).length]));
const cwdSources = Object.fromEntries([
  ['event-or-history', page.items.filter((item) => item.cwd).length],
  ['unknown', page.items.filter((item) => !item.cwd).length],
]);
console.log(JSON.stringify({
  product,
  root: resolve(product === 'codex' ? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions') : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')),
  candidates: page.scanned,
  items: { complete: page.items.filter((item) => !item.partial).length, partial: page.items.filter((item) => item.partial).length },
  skipped: page.skipped,
  diagnostics,
  diagnosticDetails,
  cache,
  evidence,
  cwdSources,
  projects: new Set(page.items.map((item) => item.cwd?.toLowerCase().replaceAll('\\', '/') ?? `${product}:${item.sessionId}`)).size,
}, null, 2));

