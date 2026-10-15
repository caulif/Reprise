import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema } from '../core/schema.js';
import { captureHistoricalDelivery } from '../application/historical-delivery.js';

export async function runCaptureHistory(args: readonly string[], io: { stdout: (text: string) => void }): Promise<number> {
  const values = parseArgs({ args: [...args], allowPositionals: false, strict: true, options: {
    'data-dir': { type: 'string' }, 'task-case': { type: 'string' }, file: { type: 'string' },
    'logical-path': { type: 'string' }, 'expected-hash': { type: 'string' }, repository: { type: 'string' },
    commit: { type: 'string' }, basis: { type: 'string' }, 'user-instruction': { type: 'string' },
    substitute: { type: 'boolean' }, 'original-unavailable': { type: 'boolean' }, json: { type: 'boolean' },
  } }).values;
  if (!values['task-case'] || !values.basis || Boolean(values.file) === Boolean(values.repository)) throw new Error('capture-history requires --task-case, --basis and exactly one of --file/--repository.');
  const taskCase: unknown = JSON.parse(await readFile(resolve(values['task-case']), 'utf8'));
  if (!Value.Check(TaskCaseSchema, taskCase)) throw new Error('Invalid frozen TaskCase.');
  const dataDir = resolve(values['data-dir'] ?? process.env.REPRISE_DATA_DIR ?? '.reprise');
  const frozen: unknown = JSON.parse(await readFile(resolve(dataDir, 'cases', taskCase.caseId, 'case.json'), 'utf8'));
  if (!Value.Check(TaskCaseSchema, frozen) || JSON.stringify(frozen) !== JSON.stringify(taskCase)) throw new Error('TaskCase does not match the selected data directory.');
  if (values.repository && (!values.commit || values.substitute || values['original-unavailable'] || values['expected-hash'] || values['logical-path'] || values['user-instruction'])) throw new Error('Git capture requires --commit and cannot include file/substitute flags.');
  if (values.file && (!values['expected-hash'] || !values['logical-path'] || values.commit
    || (values.substitute && !values['user-instruction']) || (!values.substitute && (values['user-instruction'] || values['original-unavailable'])))) throw new Error('File capture requires --expected-hash/--logical-path; substitute capture also requires --user-instruction.');
  const source = values.repository ? { kind: 'git_snapshot' as const, repository: resolve(values.repository), commit: values.commit! }
    : { kind: values.substitute ? 'user_selected_substitute' as const : 'captured_file' as const, sourcePath: resolve(values.file!),
      logicalPath: values['logical-path']!, expectedHash: values['expected-hash']!, originalStatus: values['original-unavailable'] ? 'unavailable' as const : 'not_verified' as const,
      ...(values['user-instruction'] ? { userInstruction: values['user-instruction'] } : {}) };
  const result = await captureHistoricalDelivery({ dataDir, taskCase, source, selectionBasis: values.basis, now: new Date().toISOString() });
  io.stdout(JSON.stringify({ schemaVersion: 1, caseId: taskCase.caseId, ...result }));
  return 0;
}
