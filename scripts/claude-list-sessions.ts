import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isEligibleSession } from '../src/products/contract.js';
import { claudeSessionAdapter } from '../src/products/packs/claude-code/sessions.js';

const summaries = await claudeSessionAdapter.discover({ limit: 30 });
const rows = [];
for (const session of summaries.items) {
  const cwd = session.cwd;
  let bytes = 0;
  let files = 0;
  let exists = false;
  if (cwd && existsSync(cwd)) {
    exists = true;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || files > 200) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.reprise') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else {
          files += 1;
          try { bytes += (await stat(path)).size; } catch { /* skip */ }
        }
      }
    };
    await walk(cwd, 0);
  }
  rows.push({
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    eligible: isEligibleSession(session),
    startedAt: session.startedAt,
    model: session.model ?? null,
    completedTurns: session.signals.completedTurns,
    userMessages: session.signals.userMessages,
    cwdExists: exists,
    cwd: cwd ?? null,
    approxFiles: files,
    approxBytes: bytes,
  });
}
const eligible = rows.filter((row) => row.eligible);
const withCwd = eligible.filter((row) => row.cwdExists).sort((left, right) => left.approxBytes - right.approxBytes);
console.log(JSON.stringify({
  discovered: rows.length,
  eligible: eligible.length,
  withExistingCwd: withCwd.length,
  smallest: withCwd.slice(0, 5),
}, null, 2));
