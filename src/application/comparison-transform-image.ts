import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { join } from 'node:path';
import { sha256, writeAtomic } from '../core/identity.js';
import { IMAGE_LIMITS } from '../infrastructure/image-limits.js';
import { transformPng } from '../infrastructure/png-transform.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import type { ComparisonEvidenceCatalog } from './comparison-evidence.js';
import { attachComparisonImages } from './comparison-image-delivery.js';

const Size = Type.Integer({ minimum: 1, maximum: 4096 });
const Params = Type.Object({ ref: Type.String({ minLength: 1, maxLength: 512 }),
  crop: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Size, height: Size }, { additionalProperties: false })),
  width: Type.Optional(Size), height: Type.Optional(Size),
}, { additionalProperties: false });

export function createComparisonTransformImageTool(input: {
  catalog: ComparisonEvidenceCatalog; attemptRoot: string; allowImages: boolean; transform?: typeof transformPng;
}): AgentToolDefinition {
  const reply = (code: string, message: string): AgentToolResult => ({ content: JSON.stringify({ code, message }) });
  return { name: 'transform_image', parameters: Params,
    description: 'Crop and/or resize a registered frozen PNG, then view_image the returned media ref. Crop coordinates are original image pixels; crop is applied before resizing. Omit height to preserve aspect ratio with width. No source rerender or arbitrary file path.',
    async execute(params, signal) {
      signal.throwIfAborted();
      if (!Value.Check(Params, params)) return reply('invalid_transform', 'Use ref, optional pixel crop and bounded output width/height.');
      const parent = input.catalog.snapshot().media.find(item => item.shortRef === params.ref || item.ref === params.ref);
      if (!parent?.available || !parent.contentHash || parent.mediaType !== 'image/png') return reply('image_unavailable', 'Choose an available registered PNG.');
      const attached = await attachComparisonImages({ result: { content: '{}' }, requested: true, authorized: input.allowImages,
        attemptRoot: input.attemptRoot, signal, images: [{ path: parent.reportHref, contentHash: parent.contentHash, shortRef: parent.shortRef ?? parent.ref }] });
      const image = attached.contentBlocks?.find(block => block.type === 'image');
      if (!image) return attached;
      const bytes = Buffer.from(image.data, 'base64');
      const originalWidth = bytes.readUInt32BE(16), originalHeight = bytes.readUInt32BE(20);
      const crop = params.crop ?? { x: 0, y: 0, width: originalWidth, height: originalHeight };
      if (crop.x + crop.width > originalWidth || crop.y + crop.height > originalHeight) return reply('invalid_crop', 'Crop must remain within the original image pixels.');
      const width = params.width ?? (params.height ? Math.max(1, Math.round(crop.width * params.height / crop.height)) : crop.width);
      const height = params.height ?? (params.width ? Math.max(1, Math.round(crop.height * params.width / crop.width)) : crop.height);
      if (width > 4096 || height > 4096 || width * height > IMAGE_LIMITS.pixels) return reply('budget_exceeded', 'Choose a smaller crop or output size.');
      let output: Buffer;
      try { output = await (input.transform ?? transformPng)(bytes, { crop, width, height }, signal); }
      catch (error) {
        signal.throwIfAborted();
        return reply('transform_unavailable', error instanceof Error ? error.message : 'Image transform failed.');
      }
      signal.throwIfAborted();
      const contentHash = sha256(output);
      const recipe = { parentHash: parent.contentHash, originalWidth, originalHeight, crop, outputWidth: width, outputHeight: height, order: 'crop_then_resize' as const };
      const id = sha256(JSON.stringify({ recipe, contentHash })).slice(0, 24);
      const path = `media/transform-${id}.png`;
      await writeAtomic(join(input.attemptRoot, path), output);
      const derivation = { kind: 'image_transform' as const, imageTransform: recipe };
      const registered = await input.catalog.registerMedia({ record: { ref: `media:transform-${id}`, side: parent.side,
        inspectPath: path, reportHref: path, mediaType: 'image/png', available: true, contentHash, sourceRef: parent.shortRef ?? parent.ref, derivation },
        sourceRefs: [parent.shortRef ?? parent.ref], origin: 'derived_analysis', derivation }, signal);
      if (registered.status !== 'registered') return reply(registered.code, registered.message);
      return { content: JSON.stringify({ status: 'registered', shortRef: registered.shortRef, contentHash, derivation,
        nextAction: 'view_image the returned shortRef to inspect these pixels.' }) };
    },
  };
}
