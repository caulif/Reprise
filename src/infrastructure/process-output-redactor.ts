import { redactModelVisibleText } from './agent/model-input.js';

const keys = ['authorization', 'apikey', 'api_key', 'api-key', 'token', 'password', 'secret',
  ...['access', 'refresh'].flatMap(prefix => ['', '_', '-'].map(separator => `${prefix}${separator}token`)),
  ...['', '_', '-'].map(separator => `client${separator}secret`)];
const markers = [...keys.flatMap(key => [key, `"${key}"`, `\\"${key}\\"`]), 'bearer', 'http://', 'https://'];
const keyPattern = `(?:${keys.join('|')})`;
const unfinished = new RegExp(`(?:${keyPattern}\\s*[=:]\\s*|bearer\\s+|"${keyPattern}"\\s*:\\s*(?:"(?:\\\\.|[^"\\\\])*)?)$`, 'i');
const unfinishedEscaped = new RegExp(`\\\\"${keyPattern}\\\\"\\s*:\\s*(?:\\\\"(?:(?!\\\\")[\\s\\S])*)?$`, 'i');

/** Retain possible credential prefixes and values until a complete record can be redacted. */
export function processOutputRedactor(emit: (text: string) => void) {
  let pending = '';
  let dropping = false;
  let truncated = false;
  const send = (text: string) => { if (text) emit(redactModelVisibleText(text).text); };
  return {
    get truncated() { return truncated; },
    append(text: string) {
      if (dropping) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        dropping = false;
        text = text.slice(newline + 1);
      }
      pending += text;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const record = pending.slice(0, newline + 1);
        if (unfinished.test(record) || unfinishedEscaped.test(record)) {
          newline = pending.indexOf('\n', newline + 1);
          continue;
        }
        send(record);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      const lower = pending.toLowerCase();
      const starts = markers.map(marker => lower.indexOf(marker)).filter(index => index >= 0);
      let retain = starts.length ? Math.min(...starts) : pending.length;
      for (const marker of markers) for (let length = 1; length < marker.length; length++) {
        if (lower.endsWith(marker.slice(0, length))) retain = Math.min(retain, pending.length - length);
      }
      send(pending.slice(0, retain));
      pending = pending.slice(retain);
      if (pending.length > 65_536) {
        emit('[oversized output line omitted]\n');
        pending = '';
        dropping = true;
        truncated = true;
      }
    },
    finish() {
      if (unfinished.test(pending) || unfinishedEscaped.test(pending)) emit('[incomplete sensitive output omitted]');
      else send(pending);
      pending = '';
    },
  };
}
