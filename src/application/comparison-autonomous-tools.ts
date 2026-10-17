import { ComparisonPairedDifferenceSchema } from '../core/comparison-schema.js';
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
  reason: Type.String({ minLength: 1, pattern: '\\S', description: 'One short sentence explaining the recommendation.' }),
  pairedDifferences: Type.Array(ComparisonPairedDifferenceSchema, { maxItems: 3, description: 'Zero to three aligned differences, each with dimension, baseline, candidate, impact and independent baselineAssessment/candidateAssessment (better/worse/similar/unknown/unverified). Use better/worse only for supported relative differences, never infer from recommended side. Missing evidence is unknown/unverified, not worse. Host controls colors and screen-reader status labels; do not add visible rating-word prefixes; judgments remain unverified author declarations. Older reports may omit assessments and remain neutral.' }),
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
    description: 'Publish a working HTML fragment from scratch/ into the report shell. Supply status, category, headline (exactly 推荐当前 / 推荐历史 / 暂不能推荐, or Recommend Current / Recommend History / Cannot recommend yet), reason (one short sentence), boundary (before-adoption condition), pairedDifferences and path. Category is an abstract task title of at most 32 non-whitespace code points, never the original task or a filename. Submit up to three aligned differences with dimension, baseline, candidate, impact and optional registered evidenceRefs. The fragment is only for full registered image figures with nearby captions identifying the side and corresponding visual difference; Host adds keyboard-accessible original-image links; use an empty fragment for nonvisual tasks. Never put a second evidence table or prose differences in it. All author text including reason, boundary, paired results, impact and captions has a hard 900 non-whitespace code point budget; no details area. Use semantic HTML, registered data-evidence-ref / data-media-ref and existing component classes; no scripts/styles/external resources. Use generic roles and artifacts, not names, organizations, paths, filenames, contacts or source quotations containing them. Only include images and abstract paired results reviewed for privacy; omit unsafe evidence. This validates integrity and obvious text identifiers, not semantic accuracy or complete anonymization. Do not add metric explanations or footnotes outside the three metric rows. Never state faster/slower percentages unless the persisted timing comparison status is comparable. After changes resubmit and preview the current version.',
    parameters: ReportFileSchema,
    execute: async (params, signal) => {
      if (!Value.Check(ReportFileSchema, params)) throw new Error('Invalid report file parameters.');
      signal.throwIfAborted();
      const submission = { formatVersion: 6 as const, boundary: params.boundary, reason: params.reason, pairedDifferences: params.pairedDifferences, status: params.status, category: params.category, headline: params.headline,
        comparisonHtml: (await readFragment(params.path)) || "<div></div>" };
      if (!Value.Check(ComparisonDraftSubmissionSchema, submission)) throw new Error('Invalid report content.');
      signal.throwIfAborted();
      const content = await draft.submit(submission);
      return content.startsWith('status=accepted')
        ? { content: JSON.stringify({ ...draft.acceptedReceipt(), next: 'Preview the current report, inspect the result and revise if needed.' }), details: draft.acceptedReceipt() }
        : { content };
    },
  };
}
