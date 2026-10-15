import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sha256File } from '../../core/identity.js';
import { validateTaskCase } from '../../core/task-case-identity.js';
import { HistoricalArtifactManifestSchema, type TaskCase } from '../../core/schema.js';
import { Value } from '@sinclair/typebox/value';
import { frozenSnapshot } from '../../core/json.js';

const origins = new WeakMap<TaskCase, string>();

export function taskCaseOrigin(task: TaskCase): string | undefined { return origins.get(task); }

export function snapshotTaskCase(task: TaskCase): TaskCase {
  const snapshot = frozenSnapshot(validateTaskCase(task));
  const origin = origins.get(task);
  if (origin) origins.set(snapshot, origin);
  return snapshot;
}

export async function readTaskCase(path: string, options: { expectedCaseId?: string; requireComplete?: boolean } = {}): Promise<TaskCase> {
  const root = dirname(resolve(path));
  await assertRealDirectory(root);
  if (options.expectedCaseId) await assertRealDirectory(dirname(root));
  const caseFile = await lstat(path);
  if (!caseFile.isFile() || caseFile.isSymbolicLink()) throw new Error('TaskCase JSON must be a regular file.');
  const task = validateTaskCase(JSON.parse(await readFile(path, 'utf8')) as unknown);
  if (options.expectedCaseId && task.caseId !== options.expectedCaseId) throw new Error('TaskCase does not match the requested owner.');
  if (options.requireComplete && !(await lstat(join(root, 'case.complete'))).isFile()) throw new Error('TaskCase complete marker is not a file.');
  await verifyTaskCaseFiles(task, root, !options.expectedCaseId && !options.requireComplete);
  origins.set(task, root);
  return task;
}

export async function verifyTaskCaseFiles(task: TaskCase, root: string, allowExtraFiles = false): Promise<void> {
  await assertRealDirectory(root);
  if (task.schemaVersion === 1) return;
  for (const file of task.freezeIdentity!.files) {
    let path = root;
    for (const part of file.relativePath.split('/')) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Frozen file crosses a symbolic link or junction.');
    }
    const info = await lstat(path);
    if (!info.isFile() || info.size !== file.byteLength || await sha256File(path) !== file.contentHash) throw new Error(`Frozen file integrity mismatch: ${file.relativePath}`);
  }
  await verifyArtifactBindings(task, root);
  if (!allowExtraFiles) await assertNoUnboundFiles(root, new Set(task.freezeIdentity!.files.map((file) => file.relativePath)));
}

async function verifyArtifactBindings(task: TaskCase, root: string): Promise<void> {
  const files = new Map(task.freezeIdentity!.files.map((file) => [file.relativePath, file]));
  const manifestFile = files.get('baseline-artifacts/manifest.json');
  const extracted = new Map<string, string>();
  if (manifestFile) {
    const manifest: unknown = JSON.parse(await readFile(join(root, manifestFile.relativePath), 'utf8'));
    if (!Value.Check(HistoricalArtifactManifestSchema, manifest)) throw new Error('Frozen artifact manifest is invalid.');
    for (const artifact of manifest.artifacts) {
      const path = `baseline-artifacts/files/${artifact.bundleId}/${artifact.logicalPath}`;
      const file = files.get(path);
      if (extracted.has(artifact.artifactId) || !file || file.contentHash !== artifact.contentHash || file.byteLength !== artifact.byteLength) {
        throw new Error('Frozen artifact manifest does not match its bound files.');
      }
      extracted.set(artifact.artifactId, path);
    }
  }
  for (const ref of [...task.baseline.artifactRefs, ...task.sourceRuntimeEvidence.artifactRefs]) {
    if ('caseId' in ref && !extracted.has(ref.artifactId) && !files.has(`baseline-artifacts/${ref.artifactId}`)) {
      throw new Error(`Frozen artifact reference lacks bound bytes: ${ref.artifactId}`);
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Frozen case root must be a real directory, not a symbolic link or junction.');
}

async function assertNoUnboundFiles(root: string, bound: ReadonlySet<string>, prefix = ''): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Frozen case contains an unbound symbolic link.');
    if (entry.isDirectory()) await assertNoUnboundFiles(root, bound, path);
    else if (!bound.has(path) && path !== 'case.json' && path !== 'case.complete') throw new Error(`Frozen case contains an unbound file: ${path}`);
  }
}
