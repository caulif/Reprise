import { relative } from 'node:path';

export default async function* reportTimings(events) {
  const timings = new Map();
  for await (const { type, data } of events) {
    if (type === 'test:summary' && data.file) {
      timings.set(data.file, data.duration_ms);
    } else if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.file) {
      timings.set(data.file, (timings.get(data.file) ?? 0) + data.details.duration_ms);
    }
  }
  for (const [file, durationMs] of timings) {
    yield JSON.stringify({ file: relative(process.cwd(), file).replaceAll('\\', '/'), durationMs }) + '\n';
  }
}
