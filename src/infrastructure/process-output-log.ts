import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactModelVisibleText } from './agent/model-input.js';

/** Preserve bounded, redacted diagnostic output without splitting tokens at pipe chunk boundaries. */
export function processOutputLog(path: string, onFailure?: (error: unknown) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  let truncated = false;
  let bytes = 0;
  let failure: unknown;
  const failed = (error: unknown) => { if (failure === undefined) { failure = error; onFailure?.(error); } };
  let chain: Promise<void> = mkdir(dirname(path), { recursive: true }).then(() => undefined).catch(failed);
  const save = (text: string) => {
    const safe = redactModelVisibleText(text).text;
    const remaining = 16_777_216 - bytes;
    if (Buffer.byteLength(safe) > remaining) truncated = true;
    if (remaining <= 0) return;
    const accepted = Buffer.from(safe).subarray(0, remaining);
    bytes += accepted.length;
    chain = chain.then(() => appendFile(path, accepted)).catch(failed);
  };
  return {
    get truncated() { return truncated; },
    append(chunk: Buffer) {
      let text = decoder.write(chunk);
      if (dropping) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        save('[oversized output line omitted]\n');
        dropping = false;
        text = text.slice(newline + 1);
      }
      pending += text;
      const newline = pending.lastIndexOf('\n');
      if (newline >= 0) { save(pending.slice(0, newline + 1)); pending = pending.slice(newline + 1); }
      // A huge line may contain a split secret. Omit it instead of persisting a partially redacted token.
      if (pending.length > 65_536) { pending = ''; dropping = true; truncated = true; }
    },
    async finish() {
      save(dropping ? '[oversized output line omitted]\n' : pending + decoder.end()); pending = '';
      await chain;
      if (failure) throw new Error('Process output log persistence failed.', { cause: failure });
    },
  };
}
