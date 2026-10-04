import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { sha256 } from '../src/core/identity.js';
import { pathContainedBy } from '../src/core/paths.js';
import { ComparisonEvaluationInputIdentitySchema, type ComparisonEvaluationInputIdentity } from '../src/core/comparison-evaluation-input-schema.js';
import type { ComparisonEvaluationCase } from '../src/core/comparison-evaluation-schema.js';
import { parseCommittedEventLog } from '../src/infrastructure/agent/model-input.js';
import { record } from '../src/core/json.js';
import type { EventEnvelope } from '../src/core/schema.js';

const IDENTITY = 'evaluation-inputs.json';
const COMPARISON_EVENTS = new Set(['comparison.started', 'comparison.requested', 'comparison.completed', 'comparison.findings_updated',
  'comparison.draft_accepted', 'comparison.evidence_registered', 'comparison.phase_completed', 'comparison.resources_completed']);
const AGENT_EVENTS = new Set(['agent.session_started', 'agent.session_completed', 'agent.invocation_started', 'agent.invocation_completed',
  'agent.message_appended', 'agent.model_request', 'agent.model_output', 'agent.usage_reported', 'agent.assistant_visible',
  'agent.tool_called', 'agent.tool_completed', 'agent.context_compacted', 'agent.request_retried', 'agent.tool_failed',
  'agent.session_failed', 'agent.session_cancelled', 'agent.invocation_failed', 'agent.invocation_cancelled', 'agent.invalid_output']);

function assertComparisonSuffix(events: readonly EventEnvelope[]): void {
  for (const event of events) {
    const payload = record(event.payload);
    const permitted = COMPARISON_EVENTS.has(event.type)
      || (AGENT_EVENTS.has(event.type) && payload.role === 'comparison')
      || (event.type === 'artifact.created' && typeof payload.artifactId === 'string' && /^(comparison-|mi[a-f0-9]{16}$)/.test(payload.artifactId))
      || event.type === 'report.created';
    if (!permitted || (event.runId !== undefined && event.runId !== 'fixture-run')) throw new Error(`Non-Comparison event appended to frozen evaluation inputs: ${event.type}`);
  }
}
function scopes(experimentId: string) {
  const experiment = `data/experiments/${experimentId}`;
  return ['source', 'data/cases', `${experiment}/experiment.json`, `${experiment}/runs/fixture-run`, `${experiment}/environment`];
}

async function inputFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    const absolute = resolve(root, ...path.split('/'));
    if (!pathContainedBy(resolve(root), absolute)) throw new Error('Evaluation input path escapes fixture root.');
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Evaluation input symlink is unsupported: ${path}`);
    if (info.isDirectory()) files.push(...await inputFiles(root, (await readdir(absolute)).map(name => `${path}/${name}`)));
    else if (info.isFile()) files.push(path);
    else throw new Error(`Unsupported evaluation input: ${path}`);
  }
  return files.sort();
}

/** Snapshot only fixture inputs; credentials/configuration and generated attempt outputs are outside these scopes. */
export async function captureComparisonEvaluationInputs(root: string, item: ComparisonEvaluationCase): Promise<string> {
  const experimentId = `eval-${item.id}`;
  const paths = await inputFiles(root, scopes(experimentId));
  const eventPath = `data/experiments/${experimentId}/events.jsonl`;
  const events = await readFile(join(root, ...eventPath.split('/')));
  const parsed = parseCommittedEventLog(events.toString('utf8'));
  if (parsed.diagnostic || parsed.events.some(event => event.type === 'comparison.started')) throw new Error('Capture requires pristine committed fixture inputs.');
  const identity: ComparisonEvaluationInputIdentity = { schemaVersion: 1, suiteVariantHash: sha256(JSON.stringify(item)), experimentId,
    files: await Promise.all(paths.map(async path => ({ path, hash: sha256(await readFile(join(root, ...path.split('/')))) }))),
    events: { path: eventPath, prefixBytes: events.byteLength, prefixHash: sha256(events) } };
  if (!Value.Check(ComparisonEvaluationInputIdentitySchema, identity)) throw new Error('Invalid generated evaluation input identity.');
  const bytes = `${JSON.stringify(identity, null, 2)}\n`;
  await writeFile(join(root, IDENTITY), bytes, { flag: 'wx' });
  return sha256(bytes);
}

/** Check every selected input before any billed call; appended comparison events do not change the frozen prefix. */
export async function verifyComparisonEvaluationInputs(root: string, item: ComparisonEvaluationCase, identityHash: string): Promise<void> {
  const bytes = await readFile(join(root, IDENTITY));
  const identity: unknown = JSON.parse(bytes.toString('utf8'));
  if (sha256(bytes) !== identityHash || !Value.Check(ComparisonEvaluationInputIdentitySchema, identity)
    || identity.suiteVariantHash !== sha256(JSON.stringify(item)) || identity.experimentId !== `eval-${item.id}`) throw new Error('Evaluation input identity mismatch.');
  const current = await inputFiles(root, scopes(identity.experimentId));
  const expected = new Set(identity.files.map(file => file.path));
  if (expected.size !== identity.files.length) throw new Error('Duplicate frozen input path.');
  const artifactPrefix = `data/experiments/${identity.experimentId}/runs/fixture-run/artifacts/`;
  if (current.some(path => !expected.has(path) && !path.startsWith(artifactPrefix))) throw new Error('Unexpected file added to frozen evaluation inputs.');
  const allowed = new Set(current);
  for (const file of identity.files) {
    if (!allowed.has(file.path) || sha256(await readFile(join(root, ...file.path.split('/')))) !== file.hash) throw new Error(`Frozen evaluation input changed: ${file.path}`);
  }
  const eventPath = `data/experiments/${identity.experimentId}/events.jsonl`;
  if (identity.events.path !== eventPath) throw new Error('Evaluation events path mismatch.');
  const events = await readFile(join(root, ...eventPath.split('/')));
  if (events.byteLength < identity.events.prefixBytes || sha256(events.subarray(0, identity.events.prefixBytes)) !== identity.events.prefixHash
    || parseCommittedEventLog(events.toString('utf8')).diagnostic) throw new Error('Evaluation committed input event prefix changed or log is invalid.');
  const suffix = events.subarray(identity.events.prefixBytes).toString('utf8');
  if (suffix) {
    const combined = parseCommittedEventLog(events.toString('utf8'));
    const prefix = parseCommittedEventLog(events.subarray(0, identity.events.prefixBytes).toString('utf8'));
    assertComparisonSuffix(combined.events.slice(prefix.events.length));
  }
}
