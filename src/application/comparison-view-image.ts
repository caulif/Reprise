import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ComparisonMediaRecord } from '../core/comparison-schema.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import { attachComparisonImages } from './comparison-image-delivery.js';

const Params = Type.Object({ ref: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false });

export function createComparisonViewImageTool(input: {
  media: () => readonly ComparisonMediaRecord[]; attemptRoot: string; allowImages: boolean;
}): AgentToolDefinition {
  const unavailable = (code: string, message: string): AgentToolResult => ({ content: JSON.stringify({ code, message, imageDelivery: 'unavailable' }) });
  return {
    name: 'view_image',
    description: 'View a registered Comparison PNG by its media shortRef or ref. Returns a whole native image within the image budget; no file path or MIME type is needed. Use render_artifact for new states or non-PNG sources.',
    parameters: Params,
    execute: async (params, signal) => {
      signal.throwIfAborted();
      if (!Value.Check(Params, params)) return unavailable('invalid_image_reference', 'Supply {ref: registered media shortRef or ref}; arbitrary paths are not accepted.');
      const media = input.media().find(item => item.shortRef === params.ref || item.ref === params.ref);
      if (!media?.available || !media.contentHash) return unavailable('image_unavailable', 'Choose an available registered media reference or render_artifact from a registered source.');
      if (media.mediaType !== 'image/png') return unavailable('unsupported_image_format', 'Use render_artifact to create a bounded PNG preview from this source.');
      return attachComparisonImages({ result: { content: JSON.stringify({ ref: media.ref, shortRef: media.shortRef }) },
        requested: true, authorized: input.allowImages, attemptRoot: input.attemptRoot, signal,
        images: [{ path: media.reportHref, contentHash: media.contentHash, shortRef: media.shortRef ?? media.ref }] });
    },
  };
}
