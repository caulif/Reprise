#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BEGIN = (slug) => `<!-- BEGIN GENERATED ${slug} (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->`;
const END = (slug) => `<!-- END GENERATED ${slug} -->`;

function describeType(schema) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.anyOf) return schema.anyOf.map(describeType).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === 'array') return `${describeType(schema.items)}[]`;
  if (schema.type === 'object') return 'object';
  if (schema.type === 'string' && schema.pattern) return 'string';
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'unknown';
}

function fieldsOf(schema) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    type: describeType(value),
    optional: !required.has(name),
  }));
}

function table(rows) {
  return [
    '| 字段 | 类型 | 可选 |',
    '|---|---|---|',
    ...rows.map((row) => `| \`${row.name}\` | ${row.type} | ${row.optional ? '是' : '否'} |`),
    '',
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRegion(text, slug, body) {
  const begin = BEGIN(slug);
  const end = END(slug);
  const block = `${begin}\n${body.trim()}\n${end}`;
  if (!text.includes(begin) || !text.includes(end)) {
    throw new Error(`missing generated region ${slug}`);
  }
  const next = text.replace(new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`), block);
  if (next === text && !text.includes(block)) {
    throw new Error(`generated region ${slug} did not match`);
  }
  return next;
}

function toLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function selfTest() {
  const slug = 'event-catalog';
  const original = `${BEGIN(slug)}\nGARBAGE\n${END(slug)}`;
  const next = replaceRegion(original, slug, '| field |');
  if (!next.includes('| field |') || next.includes('GARBAGE') || toLf(original) === toLf(next)) {
    throw new Error('gen-docs self-test: replaceRegion did not replace a marked region');
  }
  console.log('gen-docs self-test: replaceRegion updates marked regions');
}

async function generate() {
  const schema = await import(pathToFileURL(join(ROOT, 'dist/src/core/schema.js')).href);
  const eventBody = table(fieldsOf(schema.EventEnvelopeSchema));
  const recordBody = [
    '### TaskCase',
    '',
    table(fieldsOf(schema.TaskCaseSchema)),
    '### RunRecord',
    '',
    table(fieldsOf(schema.RunRecordSchema)),
  ].join('\n');
  const files = [
    ['docs/architecture/persistence-and-crash-consistency.md', 'event-catalog', eventBody],
    ['docs/architecture/run-outcome.md', 'record-fields', recordBody],
  ];
  const written = [];
  for (const [relative, slug, body] of files) {
    const path = join(ROOT, relative);
    const next = toLf(replaceRegion(await readFile(path, 'utf8'), slug, body));
    written.push({ path, relative, next });
  }
  return written;
}

async function main() {
  selfTest();
  const check = process.argv.includes('--check');
  const files = await generate();
  const stale = [];
  let wrote = 0;
  for (const file of files) {
    const current = toLf(await readFile(file.path, 'utf8'));
    if (current === file.next) continue;
    if (check) {
      stale.push(file.relative);
      continue;
    }
    await writeFile(file.path, file.next, 'utf8');
    wrote += 1;
  }
  if (check && stale.length) {
    throw new Error(`generated docs are stale: ${stale.join(', ')}\n运行 npm run gen:docs 并提交受影响的文档`);
  }
  console.log(check ? 'verify:generated: ok' : `gen-docs: wrote ${wrote} files`);
}

await main();
