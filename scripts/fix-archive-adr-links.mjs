#!/usr/bin/env node
/**
 * Rewrite relative outbound links in docs/decisions/archive/** after git mv depth +1.
 * Run from repo root; idempotent on second pass.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const HOT = new Set(
  readdirSync(join(ROOT, 'docs/decisions/accepted')).filter((f) => f.endsWith('.md')),
);
const ARCHIVE_DIRS = [
  'docs/decisions/archive/accepted-2026-09',
  'docs/decisions/archive/superseded',
];
const IGNORED = /^(https?:|mailto:|#)/i;

function listMd(dir) {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${dir}/${f}`);
}

function resolveHref(fromFile, href) {
  const [pathPart] = href.split('#');
  if (!pathPart) return join(ROOT, fromFile);
  return resolve(dirname(join(ROOT, fromFile)), pathPart);
}

function existsHref(fromFile, href) {
  if (IGNORED.test(href)) return true;
  return existsSync(resolveHref(fromFile, href));
}

function rewriteHref(fromFile, href) {
  if (IGNORED.test(href)) return href;
  const [pathPart, fragment = ''] = href.split('#');
  const frag = fragment ? `#${fragment}` : '';

  const tryList = [];
  if (pathPart.startsWith('../accepted/')) {
    const base = pathPart.slice('../accepted/'.length);
    if (HOT.has(base)) tryList.push(`../../accepted/${base}${frag}`);
    tryList.push(`../accepted-2026-09/${base}${frag}`);
  }
  if (pathPart.startsWith('./')) {
    const base = pathPart.slice(2);
    if (HOT.has(base)) tryList.push(`../../accepted/${base}${frag}`);
    tryList.push(pathPart + frag);
  }
  if (pathPart.startsWith('../')) {
    tryList.push(`../${pathPart}${frag}`);
  }
  tryList.push(pathPart + frag);

  for (const candidate of tryList) {
    const cPath = candidate.split('#')[0];
    const cFrag = candidate.includes('#') ? `#${candidate.split('#').slice(1).join('#')}` : '';
    if (existsHref(fromFile, cPath + cFrag)) return cPath + cFrag;
  }
  return href;
}

function fixFile(rel) {
  const abs = join(ROOT, rel);
  let text = readFileSync(abs, 'utf8');
  const orig = text;
  text = text.replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (full, label, hrefRaw) => {
    const href = hrefRaw.trim();
    if (IGNORED.test(href)) return full;
    if (existsHref(rel, href)) return full;
    const fixed = rewriteHref(rel, href);
    if (fixed === href) return full;
    return full.replace(`(${hrefRaw})`, `(${fixed})`);
  });
  if (text !== orig) writeFileSync(abs, text);
  return text !== orig;
}

function countBroken(rel) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  let n = 0;
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1].trim();
    if (!IGNORED.test(href) && !existsHref(rel, href)) n++;
  }
  return n;
}

let changed = 0;
for (const dir of ARCHIVE_DIRS) {
  for (const rel of listMd(dir)) {
    if (fixFile(rel)) changed++;
  }
}

let broken = 0;
for (const dir of ARCHIVE_DIRS) {
  for (const rel of listMd(dir)) broken += countBroken(rel);
}
console.log(JSON.stringify({ filesRewritten: changed, brokenLinksRemaining: broken }, null, 2));
if (broken > 0) process.exitCode = 1;
