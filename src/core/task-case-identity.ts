import { Value } from '@sinclair/typebox/value';
import { sha256 } from './identity.js';
import { TaskCaseSchema, type TaskCase } from './schema.js';

export type FrozenFileDigest = { relativePath: string; byteLength: number; contentHash: string };

export function canonicalJson(value: unknown): string {
  const json: unknown = JSON.parse(JSON.stringify(value));
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]))
      : item;
  return JSON.stringify(sorted(json));
}

function frozenCaseDigest(task: TaskCase): string {
  const neutralRef = (ref: TaskCase['sourceRuntimeEvidence']['artifactRefs'][number]) => 'caseId' in ref
    ? { artifactId: ref.artifactId } : ref;
  return sha256(canonicalJson({
    schemaVersion: task.schemaVersion,
    source: { productId: task.source.productId, sessionId: task.source.sessionId },
    evidenceLevel: task.evidenceLevel,
    initialInput: task.initialInput,
    execution: task.execution,
    transcript: task.transcript,
    historicalEvents: task.historicalEvents,
    taskContext: task.taskContext,
    baseline: { ...task.baseline, artifactRefs: task.baseline.artifactRefs.map(neutralRef) },
    sourceRuntimeEvidence: { ...task.sourceRuntimeEvidence, artifactRefs: task.sourceRuntimeEvidence.artifactRefs.map(neutralRef) },
    provenance: { packVersion: task.provenance.packVersion, sourceHash: task.provenance.sourceHash },
    privacy: task.privacy,
    freezeIdentity: task.freezeIdentity,
  }));
}

export function sealTaskCase(task: TaskCase, files: readonly FrozenFileDigest[]): TaskCase {
  for (const ref of [...task.baseline.artifactRefs, ...task.sourceRuntimeEvidence.artifactRefs]) {
    if ('caseId' in ref && ref.caseId !== task.caseId) throw new Error('Cannot reseal a foreign artifact owner.');
  }
  const prepared: TaskCase = { ...task, schemaVersion: 2,
    freezeIdentity: { algorithm: 'task-case-v2', files: [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) } };
  const contentHash = frozenCaseDigest(prepared);
  const caseId = `case-v2-${contentHash.slice(0, 32)}`;
  const reown = (ref: TaskCase['sourceRuntimeEvidence']['artifactRefs'][number]) => 'caseId' in ref ? { ...ref, caseId } : ref;
  const result = { ...prepared, caseId, contentHash,
    baseline: { ...prepared.baseline, artifactRefs: prepared.baseline.artifactRefs.map((ref) => ({ ...ref, caseId })) },
    sourceRuntimeEvidence: { ...prepared.sourceRuntimeEvidence, artifactRefs: prepared.sourceRuntimeEvidence.artifactRefs.map(reown) } };
  return validateTaskCase(result);
}

export function validateTaskCase(value: unknown): TaskCase {
  if (!Value.Check(TaskCaseSchema, value)) throw new Error('TaskCase has invalid structure or unsupported schema version.');
  for (const ref of [...value.baseline.artifactRefs, ...value.sourceRuntimeEvidence.artifactRefs]) {
    if ('caseId' in ref && ref.caseId !== value.caseId) throw new Error('TaskCase artifact reference has a foreign owner.');
  }
  if (value.schemaVersion === 2) {
    if (value.initialInput.role !== 'user' || !value.transcript.some((message) => canonicalJson(message) === canonicalJson(value.initialInput))) {
      throw new Error('Frozen TaskCase initial input is not a recorded user message.');
    }
    const seen = new Set<string>();
    for (const file of value.freezeIdentity.files) {
      assertFrozenFilePath(file.relativePath);
      const key = file.relativePath.toLowerCase();
      if (seen.has(key)) throw new Error('TaskCase has duplicate frozen file paths.');
      seen.add(key);
    }
    if (value.contentHash !== frozenCaseDigest(value) || value.caseId !== `case-v2-${value.contentHash.slice(0, 32)}`) throw new Error('TaskCase frozen content identity mismatch.');
  }
  return value;
}

export function assertFrozenFilePath(path: string): void {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[<>:"|?*\x00-\x1f]/.test(part))
    || path.toLowerCase() === 'case.json' || path.toLowerCase() === 'case.complete' || path.toLowerCase().includes('.tmp-')) throw new Error(`Unsafe frozen file path: ${path}`);
}
