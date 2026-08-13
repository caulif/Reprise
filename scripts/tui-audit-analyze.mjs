import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FORBIDDEN_COMPACT } from '../dist/src/tui/theme.js';

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

const framesDir = join(process.cwd(), 'docs', 'tui-audit', 'frames');
const files = (await readdir(framesDir)).filter((name) => name.endsWith('.txt')).sort();
const findings = [];

for (const file of files) {
  const name = file.replace(/\.txt$/, '');
  const width = name.includes('compact') || name.includes('minimum') ? (name.includes('minimum') ? 31 : 60) : 120;
  const text = await readFile(join(framesDir, file), 'utf8');
  const lines = text.split('\n');
  const stripped = lines.map((line) => stripAnsi(line));
  const issues = [];

  const vis = stripped.map((line) => visibleWidth(line));
  const overflow = vis.map((value, index) => ({ index: index + 1, value })).filter((item) => item.value > width);
  if (overflow.length) issues.push(`overflow ${overflow.slice(0, 5).map((item) => `L${item.index}=${item.value}`).join(', ')}`);

  const tops = stripped.filter((line) => line.includes('┌'));
  const bottoms = stripped.filter((line) => line.includes('└'));
  if (tops.length && bottoms.length) {
    const mismatches = [];
    const count = Math.min(tops.length, bottoms.length);
    for (let index = 0; index < count; index += 1) {
      const topW = visibleWidth(tops[index]);
      const bottomW = visibleWidth(bottoms[index]);
      if (topW !== bottomW) mismatches.push(`panel ${index + 1} top=${topW} bottom=${bottomW}`);
    }
    if (mismatches.length) issues.push(mismatches.join('; '));
  }

  if (width < 78 && width >= 32 && FORBIDDEN_COMPACT.test(text)) {
    issues.push('compact contains forbidden glyphs');
  }
  if (width < 78 && /[—]/.test(text)) issues.push('compact contains em dash');
  if (/\u001b\[[0-9;]*m[^\u001b]*\u001b\[0m\.\.\.\u001b\[0m/.test(text) || /\[0m\.\.\.\[0m/.test(text)) {
    issues.push('ANSI truncation artifact');
  }
  const messageHits = stripped.filter((line) => /Welcome back\. Use \/help|ENOTDIR:/.test(line));
  if (messageHits.length >= 2) issues.push(`status message duplicated x${messageHits.length}`);

  findings.push({ name, width, rows: lines.length, maxVisible: Math.max(0, ...vis), issues });
}

for (const item of findings) {
  const mark = item.issues.length ? 'ISSUE' : 'ok';
  console.log(`${mark}\t${item.name}\tw=${item.width}\trows=${item.rows}\tmax=${item.maxVisible}\t${item.issues.join(' | ')}`);
}
console.log(`---\n${findings.filter((item) => item.issues.length).length} frames with issues / ${findings.length}`);
