import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const DatasetSchema = Type.Object({ schemaVersion: Type.Literal(1), experiments: Type.Literal(1000),
  runsPerExperiment: Type.Literal(2), requestsPerRun: Type.Literal(4), synthetic: Type.Literal(true) });
const Count = Type.Integer({ minimum: 0 });
const SampleSchema = Type.Object({ operation: Type.String(), elapsedMs: Type.Number({ minimum: 0 }),
  counts: Type.Object({ readFile: Count, readBytes: Count, readdir: Count, lstat: Count, stat: Count }),
  startRss: Count, peakRss: Count, processMaxRssKiB: Count, result: Type.Unknown() });

const distRoot = resolve(process.env.REPRISE_BENCH_DIST ?? 'dist');
const fromDist = path => import(pathToFileURL(join(distRoot, path)).href);

const mode = process.argv[2];
const root = resolve(process.argv[3] ?? 'C:/rh-history-benchmark-20261015');
if (mode === 'generate') {
  const { input, VerifiedRuntime } = await fromDist('test/codex-experiment-support.js');
  const { startExperiment } = await fromDist('src/application/experiment.js');
  const { ExperimentStore } = await fromDist('src/infrastructure/store/experiment-store.js');
  const { experimentAgentAuditSink } = await fromDist('src/application/experiment-helpers.js');
  const { callerLoopHooks } = await fromDist('src/infrastructure/agent/audit.js');
  const { inlineBody } = await fromDist('src/infrastructure/agent/model-input.js');
  const { sha256 } = await fromDist('src/core/identity.js');
  await fs.mkdir(root, { recursive: true });
  if ((await fs.readdir(root)).length) throw new Error('Benchmark generation requires an empty dedicated directory.');
  await fs.writeFile(join(root, 'benchmark-dataset.json'), JSON.stringify({ schemaVersion: 1, experiments: 1000, runsPerExperiment: 2, requestsPerRun: 4, synthetic: true }), { flag: 'wx' });
  for (let i = 0; i < 1000; i++) {
    const base = input(root, new VerifiedRuntime());
    await fs.mkdir(base.sourceRoot, { recursive: true });
    const experimentId = `bench-${String(i).padStart(4, '0')}`;
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    for (const runId of ['run-1', 'run-2']) {
      await startExperiment({ ...base, experimentId, runId, now, compare: false }).result;
    }
    const experimentRoot = join(base.dataDir, 'experiments', experimentId);
    const store = await ExperimentStore.open(experimentRoot, experimentId);
    await store.acquireWriter();
    try {
      for (const runId of ['run-1', 'run-2']) {
        const audit = experimentAgentAuditSink(store, runId);
        const sessionId = `session-${runId}`;
        await audit.append({ type: 'agent.session_started', sessionId, role: 'comparison', payload: { systemPrompt: 'Synthetic benchmark', tools: [] } });
        await audit.append({ type: 'agent.message_appended', sessionId, role: 'comparison', payload: { body: inlineBody('Synthetic input') } });
        const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
        for (let requestIndex = 1; requestIndex <= 4; requestIndex++) {
          const context = { systemPrompt: 'Synthetic benchmark', messages: [{ role: 'user', content: [{ type: 'text', text: `${requestIndex}:` + 'x'.repeat(16384) }, image] }], tools: [] };
          await callerLoopHooks(sessionId, 'comparison', { invocationId: `inv-${requestIndex}`, requestIndex }, audit).onModelRequest({ model: 'fixture', scope: 'generation', digest: sha256(JSON.stringify(context)), messageCount: 1, images: [image], generationContext: context });
        }
        const snapshot = join(experimentRoot, 'benchmark-snapshots', runId);
        await fs.mkdir(snapshot, { recursive: true });
        await Promise.all(Array.from({ length: 12 }, (_, n) => fs.writeFile(join(snapshot, `snapshot-${n}.txt`), 's'.repeat(4096))));
      }
    } finally { await store.close(); }
    if (i % 100 === 0) console.log(JSON.stringify({ generated: i + 1 }));
  }
} else if (mode === 'sample') {
  const operation = process.argv[4];
  const counts = { readFile: 0, readBytes: 0, readdir: 0, lstat: 0, stat: 0 };
  for (const method of ['readFile', 'readdir', 'lstat', 'stat']) {
    const original = fs[method];
    fs[method] = async (...args) => {
      counts[method]++;
      const result = await original(...args);
      if (method === 'readFile') counts.readBytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength;
      return result;
    };
  }
  syncBuiltinESMExports();
  const { readLocalHistory, readLocalHistoryListing, readLocalHistoryExperiment } = await fromDist('src/application/experiment-history-list.js');
  const { listHistoryPage } = await fromDist('src/application/experiment-queries.js');
  const { readCommittedExperimentHistory } = await fromDist('src/application/experiment-history-read.js');
  const { readExperimentEvents } = await fromDist('src/application/experiment-event-read.js');
  for (const key of Object.keys(counts)) counts[key] = 0;
  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  const start = performance.now();
  let result;
  if (operation === 'recent') result = (await (readLocalHistoryListing ?? readLocalHistory)(root)).experiments[0]?.experimentId;
  else if (operation === 'first') result = (await listHistoryPage({ dataDir: root, limit: 20 })).items.map(item => item.experimentId);
  else if (operation === 'next') result = (await listHistoryPage({ dataDir: root, limit: 20, cursor: `bench-${String(Number(process.argv[5]) - 20).padStart(4, '0')}` })).items.map(item => item.experimentId);
  else if (operation === 'detail') {
    const detail = readLocalHistoryExperiment ? await readLocalHistoryExperiment(root, 'bench-0000') : undefined;
    result = { events: (await readExperimentEvents({ dataDir: root, experimentId: 'bench-0000' })).events.length,
      modelInputAudit: detail?.modelInputAudit ?? 'not-performed-by-original-ui' };
  }
  else if (operation === 'audit') result = await readCommittedExperimentHistory(join(root, 'experiments', 'bench-0000'), 'bench-0000', 'run-2');
  else if (operation === 'size') {
    const size = async path => { let bytes = 0; for (const item of await fs.readdir(path, { withFileTypes: true })) { const child = join(path, item.name); if (item.isDirectory()) bytes += await size(child); else if (item.isFile()) bytes += (await fs.lstat(child)).size; } return bytes; };
    result = await size(root);
  } else throw new Error(`Unknown operation ${operation}`);
  clearInterval(timer);
  console.log(JSON.stringify({ operation, elapsedMs: performance.now() - start, counts, startRss, peakRss: Math.max(peakRss, process.memoryUsage().rss), processMaxRssKiB: process.resourceUsage().maxRSS, result }));
} else if (mode === 'measure') {
  const marker = JSON.parse(await fs.readFile(join(root, 'benchmark-dataset.json'), 'utf8'));
  if (!Value.Check(DatasetSchema, marker)) throw new Error('Not this benchmark dataset.');
  const output = [];
  for (const size of [10, 100, 1000]) {
    const dataDir = size === 1000 ? join(root, 'data') : join(root, `sample-${size}`);
    await fs.mkdir(join(dataDir, 'experiments'), { recursive: true });
    await fs.mkdir(join(dataDir, 'cases'), { recursive: true });
    if (size !== 1000 && !(await fs.readdir(join(dataDir, 'experiments'))).length) {
      await fs.cp(join(root, 'data', 'cases'), join(dataDir, 'cases'), { recursive: true, errorOnExist: true, force: false });
      for (let i = 0; i < size; i++) { const id = `bench-${String(i).padStart(4, '0')}`; await fs.cp(join(root, 'data', 'experiments', id), join(dataDir, 'experiments', id), { recursive: true, errorOnExist: true, force: false }); }
    }
    const ids = (await fs.readdir(join(dataDir, 'experiments'))).sort();
    if (ids.length !== size || ids.some((id, i) => id !== `bench-${String(i).padStart(4, '0')}`)) throw new Error('Incomplete benchmark subset.');
    for (const operation of ['recent', 'first', ...(size > 20 ? ['next'] : []), 'detail', 'audit', 'size']) {
      for (let repetition = 0; repetition < 5; repetition++) {
        const run = spawnSync(process.execPath, [import.meta.filename, 'sample', dataDir, operation, String(size)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (run.status !== 0) throw new Error(run.stderr || run.stdout);
        const sample = JSON.parse(run.stdout.trim().split('\n').at(-1));
        if (!Value.Check(SampleSchema, sample)) throw new Error('Invalid benchmark child result.');
        output.push({ size, repetition, ...sample });
        console.log(JSON.stringify({ size, repetition, operation, elapsedMs: sample.elapsedMs }));
      }
    }
  }
  await fs.writeFile(process.argv[4], JSON.stringify({ distRoot, node: process.version, platform: process.platform, arch: process.arch, cache: 'fresh process, shared OS file cache, no forced cold-cache eviction', samples: output }, null, 2));
} else throw new Error('Expected generate, sample or measure');
