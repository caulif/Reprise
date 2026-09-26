import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parseFragment } from 'parse5';
import type { ComparisonResult } from '../agents/comparison-agent.js';
import { AgentImageRefSchema, AgentTextBodySchema } from '../core/agent-model-input-schema.js';
import { sha256, writeAtomic } from '../core/identity.js';
import { SAFE_ID } from '../core/identity.js';
import {
  ComparisonBriefingContextSchema, ComparisonEvidenceCatalogSchema, ComparisonInvocationSchema,
  type ComparisonReportModel, type EventEnvelope,
} from '../core/schema.js';
import { ExperimentStore } from '../infrastructure/store/experiment-store.js';
import { persistComparisonReportModel, prepareComparisonArtifacts, verifyAndRenderComparisonReport } from './comparison-publication.js';

const CatalogPointerSchema = Type.Object({
  schemaVersion: Type.Literal(1), revision: Type.Integer({ minimum: 0 }), attemptId: Type.String(),
});
const PreviewDetailsSchema = Type.Object({
  status: Type.Literal('ok'), revision: Type.Integer({ minimum: 0 }),
  draftDigest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});

type HtmlNode = { attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[]; content?: HtmlNode; value?: string };

function reportContent(html: string): { headline: string; evidenceRefs: string[] } {
  const refs = new Set<string>();
  let headline = '';
  const visit = (node: HtmlNode, inHeadline = false): void => {
    const attrs = node.attrs ?? [];
    const marked = inHeadline || attrs.some((attr) => attr.name === 'data-agent-slot' && attr.value === 'headline');
    for (const attr of attrs) if (attr.name === 'data-evidence-ref') refs.add(attr.value);
    if (marked && node.value) headline += node.value;
    for (const child of node.childNodes ?? []) visit(child, marked);
    if (node.content) visit(node.content, marked);
  };
  visit(parseFragment(html) as HtmlNode);
  return { headline: headline.replace(/\s+/g, ' ').trim(), evidenceRefs: [...refs] };
}

async function checkedJson<T extends TSchema>(path: string, schema: T): Promise<Static<T>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Value.Check(schema, value)) throw new Error(`Frozen comparison fact failed schema validation: ${path}`);
  return value;
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('Comparison attempt is outside the selected data directory.');
  }
}

async function deliveredImageHashes(
  store: ExperimentStore, events: readonly EventEnvelope[], attemptId: string, sessionId: string,
): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const event of events) {
    if (typeof event.payload !== 'object' || event.payload === null) continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.attemptId !== attemptId || payload.sessionId !== sessionId) continue;
    if (event.type === 'agent.message_appended') {
      if (Array.isArray(payload.images)) {
        for (const image of payload.images) {
          if (Value.Check(AgentImageRefSchema, image)) hashes.add(image.contentHash);
        }
      }
      continue;
    }
    if (event.type !== 'agent.tool_completed' || !Array.isArray(payload.contentTypes) || !payload.contentTypes.includes('image')) continue;
    if (!Value.Check(AgentTextBodySchema, payload.body)) throw new Error('Image tool result has an invalid audit body.');
    let text: string;
    if (payload.body.encoding === 'artifact') {
      if (!event.runId) throw new Error('Image tool result has no run ID for its audit artifact.');
      const bytes = await store.readArtifact({ artifactId: payload.body.artifactId, experimentId: store.experimentId, runId: event.runId });
      if (bytes.byteLength !== payload.body.byteLength || sha256(bytes) !== payload.body.contentHash) {
        throw new Error('Image tool result audit artifact failed integrity check.');
      }
      text = Buffer.from(bytes).toString('utf8');
    } else {
      text = payload.body.text;
    }
    const blocks: unknown = JSON.parse(text);
    if (!Array.isArray(blocks)) throw new Error('Image tool result audit body is not an array.');
    for (const block of blocks) {
      if (Value.Check(AgentImageRefSchema, block)) hashes.add(block.contentHash);
    }
  }
  return hashes;
}

export async function inspectComparisonRecovery(input: {
  dataDir: string; experimentId: string; attemptId: string;
}): Promise<{
  ready: boolean; reason?: string; draftDigest: string; revision: number;
  experimentRoot: string; attemptRoot: string; html: string;
  result: ComparisonResult; sessionId?: string; model?: ComparisonReportModel;
  media: import('../core/schema.js').ComparisonMediaRecord[];
}> {
  if (!SAFE_ID.test(input.experimentId) || !SAFE_ID.test(input.attemptId)) throw new Error('Invalid experiment or attempt ID.');
  const dataRoot = await realpath(resolve(input.dataDir));
  const experimentRoot = await realpath(join(dataRoot, 'experiments', input.experimentId));
  const attemptRoot = await realpath(join(experimentRoot, 'comparison-attempts', input.attemptId));
  assertInside(dataRoot, experimentRoot);
  assertInside(experimentRoot, attemptRoot);
  const factsRoot = join(attemptRoot, 'facts');
  const context = await checkedJson(join(factsRoot, 'context.json'), ComparisonBriefingContextSchema);
  const pointer = await checkedJson(join(factsRoot, 'evidence-catalog.json'), CatalogPointerSchema);
  if (pointer.attemptId !== input.attemptId) throw new Error('Catalog belongs to another attempt.');
  const catalog = await checkedJson(join(factsRoot, 'evidence-catalog', `rev-${pointer.revision}.json`), ComparisonEvidenceCatalogSchema);
  if (catalog.attemptId !== input.attemptId || catalog.revision !== pointer.revision) throw new Error('Catalog revision mismatch.');
  const links = catalog.links;
  const media = catalog.media;
  const html = await readFile(join(attemptRoot, 'report.html'), 'utf8');
  const draftDigest = sha256(html);
  const { headline, evidenceRefs } = reportContent(html);
  const result: ComparisonResult = { status: 'completed', reportPath: 'report.html', headline, evidenceRefs };
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const events = store.events();
  const previewed = events.find((event) => event.type === 'agent.tool_completed'
    && typeof event.payload === 'object' && event.payload !== null
    && (event.payload as Record<string, unknown>).attemptId === input.attemptId
    && (event.payload as Record<string, unknown>).tool === 'preview_report'
    && typeof (event.payload as Record<string, unknown>).sessionId === 'string'
    && ((event.payload as Record<string, unknown>).sessionId as string).length > 0
    && Value.Check(PreviewDetailsSchema, (event.payload as Record<string, unknown>).details)
    && ((event.payload as Record<string, unknown>).details as { draftDigest: string; revision: number }).draftDigest === draftDigest
    && ((event.payload as Record<string, unknown>).details as { draftDigest: string; revision: number }).revision === catalog.revision);
  if (!previewed) return { ready: false, reason: 'No successful preview with a session ID for this draft and catalog revision.', draftDigest, revision: catalog.revision, experimentRoot, attemptRoot, html, result, media };
  const sessionId = (previewed.payload as { sessionId: string }).sessionId;
  const deliveredImageContentHashes = await deliveredImageHashes(store, events, input.attemptId, sessionId);
  const verified = await verifyAndRenderComparisonReport({
    html, hostTask: context.task.summary, facts: context.reportFacts, result,
    attemptRoot, evidence: links, media, deliveredImageContentHashes,
  });
  if ('failureClass' in verified) return { ready: false, reason: `${verified.code}: ${verified.message}`, draftDigest, revision: catalog.revision, experimentRoot, attemptRoot, html, result, media };
  return { ready: true, draftDigest, revision: catalog.revision, experimentRoot, attemptRoot, html: verified.html, result, sessionId, model: verified.model, media };
}

export async function publishRecoveredComparison(input: {
  dataDir: string; experimentId: string; attemptId: string;
  status: 'completed' | 'insufficient_evidence';
}): Promise<{ reportPath: string; draftDigest: string }> {
  const inspected = await inspectComparisonRecovery(input);
  if (!inspected.ready) throw new Error(inspected.reason ?? 'Comparison draft is not recoverable.');
  const reportPath = join(inspected.experimentRoot, 'report.html');
  const store = await ExperimentStore.open(inspected.experimentRoot, input.experimentId);
  await store.acquireWriter();
  try {
    const checked = await inspectComparisonRecovery(input);
    if (!checked.ready || checked.draftDigest !== inspected.draftDigest || checked.revision !== inspected.revision) {
      throw new Error('Comparison draft or catalog changed before recovery publication.');
    }
    const prepared = await prepareComparisonArtifacts({
      attemptRoot: checked.attemptRoot, experimentRoot: checked.experimentRoot,
      html: checked.html, media: checked.media, ...(checked.model ? { model: checked.model } : {}),
    });
    const publishedDigest = sha256(prepared.html);
    const intent = {
      attemptId: input.attemptId, draftDigest: checked.draftDigest,
      publishedDigest, revision: checked.revision, status: input.status,
    };
    const priorIntent = store.events().find((event) => event.operationId === `comparison-recovery-started-${input.attemptId}`);
    if (priorIntent && (priorIntent.type !== 'comparison.recovery_started' || JSON.stringify(priorIntent.payload) !== JSON.stringify(intent))) {
      throw new Error('Recovery was already started with a different draft or status.');
    }
    let existing: string | undefined;
    try {
      await stat(reportPath);
      existing = await readFile(reportPath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (existing !== undefined && (!priorIntent || sha256(existing) !== publishedDigest)) {
      throw new Error('A published report already exists; recovery will not overwrite it.');
    }
    await store.append({
      type: 'comparison.recovery_started', operationId: `comparison-recovery-started-${input.attemptId}`,
      payload: intent,
    });
    if (existing === undefined) {
      if (prepared.model) await persistComparisonReportModel(checked.experimentRoot, prepared.model);
      await writeAtomic(reportPath, prepared.html);
    }
    const invocation = { status: 'completed', value: { ...checked.result, status: input.status }, sessionId: checked.sessionId };
    if (!Value.Check(ComparisonInvocationSchema, invocation)) throw new Error('Recovered comparison result does not satisfy ComparisonInvocationSchema.');
    await writeAtomic(join(checked.experimentRoot, 'comparison.json'), `${JSON.stringify(invocation)}\n`);
    await store.append({
      type: 'comparison.recovered', operationId: `comparison-recovered-${input.attemptId}`,
      payload: { attemptId: input.attemptId, draftDigest: checked.draftDigest, revision: checked.revision, status: input.status },
    });
    return { reportPath, draftDigest: publishedDigest };
  } finally {
    await store.close();
  }
}
