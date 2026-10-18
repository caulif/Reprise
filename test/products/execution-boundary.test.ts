import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ExecutionBoundarySchema, RunManifestSchema, type ExecutionBoundary, type RunAttempt } from '../../src/core/schema.js';
import { executionBoundaryText, nativeExecutionObservations } from '../../src/core/execution-boundary.js';
import { selectedProcessEnvironment, hostShellOverrides } from '../../src/infrastructure/process/environment.js';
import { CodexProductRuntime } from '../../src/products/packs/codex/runtime.js';
import { CodexAppServerClient } from '../../src/products/packs/codex/runner.js';
import { ClaudeCodeProductRuntime } from '../../src/products/packs/claude-code/runtime.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { FAKE_APP_SERVER } from '../codex-pack-support.js';
import { workspaceTools } from '../../src/infrastructure/recovery-workspace-tools.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { projectTimelineEvent } from '../../src/tui/timeline.js';
import { codexExecutionObservation } from '../../src/products/packs/codex/protocol.js';

async function persistAndCheckRedaction(root: string, boundary: ExecutionBoundary, events: unknown[]): Promise<void> {
  const directory = join(root, 'experiment');
  const store = await ExperimentStore.open(directory, 'exp-1');
  await store.acquireWriter();
  try {
    const attempt: RunAttempt = { schemaVersion: 1, experimentId: 'exp-1', runId: 'run-1', caseId: 'case-1',
      candidate: { candidateId: 'candidate-1', productId: 'fake', requestedModel: 'fake' },
      policy: { maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 }, createdAt: new Date().toISOString() };
    const agent = { providerId: 'fake', requestedModel: 'fake', budget: { callTimeoutMs: 1000, maxStructuredRepairAttempts: 0 } };
    await store.commitAttempt(attempt);
    await store.commitManifest({ schemaVersion: 1, attempt, resolvedModel: { requested: 'fake', resolved: 'unknown' },
      runtime: { productId: 'fake', executable: process.execPath }, environment: { environmentId: 'environment-run-1', workspacePath: root, executionBoundary: boundary },
      controller: agent, comparison: agent, startedAt: attempt.createdAt });
    const manifestEvent = store.events('run-1').find(event => event.type === 'run.manifest_created')!;
    const projected = JSON.stringify(projectTimelineEvent(manifestEvent));
    assert.match(projected, /trusted-local-v1/);
    assert.match(projected, /Pack 声明/);
    assert.doesNotMatch(projected, /fake-native|fake-harness-secret|fake:proxy/);
    const artifact = await store.commitArtifact({ artifactId: 'trace.json', runId: 'run-1', kind: 'host_run_trace', bytes: Buffer.from(JSON.stringify(events)) });
    const persisted = (await Promise.all(['events.jsonl', 'runs/run-1/manifest.json', artifact.path].map(path => readFile(join(directory, path), 'utf8')))).join('\n');
    assert.doesNotMatch(persisted, /fake-native|fake-harness-secret|fake:proxy/);
  } finally { await store.close(); }
}

test('role selection deduplicates Windows keys, honors deletion, and rejects injection/Git overrides', () => {
  const source = { Path: 'first', PATH: 'last', ANTHROPIC_API_KEY: 'fake-native', OPENAI_API_KEY: 'fake-harness', NODE_OPTIONS: 'fake-loader', GH_TOKEN: 'fake-git', HTTPS_PROXY: 'https://fake:proxy@invalid' };
  const codex = selectedProcessEnvironment('codex', { pAtH: '', HTTPS_PROXY: undefined }, source);
  assert.deepEqual(codex, { PATH: '' });
  assert.equal(selectedProcessEnvironment('claude', {}, source).ANTHROPIC_API_KEY, 'fake-native');
  assert.equal(selectedProcessEnvironment('codex-service', {}, source).OPENAI_API_KEY, 'fake-harness');
  assert.deepEqual(selectedProcessEnvironment('host-shell', {}, source), { PATH: 'last' });
  for (const name of ['NODE_OPTIONS', 'GIT_CONFIG_GLOBAL', 'GH_TOKEN', 'BASH_ENV']) assert.throws(() => selectedProcessEnvironment('codex', { [name]: 'fake' }), /Unsupported/);
  assert.throws(() => selectedProcessEnvironment('codex', { INVALID: 'fake\0secret' }), error => String(error).includes('Invalid child environment') && !String(error).includes('secret'));
  assert.throws(() => hostShellOverrides({ ANTHROPIC_API_KEY: 'fake' }), /Unsupported Host/);
  assert.equal(hostShellOverrides({ reprise_source_mount: 'local' }).REPRISE_SOURCE_MOUNT, 'local');
  assert.match(executionBoundaryText(), /unknown/);
});

for (const product of ['codex', 'claude-code'] as const) test(`${product}: frozen plan drives an actual child, secrets stay out of records, temp is cleaned`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-boundary-中文 space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'observed.json');
  const script = join(root, 'fake runtime.mjs');
  const checks = `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  leaked: Boolean(process.env.REPRISE_FAKE_HARNESS_SECRET || process.env.OPENAI_API_KEY || process.env.GH_TOKEN || process.env.NODE_OPTIONS),
  native: process.env.ANTHROPIC_API_KEY === 'fake-native', proxy: process.env.HTTPS_PROXY === 'https://fake:proxy@invalid',
  temp: process.env.TEMP, git: process.env.GIT_NO_LAZY_FETCH,
}));
`;
  const claude = `
let buffer='';
process.stdin.on('data', chunk => {
buffer+=chunk;
for(let end=buffer.indexOf('\\n');end>=0;end=buffer.indexOf('\\n')) {
const message=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
if(message.type==='user') process.stdout.write(JSON.stringify({type:'user',isReplay:true,uuid:message.uuid})+'\\n');
if(message.type==='control_request') process.stdout.write(JSON.stringify({type:'control_response', request_id:message.request_id,response:{}})+'\\n');
}});
`;
  await writeFile(script, checks + (product === 'codex' ? FAKE_APP_SERVER : claude));
  const previous = process.env.REPRISE_FAKE_HARNESS_SECRET;
  const priorAuthentication = process.env.OPENAI_API_KEY;
  process.env.REPRISE_FAKE_HARNESS_SECRET = 'fake-harness-secret';
  process.env.OPENAI_API_KEY = 'fake-harness-secret';
  t.after(() => { if (previous === undefined) delete process.env.REPRISE_FAKE_HARNESS_SECRET; else process.env.REPRISE_FAKE_HARNESS_SECRET = previous; });
  t.after(() => { if (priorAuthentication === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorAuthentication; });
  const env = { HTTPS_PROXY: 'https://fake:proxy@invalid', ANTHROPIC_API_KEY: 'fake-native' };
  // Only Claude selects native key inheritance. Codex's explicit local overrides can select it, so omit it there.
  const options = { args: [script, 'completed'], env: product === 'codex' ? { HTTPS_PROXY: env.HTTPS_PROXY } : env };
  const runtime = product === 'codex' ? new CodexProductRuntime(options) : new ClaudeCodeProductRuntime(options);
  const resolved = { productId: product, executable: process.execPath, requestedModel: 'fake', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const launch = candidateLaunchFor(resolved, environment);
  const plan = await runtime.prepareExecution(resolved, environment, launch);
  assert.equal(Value.Check(ExecutionBoundarySchema, plan.record), true);
  assert.equal(Value.Check(ExecutionBoundarySchema, { ...plan.record, environment: { ...plan.record.environment, values: { key: 'fake-secret' } } }), false);
  assert.equal(plan.record.native.confirmation, 'unknown');
  assert.doesNotMatch(JSON.stringify(plan.record), /fake-native|fake-harness-secret|fake:proxy/);
  options.args[0] = 'must-not-be-used';
  env.HTTPS_PROXY = 'must-not-be-used';
  const events: unknown[] = [];
  const runner = await plan.createRunner({ append: async event => { events.push(event); } });
  t.after(() => runner.close());
  await runner.start({ id: 'message-1', text: 'fake' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'message-1' });
  const observed = JSON.parse(await readFile(marker, 'utf8')) as { leaked: boolean; native: boolean; proxy: boolean; temp: string; git: string };
  assert.equal(observed.leaked, false);
  assert.equal(observed.native, product === 'claude-code');
  assert.equal(observed.proxy, true);
  assert.equal(observed.git, '1');
  await access(observed.temp);
  await runner.stop('shutdown');
  await assert.rejects(access(observed.temp));
  assert.doesNotMatch(JSON.stringify(events), /fake-native|fake-harness-secret|fake:proxy/);
  assert.doesNotMatch(JSON.stringify(events), /runtime-native/);
  await persistAndCheckRedaction(root, plan.record, events);
  options.args[0] = script;
  const second = await runtime.prepareExecution(resolved, environment, launch);
  const secondRunner = await second.createRunner({ append: async () => {} });
  t.after(() => secondRunner.close());
  await secondRunner.start({ id: 'message-2', text: 'fake' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'message-2' });
  const secondObserved = JSON.parse(await readFile(marker, 'utf8')) as { temp: string };
  assert.notEqual(secondObserved.temp, observed.temp);
  await secondRunner.stop('shutdown');
  await assert.rejects(access(secondObserved.temp));
  await assert.rejects(runtime.prepareExecution(resolved, environment, { ...launch, executionRequirements: { filesystemIsolation: true } }), /cannot enforce/);
  await assert.rejects(runtime.prepareExecution(resolved, environment, { ...launch, executionRequirements: { disableExternalExtensions: true } }), /cannot enforce/);
  await assert.rejects(runtime.prepareExecution(resolved, environment, { ...launch, executionRequirements: { nativePermissionMode: 'impossible' } }), /conflicts/);
  const invalid = product === 'codex' ? new CodexProductRuntime({ args: ['fake\0secret'] }) : new ClaudeCodeProductRuntime({ args: ['fake\0secret'] });
  await assert.rejects(invalid.prepareExecution(resolved, environment, launch), error => String(error).includes('Invalid Runtime argv') && !String(error).includes('secret'));
});

test('Codex catalog/text client retains its native service authentication without Candidate inheritance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-service-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-service.mjs');
  const marker = join(root, 'observed.json');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({native:process.env.OPENAI_API_KEY==='fake-service-auth'}));\n${FAKE_APP_SERVER}`);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fake-service-auth';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const client = new CodexAppServerClient({ executable: process.execPath, cwd: root, args: [script, 'completed'] });
  t.after(() => client.close());
  await client.start();
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { native: true });
  await client.close();
});

test('actual Host shell excludes fake Harness credentials and rejects credential overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-host-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.REPRISE_FAKE_HARNESS_SECRET;
  const beforeLanguage = process.env.LANG;
  process.env.REPRISE_FAKE_HARNESS_SECRET = 'fake-harness';
  process.env.LANG = 'phase-a-frozen';
  t.after(() => { if (before === undefined) delete process.env.REPRISE_FAKE_HARNESS_SECRET; else process.env.REPRISE_FAKE_HARNESS_SECRET = before; });
  t.after(() => { if (beforeLanguage === undefined) delete process.env.LANG; else process.env.LANG = beforeLanguage; });
  const shell = workspaceTools(root, { allowShell: true }).find(tool => tool.name === 'shell_exec')!;
  process.env.LANG = 'must-not-be-used';
  const command = process.platform === 'win32'
    ? "if ($env:REPRISE_FAKE_HARNESS_SECRET) { throw 'leaked' }; if ($env:ANTHROPIC_API_KEY) { throw 'leaked' }; if ($env:LANG -ne 'phase-a-frozen') { throw 'not frozen' }; Write-Output 'clean'"
    : 'test -z "$REPRISE_FAKE_HARNESS_SECRET" && test -z "$ANTHROPIC_API_KEY" && test "$LANG" = "phase-a-frozen" && echo clean';
  const result = await shell.execute({ command }, new AbortController().signal);
  assert.match(result.content, /clean/);
  assert.throws(() => workspaceTools(root, { allowShell: true, shellEnv: { ANTHROPIC_API_KEY: 'fake' } }), /Unsupported Host/);
});

async function nativeFake(root: string, product: 'codex' | 'claude-code', policy: unknown = { type: 'readOnly', networkAccess: false }): Promise<string> {
  const script = join(root, 'native fake.mjs');
  const marker = join(root, 'native.json');
  await writeFile(script, `
import { writeFileSync } from 'node:fs';
const methods=[]; let buffer='';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
process.stdin.on('data', chunk=>{buffer+=chunk;for(let end=buffer.indexOf('\\n');end>=0;end=buffer.indexOf('\\n')) {
const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
methods.push(m.method??m.type);writeFileSync(${JSON.stringify(marker)}, JSON.stringify({methods,args:process.argv.slice(2)}));
if(m.method==='initialize')send({id:m.id,result:{}});
else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-1'},model:'fake',sandbox:${JSON.stringify(policy)}}});
else if(m.method==='turn/start')send({id:m.id,result:{turn:{id:'turn-1'}}});
else if(m.method==='turn/interrupt')send({id:m.id,result:{}});
else if(m.type==='user') {send({type:'user',isReplay:true,uuid:m.uuid});send({type:'system',subtype:'init',permissionMode:'default'});}
}});
`);
  const executable = join(root, `${product} fake.${process.platform === 'win32' ? 'cmd' : 'sh'}`);
  await writeFile(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
  return executable;
}

for (const product of ['codex', 'claude-code'] as const) test(`${product}: native conflict preserves configured arguments and stops subsequent input`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-native-中文 space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await nativeFake(root, product);
  const runtime = product === 'codex' ? new CodexProductRuntime({ sandbox: 'danger-full-access' }) : new ClaudeCodeProductRuntime();
  const resolved = { productId: product, executable, requestedModel: 'fake', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const plan = await runtime.prepareExecution(resolved, environment, candidateLaunchFor(resolved, environment));
  const events: { type: string; payload: unknown }[] = [];
  const runner = await plan.createRunner({ append: async event => { events.push(event); } });
  t.after(() => runner.close());
  const start = runner.start({ id: 'first', text: 'fake' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'first' });
  if (product === 'codex') {
    await assert.rejects(start, /conflicts/);
    await assert.rejects(runner.send({ id: 'second', text: 'fake' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'second' }), /conflicts/);
  }
  else {
    // Claude can acknowledge the initial message before init reports the conflict.
    await start.catch(error => assert.match(String(error), /conflicts/));
    await assert.rejects(runner.waitForTurn(), /conflicts/);
    await assert.rejects(runner.send({ id: 'second', text: 'fake' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'second' }), /stopped/);
  }
  assert.match(JSON.stringify(events), /runtime-native/);
  assert.match(JSON.stringify(events), /"matchesConfigured":false/);
  assert.equal(nativeExecutionObservations(events)[0]?.matchesConfigured, false);
  const observed = JSON.parse(await readFile(join(root, 'native.json'), 'utf8')) as { methods: string[]; args: string[] };
  assert.equal(observed.methods.includes('turn/start'), false);
  assert.equal(observed.methods.filter(method => method === 'user').length, product === 'claude-code' ? 1 : 0);
  if (product === 'claude-code') assert.equal(observed.args[observed.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(plan.record.native.confirmation, 'unknown');
  await runner.stop('shutdown');
});

const nativePolicyCases = [
  { configured: 'read-only', policy: { type: 'readOnly', networkAccess: false }, observed: 'read-only', matches: true },
  { configured: 'workspace-write', policy: { type: 'workspaceWrite', writableRoots: ['C:/example/extra'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false }, observed: 'workspace-write', matches: true },
  { configured: 'danger-full-access', policy: { type: 'dangerFullAccess' }, observed: 'danger-full-access', matches: true },
  { configured: 'read-only', policy: { type: 'dangerFullAccess' }, observed: 'danger-full-access', matches: false },
  { configured: 'read-only', policy: { type: 'externalSandbox', networkAccess: 'restricted' }, observed: 'external-sandbox', matches: false },
] as const;

for (const scenario of nativePolicyCases) test(`Codex native policy object: ${scenario.observed} against ${scenario.configured}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-native-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = await nativeFake(root, 'codex', scenario.policy);
  const runtime = new CodexProductRuntime({ sandbox: scenario.configured });
  const resolved = { productId: 'codex', executable, requestedModel: 'fake', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const events: { type: string; payload: unknown }[] = [];
  const runner = await runtime.createRunner(resolved, environment, { append: async event => { events.push(event); } }, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());
  const started = runner.start({ id: 'first', text: 'fake' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'first' });
  if (scenario.matches) assert.equal((await started).delivery, 'accepted');
  else await assert.rejects(started, /conflicts/);
  assert.deepEqual(nativeExecutionObservations(events), [{ source: 'runtime-native', permissionMode: scenario.observed, matchesConfigured: scenario.matches }]);
  const calls = JSON.parse(await readFile(join(root, 'native.json'), 'utf8')) as { methods: string[] };
  assert.equal(calls.methods.includes('turn/start'), scenario.matches);
  assert.doesNotMatch(JSON.stringify(events), /writableRoots|C:\/example\/extra/);
  await runner.stop('shutdown');
});

test('Codex malformed and future policy objects remain unconfirmed', () => {
  for (const policy of [{ type: 'readOnly' }, { type: 'readOnly', networkAccess: 'false' }, { type: 'workspaceWrite', writableRoots: [] }, { type: 'futurePolicy' }]) {
    assert.equal(codexExecutionObservation(policy, 'read-only'), undefined);
  }
  assert.equal(codexExecutionObservation('read-only', 'read-only')?.matchesConfigured, true);
});

test('new manifest field is optional for historical readers', () => {
  const environment = RunManifestSchema.properties.environment;
  assert.equal(Value.Check(environment, { environmentId: 'environment-old', workspacePath: 'old' }), true);
  assert.equal(Value.Check(environment, { environmentId: 'environment-old', workspacePath: 'old', executionBoundary: { mode: 'sandbox' } }), false);
});
