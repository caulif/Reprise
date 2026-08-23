#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME_EXCEPTIONS = new Set(['README.md', 'AGENTS.md', 'MASTER.md']);
const FORBIDDEN_NAME = /\b(final|latest|new)\b|v\d+|-\d+\.\d+/i;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const DECISION_NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;
const DECISION_SECTIONS = ['## 问题', '## 决定', '## 备选方案', '## 影响', '## 验证'];
const PROPOSAL_HEADINGS = ['## 计划', '## 迁移计划', '## 验收标准'];
const IGNORED_LINK_PREFIX = /^(https?:|mailto:|#)/i;

function splitLines(text) {
  return text.split(/\r?\n/);
}

function githubSlug(text) {
  const stripped = text
    .replace(/`+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
  return stripped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\-\s\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function headingAnchors(text) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of splitLines(text)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const base = githubSlug(heading[2]);
      const seen = counts.get(base) ?? 0;
      const slug = seen === 0 ? base : `${base}-${seen}`;
      counts.set(base, seen + 1);
      if (slug) anchors.add(slug);
    }
    for (const match of line.matchAll(/<a\s+[^>]*id=["']([^"']+)["'][^>]*>/gi)) {
      if (match[1]) anchors.add(match[1]);
    }
  }
  return anchors;
}

function countableChars(text) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const withoutUrls = withoutFences.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1');
  return withoutUrls.replace(/\s/g, '').length;
}

function extractMarkdownLinks(text) {
  const links = [];
  for (const [index, line] of splitLines(text).entries()) {
    for (const match of line.matchAll(/!?\[([^\]]*)\]\(([^)]+)\)/g)) {
      links.push({ line: index + 1, href: match[2].trim(), label: match[1] });
    }
  }
  return links;
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\s+$/, '');
}

function trackedFiles(glob) {
  const output = git(['ls-files', '-z', glob]);
  return output ? output.split('\0').filter(Boolean) : [];
}

function posixPath(value) {
  return value.split(sep).join('/');
}

function resolveLink(fromFile, href) {
  const [pathPart, fragment] = href.split('#');
  const target = pathPart ? resolve(dirname(join(ROOT, fromFile)), pathPart) : join(ROOT, fromFile);
  return { target, fragment: fragment ?? '', relative: posixPath(relative(ROOT, target)) };
}

function parseModelDirectories(markdown) {
  const match = /## 目录模型\r?\n\r?\n```text\r?\n([\s\S]*?)```/.exec(markdown);
  if (!match) throw new Error('documentation-structure.md 缺少「目录模型」代码块');
  const dirs = new Set();
  for (const line of splitLines(match[1])) {
    const item = /^[├└]──\s+(\S+)/.exec(line);
    if (!item) continue;
    const name = item[1].replace(/\/$/, '').split('/')[0];
    if (!name || name === 'docs') continue;
    if (/\.[a-z0-9]+$/i.test(name) && !name.startsWith('.')) continue;
    dirs.add(name);
  }
  return dirs;
}

function trackedTopLevelDocsDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = file.replace(/^docs\//, '').split('/');
    if (parts.length > 1 && parts[0]) dirs.add(parts[0]);
  }
  return dirs;
}

function checkDecisionRecord(relativePath, text) {
  const errors = [];
  const lines = splitLines(text);
  const fileName = relativePath.split('/').pop() ?? '';
  const folder = relativePath.includes('/proposed/') ? 'proposed' : relativePath.includes('/accepted/') ? 'accepted' : '';
  if (!DECISION_NAME.test(fileName)) {
    errors.push(`${relativePath}:1  文件名  (必须匹配 YYYY-MM-DD-kebab.md)`);
  }
  if (!/^# 决策：.+/.test(lines[0] ?? '')) {
    errors.push(`${relativePath}:1  标题  (第 1 行必须是 # 决策：<标题>)`);
  }
  if ((lines[1] ?? '') !== '') {
    errors.push(`${relativePath}:2  空行  (第 2 行必须为空)`);
  }
  const status = /^状态：(proposed|accepted)$/.exec(lines[2] ?? '');
  if (!status) {
    errors.push(`${relativePath}:3  状态  (第 3 行必须是 状态：proposed|accepted)`);
  } else if (folder && status[1] !== folder) {
    errors.push(`${relativePath}:3  状态  (状态 ${status[1]} 与目录 ${folder} 不一致)`);
  }
  const headingLines = lines.filter((line) => line.startsWith('## '));
  if (DECISION_SECTIONS.some((section, index) => headingLines[index] !== section) || headingLines.length !== DECISION_SECTIONS.length) {
    errors.push(`${relativePath}:1  小节  (必须按顺序包含 ${DECISION_SECTIONS.join(' ')})`);
  }
  const altIndex = lines.findIndex((line) => line === '## 备选方案');
  const nextIndex = lines.findIndex((line, index) => index > altIndex && line.startsWith('## '));
  const altBody = lines.slice(altIndex + 1, nextIndex === -1 ? undefined : nextIndex);
  if (!altBody.some((line) => /^\*\*[^*]+\*\*/.test(line))) {
    errors.push(`${relativePath}:${altIndex + 1 || 1}  备选方案  (至少要有一个以粗体开头的段落)`);
  }
  if (folder === 'accepted') {
    for (const [index, line] of lines.entries()) {
      if (PROPOSAL_HEADINGS.includes(line)) {
        errors.push(`${relativePath}:${index + 1}  ${line}  (accepted 记录不得保留提案期标题)`);
      }
    }
  }
  return errors;
}

function checkFileName(relativePath) {
  if (!relativePath.startsWith('docs/') || !relativePath.endsWith('.md')) return [];
  const base = relativePath.split('/').pop() ?? '';
  if (NAME_EXCEPTIONS.has(base)) return [];
  if (relativePath.startsWith('docs/decisions/') && DECISION_NAME.test(base)) return [];
  const errors = [];
  if (!KEBAB.test(base)) errors.push(`${relativePath}:1  文件名  (必须是小写 kebab-case)`);
  if (FORBIDDEN_NAME.test(base)) errors.push(`${relativePath}:1  文件名  (不得含 final/latest/new 或版本号后缀)`);
  return errors;
}

function checkClaudeMd(text) {
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (trimmed === '见 AGENTS.md。') return [];
  return ['CLAUDE.md:1  内容  (必须只有一行「见 AGENTS.md。」)'];
}

function checkBudgets(manifest, files) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['scripts/doc-budgets.manifest.json:1  清单  (必须是路径到正整数上限的对象)'];
  }
  for (const [path, limit] of Object.entries(manifest)) {
    if (!Number.isInteger(limit) || limit <= 0) {
      errors.push(`${path}:1  预算  (上限必须是正整数)`);
      continue;
    }
    const text = files.get(path);
    if (text === undefined) {
      errors.push(`${path}:1  预算  (manifest 中的文件不存在)`);
      continue;
    }
    const actual = countableChars(text);
    if (actual > limit) {
      errors.push(`${path}:1  预算  (${actual} 字符超出 ${limit} 上限 —— 先把属于别层的内容搬走，再压缩本层内容，最后才提高上限并在 decisions/ 说明理由)`);
    }
  }
  return errors;
}

function isIgnored(relativePath) {
  try {
    git(['check-ignore', '-q', relativePath]);
    return true;
  } catch {
    return false;
  }
}

function checkLinks(markdownFiles, tracked) {
  const errors = [];
  const trackedSet = new Set(tracked);
  for (const [file, text] of markdownFiles) {
    for (const link of extractMarkdownLinks(text)) {
      if (IGNORED_LINK_PREFIX.test(link.href)) continue;
      let resolved;
      try {
        resolved = resolveLink(file, link.href);
      } catch {
        errors.push(`${file}:${link.line}  ${link.href}  (目标不存在)`);
        continue;
      }
      if (!existsSync(resolved.target)) {
        errors.push(`${file}:${link.line}  ${link.href}  (目标不存在)`);
        continue;
      }
      if (!trackedSet.has(resolved.relative) && isIgnored(resolved.relative)) {
        errors.push(`${file}:${link.line}  ${link.href}  (目标不存在)`);
        continue;
      }
      if (resolved.fragment && resolved.relative.endsWith('.md')) {
        const anchors = headingAnchors(readFileSync(resolved.target, 'utf8'));
        if (!anchors.has(resolved.fragment)) {
          errors.push(`${file}:${link.line}  ${link.href}  (目标中没有该锚点)`);
        }
      }
    }
  }
  return errors;
}

function loadTrackedMarkdown() {
  const files = new Map();
  for (const file of trackedFiles('*.md')) {
    files.set(file, readFileSync(join(ROOT, file), 'utf8'));
  }
  return files;
}

function runRepoChecks() {
  const errors = [];
  const markdown = loadTrackedMarkdown();
  const tracked = trackedFiles('.');
  errors.push(...checkLinks(markdown, tracked));

  const structure = markdown.get('docs/documentation-structure.md');
  if (!structure) {
    errors.push('docs/documentation-structure.md:1  目录模型  (文件不存在)');
  } else {
    const model = parseModelDirectories(structure);
    const actual = trackedTopLevelDocsDirs(tracked.filter((file) => file.startsWith('docs/')));
    for (const dir of model) {
      if (!actual.has(dir)) errors.push(`docs/documentation-structure.md:1  目录模型  (模型里有而磁盘没有: ${dir})`);
    }
    for (const dir of actual) {
      if (!model.has(dir)) errors.push(`docs/documentation-structure.md:1  目录模型  (磁盘有而模型没有: ${dir})`);
    }
  }

  for (const [file, text] of markdown) {
    if (file.startsWith('docs/decisions/proposed/') || file.startsWith('docs/decisions/accepted/')) {
      errors.push(...checkDecisionRecord(file, text));
    }
    errors.push(...checkFileName(file));
  }

  const manifestPath = join(ROOT, 'scripts/doc-budgets.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const budgetFiles = new Map();
  for (const path of Object.keys(manifest)) {
    const absolute = join(ROOT, path);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      budgetFiles.set(path, readFileSync(absolute, 'utf8'));
    }
  }
  errors.push(...checkBudgets(manifest, budgetFiles));

  const claude = existsSync(join(ROOT, 'CLAUDE.md')) ? readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8') : '';
  errors.push(...checkClaudeMd(claude));
  return errors;
}

function selfTest() {
  const failures = [];
  const expectFail = (name, errors) => {
    if (!errors.length) failures.push(`${name}: 应当拒绝坏输入，却通过了`);
  };
  expectFail('断链', checkLinks(new Map([['docs/README.md', '[x](./missing.md)\n']]), ['docs/README.md']));
  expectFail('目录模型漂移', (() => {
    const model = parseModelDirectories('#\n\n## 目录模型\n\n```text\ndocs/\n├── product/\n```\n');
    const actual = trackedTopLevelDocsDirs(['docs/architecture/overview.md']);
    const errors = [];
    for (const dir of model) if (!actual.has(dir)) errors.push(`missing ${dir}`);
    for (const dir of actual) if (!model.has(dir)) errors.push(`extra ${dir}`);
    return errors;
  })());
  expectFail('决策记录缺备选方案', checkDecisionRecord('docs/decisions/accepted/2026-08-14-sample.md', [
    '# 决策：示例',
    '',
    '状态：accepted',
    '',
    '## 问题',
    'x',
    '## 决定',
    'y',
    '## 备选方案',
    '没有粗体',
    '## 影响',
    'z',
    '## 验证',
    'w',
    '',
  ].join('\n')));
  expectFail('超预算', checkBudgets({ 'docs/AGENTS.md': 1 }, new Map([['docs/AGENTS.md', '一二三四五']])));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('verify-docs self-test: 4 种坏输入均被拒绝');
}

function main() {
  selfTest();
  if (process.exitCode) return;
  if (process.argv.includes('--self-test')) return;
  const errors = runRepoChecks();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log('verify-docs: ok');
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
