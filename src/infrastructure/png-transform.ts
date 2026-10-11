import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { openCdpBrowserSession } from './artifact-cdp.js';
import { boundedPng, IMAGE_LIMITS } from './image-limits.js';

export type PngTransform = { crop: { x: number; y: number; width: number; height: number }; width: number; height: number };
const ResultSchema = Type.Object({ data: Type.String({ maxLength: 4_194_304 }) }, { additionalProperties: false });

/** Decode only bounded, frozen PNG bytes; no source document or arbitrary script is loaded. */
export async function transformPng(bytes: Buffer, transform: PngTransform, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (bytes.length > IMAGE_LIMITS.bytes || !boundedPng(bytes)) throw new Error('Invalid bounded PNG input.');
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const browser = await openCdpBrowserSession(bounded);
  if ('failure' in browser) throw new Error(`Image transform unavailable: ${browser.failure}`);
  try {
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const expression = `(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${bytes.toString('base64')}';
      await image.decode();
      const canvas = document.createElement('canvas');
      const p = ${JSON.stringify(transform)};
      canvas.width = p.width; canvas.height = p.height;
      const c = p.crop;
      canvas.getContext('2d').drawImage(image, c.x, c.y, c.width, c.height, 0, 0, p.width, p.height);
      return { data: canvas.toDataURL('image/png').split(',')[1] };
    })()`;
    const result = await browser.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails || !Value.Check(ResultSchema, result.result?.value)) throw new Error('PNG decoding or transform failed.');
    const output = Buffer.from(result.result.value.data, 'base64');
    if (output.length > IMAGE_LIMITS.bytes || !boundedPng(output)
      || output.readUInt32BE(16) !== transform.width || output.readUInt32BE(20) !== transform.height) throw new Error('PNG transform exceeded image limits.');
    signal.throwIfAborted();
    return output;
  } finally { await browser.close(); }
}
