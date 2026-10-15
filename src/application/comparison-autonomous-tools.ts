import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ComparisonDraftSubmissionSchema } from '../core/schema.js';
import { pathContainedBy } from '../core/paths.js';
import { ToolPreconditionRejected } from '../core/tool-precondition-rejected.js';
import type { AgentToolDefinition } from '../infrastructure/agent/host.js';
import type { ComparisonDraft } from './comparison-draft.js';

const ReportFileSchema = Type.Object({
  ...Type.Pick(ComparisonDraftSubmissionSchema, ['status', 'category', 'headline']).properties,
  path: Type.String({ minLength: 1, maxLength: 512 }),
  boundary: Type.String({ description: 'Plain text decision-changing condition or uncertainty; empty only when none identified.' }),
  differences: Type.Array(Type.String({ minLength: 1, pattern: '\\S' }), { maxItems: 3, description: 'Zero to three plain text differences with user impact; at most 60 non-whitespace Unicode code points each.' }),
}, { additionalProperties: false });

export function createAutonomousReportTool(draft: ComparisonDraft, attemptRoot: string): AgentToolDefinition {
  const readFragment = async (path: string): Promise<string> => {
    const root = await realpath(attemptRoot);
    const scratch = await realpath(join(root, 'scratch'));
    if (!pathContainedBy(root, scratch)) throw new Error('Scratch directory escapes the attempt.');
    const requested = resolve(root, path);
    if (isAbsolute(path) || !pathContainedBy(scratch, requested)) throw new ToolPreconditionRejected('invalid_path', 'Report fragments must be inside scratch/.');
    const actual = await realpath(requested);
    if (!pathContainedBy(scratch, actual)) throw new Error('Report fragment escapes scratch/.');
    const file = await open(actual, 'r');
    try {
      const bytes = Buffer.alloc(262_145);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 262_144) throw new Error('Report fragment exceeds 262144 bytes.');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
      await file.close();
    }
  };
  return {
    name: 'submit_report',
    description: 'Publish a working HTML fragment from scratch/ into the report shell. Supply status, category, headline (recommendation, at most 80 non-whitespace code points), boundary, differences and path. All author text including captions, tables, code and hidden content has a hard 900 non-whitespace code point budget; no details area. Use semantic HTML, registered data-evidence-ref / data-media-ref and existing component classes; no scripts/styles/external resources. This validates integrity, not meaning. After changes resubmit and preview the current version.',
    parameters: ReportFileSchema,
    execute: async (params, signal) => {
      if (!Value.Check(ReportFileSchema, params)) throw new Error('Invalid report file parameters.');
      signal.throwIfAborted();
      const submission = { formatVersion: 3 as const, boundary: params.boundary, differences: params.differences, status: params.status, category: params.category, headline: params.headline,
        comparisonHtml: await readFragment(params.path) };
      if (!Value.Check(ComparisonDraftSubmissionSchema, submission)) throw new Error('Invalid report content.');
      signal.throwIfAborted();
      const content = await draft.submit(submission);
      return content.startsWith('status=accepted')
        ? { content: JSON.stringify({ ...draft.acceptedReceipt(), next: 'Preview the current report, inspect the result and revise if needed.' }), details: draft.acceptedReceipt() }
        : { content };
    },
  };
}
