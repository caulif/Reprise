import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile, cp, utimes, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RecoveryAgentPort } from "../../src/agents/recovery-agent.js";
import { recoverExperiment } from "../../src/application/recovery/recover.js";
import {
  evaluateRecoveryPreTaskConditions,
  freezeRecoveryGitEvidence,
} from "../../src/environment/recovery-pre-task.js";
import type { TaskCase } from "../../src/core/schema.js";
import { RecoveryFrozenGitSchema } from "../../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { hostShellDelete } from "../host-shell.js";
import { isRecord } from "../../src/core/json.js";
import { now, VerifiedRuntime, input } from "../codex-experiment-support.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}

async function commitTree(root: string, message: string, body: string): Promise<string> {
  await writeFile(join(root, "README.md"), body);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

function taskCase(overrides: Partial<TaskCase> & { historicalEvents?: TaskCase["historicalEvents"]; taskContext?: TaskCase["taskContext"] }): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "pre-task-case",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message", role: "user", text: "task" },
    transcript: [{ id: "message", role: "user", text: "task" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: now, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
    ...overrides,
  };
}

test("ready is refused when HEAD already equals the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-head-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  const taskCommit = await commitTree(root, "task", "done\n");
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase({
    historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
  }));
  assert.equal(check.readyAllowed, false);
  assert.equal(check.head, taskCommit);
  assert.equal(check.taskCommit, taskCommit);
  assert.equal(check.preTaskCommit, preTask);
  assert.match(check.reasons.join(" "), /historical task commit/);
});

test("ready is allowed when HEAD is the parent of the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-parent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  const taskCommit = await commitTree(root, "task", "done\n");
  await git(root, ["checkout", "--force", preTask]);
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase({
    historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
    taskContext: { historicalCommit: preTask },
  }));
  assert.equal(check.readyAllowed, true);
  assert.equal(check.head, preTask);
});

test("post-task dirty files block ready except required dependency trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-dirty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  await writeFile(join(root, "notes.md"), "later notes\n");
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const dirty = await evaluateRecoveryPreTaskConditions(root, taskCase({
    taskContext: { historicalCommit: preTask },
    historicalEvents: [{ timestamp: "2020-01-01T00:00:00.000Z" }],
  }));
  assert.equal(dirty.readyAllowed, false);
  assert.ok(dirty.dirtyPaths.includes("notes.md"));
  assert.equal(dirty.dirtyPaths.some((path) => path.startsWith("node_modules/")), false);
  await rm(join(root, "notes.md"));
  const clean = await evaluateRecoveryPreTaskConditions(root, taskCase({
    taskContext: { historicalCommit: preTask },
    historicalEvents: [{ timestamp: "2020-01-01T00:00:00.000Z" }],
  }));
  assert.equal(clean.readyAllowed, true);
});

test("Recovery does not accept ready when staging HEAD is the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-recover-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await git(source, ["init"]);
  await commitTree(source, "before", "start\n");
  const taskCommit = await commitTree(source, "task", "done\n");
  const base = input(root, new VerifiedRuntime());
  const feedback: string[] = [];
  const recovery: RecoveryAgentPort = {
    recover: async context => {
      if (context.mechanicalFeedback) feedback.push(context.mechanicalFeedback.facts);
      return {
        status: "completed",
        sessionId: "recovery-pre-task",
        value: {
          status: "ready",
          summary: "The work copy is ready for the original task.",
          reportPath: "recovery.md",
          unresolved: [],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-pre-task-head",
    runId: "recovery-pre-task-head-run",
    sourceRoot: source,
    taskCase: {
      ...base.taskCase,
      historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
    },
    recovery,
    maxModelAttempts: 1,
    now,
  });
  assert.equal(attempt.acceptedAutomatically, undefined);
  assert.equal(typeof attempt.accept, "undefined");
  assert.notEqual(attempt.baseline.recovery?.status, "ready");
  assert.equal(attempt.baseline.recovery?.failureStage, "provider_validation_failed");
  assert.match(feedback.join("\n"), /historical task commit/);
});

test("pre-task git probes do not pass caret peel to git.cmd", async () => {
  const source = await readFile(join(process.cwd(), "src/environment/recovery-pre-task.ts"), "utf8");
  assert.doesNotMatch(source, /\^\{commit\}/);
  assert.doesNotMatch(source, /taskCommit\}\^/);
  assert.match(source, /cat-file", "-t"/);
  assert.match(source, /~1/);
});

test('backdated Chinese and spaced paths and renames remain post-task dirt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-pre-task-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--template=']); await commitTree(root, 'before', 'start\n');
  await rename(join(root, 'README.md'), join(root, '原始 输入.md'));
  await git(root, ['add', '-A']);
  await writeFile(join(root, '回填 时间.txt'), 'answer');
  await utimes(join(root, '回填 时间.txt'), new Date('2000-01-01'), new Date('2000-01-01'));
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase({}));
  assert.equal(check.readyAllowed, false);
  assert.ok(check.dirtyPaths.includes('原始 输入.md'));
  assert.ok(check.dirtyPaths.includes('回填 时间.txt'));
});

test('frozen source evidence rejects deleting task objects or inventing a clean unrelated commit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-pre-task-freeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), work = join(root, 'work'); await mkdir(source);
  await git(source, ['init', '--template=']);
  const before = await commitTree(source, 'before', 'start\n'), answer = await commitTree(source, 'answer', 'done\n');
  const task = taskCase({ historicalEvents: [{ type: 'turn_context', commit: before }, { type: 'session_meta', commit: before }, { text: '[main ' + answer.slice(0, 7) + '] answer' }] });
  const frozen = await freezeRecoveryGitEvidence(source, task, 'a'.repeat(64));
  assert.equal(frozen.state, 'git');
  assert.deepEqual(frozen.taskCommits, [answer]);
  await cp(source, work, { recursive: true });
  await rm(join(work, '.git'), { recursive: true }); await git(work, ['init', '--template=']);
  await commitTree(work, 'invented', 'start\n');
  const check = await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen);
  assert.equal(check.readyAllowed, false);
  assert.match(check.reasons.join(' '), /absent from the protected source/);
});

test('corrupt Git probe errors do not become a ready non-Git scene', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-pre-task-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--template=']); await commitTree(root, 'before', 'start\n');
  await writeFile(join(root, '.git', 'config'), '[invalid config');
  await assert.rejects(evaluateRecoveryPreTaskConditions(root, taskCase({})), /Process boundary failed/);
});

test('unborn Git is frozen distinctly and only unchanged retained input bytes pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-unborn-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), work = join(root, 'work');
  await mkdir(source);
  await git(source, ['init', '--template=']);
  await writeFile(join(source, 'input.txt'), 'original input');
  const frozen = await freezeRecoveryGitEvidence(source, taskCase({}), 'a'.repeat(64));
  assert.equal(frozen.schemaVersion, 2);
  assert.equal(frozen.state, 'unborn');
  assert.equal((await freezeRecoveryGitEvidence(source, taskCase({ historicalEvents: [{ text: '[main 1234567] completed task' }] }), 'digest')).state, 'unavailable');
  assert.equal((await freezeRecoveryGitEvidence(source, taskCase({ taskContext: { historicalCommit: 'a'.repeat(40) } }), 'digest')).state, 'unavailable');
  assert.equal(Value.Check(RecoveryFrozenGitSchema, frozen), true);
  assert.equal(Value.Check(RecoveryFrozenGitSchema, { ...frozen, schemaVersion: 1 }), false);
  assert.equal(Value.Check(RecoveryFrozenGitSchema, { ...frozen, schemaVersion: 1, state: 'unavailable' }), true);
  await cp(source, work, { recursive: true });
  assert.equal((await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen)).readyAllowed, true);
  assert.equal((await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, { ...frozen, schemaVersion: 1, state: 'unavailable' })).readyAllowed, false);
  await writeFile(join(work, 'input.txt'), 'changed input');
  const modified = await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen);
  assert.equal(modified.readyAllowed, false);
  assert.deepEqual(modified.dirtyPaths, ['input.txt']);
  await writeFile(join(work, 'input.txt'), 'original input');
  await writeFile(join(work, 'answer.txt'), 'invented');
  assert.equal((await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen)).readyAllowed, false);
  await rm(join(work, '.git'), { recursive: true });
  await assert.rejects(evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen));
  await git(work, ['init', '--template=']);
  await commitTree(work, 'invented', 'answer');
  assert.equal((await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen)).readyAllowed, false);
});

test('orphan branches, lost HEAD refs and corrupt repositories never become unborn evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-unborn-negative-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '--template=']);
  await commitTree(root, 'before', 'start');
  const branch = (await git(root, ['symbolic-ref', 'HEAD'])).trim();
  await git(root, ['checkout', '--detach']);
  assert.equal((await freezeRecoveryGitEvidence(root, taskCase({}), 'digest')).state, 'git');
  await git(root, ['checkout', branch.slice('refs/heads/'.length)]);
  await git(root, ['checkout', '--orphan', 'empty']);
  assert.equal((await freezeRecoveryGitEvidence(root, taskCase({}), 'digest')).state, 'unavailable');
  await git(root, ['update-ref', '-d', branch]);
  await git(root, ['reflog', 'expire', '--expire=now', '--all']);
  assert.equal((await freezeRecoveryGitEvidence(root, taskCase({}), 'digest')).state, 'unavailable');
  await writeFile(join(root, '.git', 'config'), '[invalid config');
  const frozen = await freezeRecoveryGitEvidence(root, taskCase({}), 'digest');
  assert.equal(frozen.state, 'unavailable');
  assert.equal((await evaluateRecoveryPreTaskConditions(root, taskCase({}), undefined, root, frozen)).readyAllowed, false);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(freezeRecoveryGitEvidence(root, taskCase({}), 'digest', abort.signal));
});

test('Recovery accepts an Agent-restored unborn workspace without inventing history and preserves blocked decisions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-unborn-recover-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await git(base.sourceRoot, ['init', '--template=']);
  await writeFile(join(base.sourceRoot, 'input.txt'), 'original input');
  await writeFile(join(base.sourceRoot, 'answer.txt'), 'later answer');
  for (const status of ['ready', 'blocked'] as const) {
    let calls = 0;
    const recovery: RecoveryAgentPort = {
      recover: async (_context, tools, _audit, signal) => {
        calls++;
        const shell = tools.find(tool => tool.name === 'exec_command');
        assert.ok(shell);
        const abort = signal ?? new AbortController().signal;
        const owner = { sessionId: 'unborn-recovery', invocationId: `${status}-${calls}` };
        let result = await shell.execute({ cmd: hostShellDelete('answer.txt') }, abort, owner);
        while (isRecord(result.details) && (result.details.state === 'running' || result.details.state === 'flushing')) {
          const poll = tools.find(tool => tool.name === 'write_stdin');
          assert.ok(poll);
          result = await poll.execute({ session_id: result.details.session_id }, abort, owner);
        }
        assert.equal(isRecord(result.details) ? result.details.exitCode : undefined, 0);
        await shell.lifecycle?.finishInvocation(owner);
        return { status: 'completed', sessionId: 'unborn-recovery', value: {
          status, summary: status === 'ready' ? 'Original inputs retained; later answer removed.' : 'The retained input boundary needs clarification.',
          unresolved: status === 'ready' ? ['No historical commit exists.'] : ['Retained materials may postdate the task.'],
        } };
      },
    };
    const attempt = await recoverExperiment({ dataDir: base.dataDir, caseId: base.caseId,
      experimentId: `unborn-${status}`, runId: `unborn-${status}-run`, sourceRoot: base.sourceRoot,
      taskCase: base.taskCase, recovery, now });
    assert.equal(calls, 1);
    if (status === 'ready') {
      assert.equal(attempt.acceptedAutomatically, true);
      assert.ok(attempt.baseline.root);
      assert.equal(await readFile(join(attempt.baseline.root, 'input.txt'), 'utf8'), 'original input');
      await assert.rejects(readFile(join(attempt.baseline.root, 'answer.txt')), { code: 'ENOENT' });
      await assert.rejects(git(attempt.baseline.root, ['rev-parse', '--verify', 'HEAD']));
      assert.equal(attempt.providerPreview?.changedPaths.includes('answer.txt'), true);
    } else {
      assert.equal(attempt.acceptedAutomatically, undefined);
      assert.equal(typeof attempt.accept, 'undefined');
    }
    assert.equal(await readFile(join(base.sourceRoot, 'answer.txt'), 'utf8'), 'later answer');
  }
});

test('a locally present historical tip without refs is frozen and accepted through Git finalize', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-historical-tip-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(root, 'source'); await mkdir(source);
  await git(source, ['init', '--template=']);
  const baseCommit = await commitTree(source, 'base', 'base\n');
  const tip = await commitTree(source, 'historical tip', 'historical input\n');
  await git(source, ['reset', '--hard', baseCommit]);
  await git(source, ['reflog', 'expire', '--expire=now', '--all']);
  await git(source, ['update-ref', 'refs/remotes/origin/main', baseCommit]);
  await git(source, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  // Self-recovery may also contain an ignored, nested experiment repository.
  await mkdir(join(source, '.git', 'info'), { recursive: true });
  await writeFile(join(source, '.git', 'info', 'exclude'), '.reprise/\n');
  const nested = join(source, '.reprise', 'experiments', 'nested'); await mkdir(nested, { recursive: true });
  await git(nested, ['init', '--template=']); await commitTree(nested, 'nested', 'nested\n');
  const base = input(root, new VerifiedRuntime());
  const frozen = await freezeRecoveryGitEvidence(source, base.taskCase, 'a'.repeat(64));
  assert.ok(frozen.commits[tip]);
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const begin = provider.beginRecovery.bind(provider);
  let workRoot = '';
  t.mock.method(provider, 'beginRecovery', async (...args: Parameters<typeof begin>) => {
    const staging = await begin(...args); workRoot = staging.root; return staging;
  });
  const recovery: RecoveryAgentPort = { recover: async () => {
    await git(workRoot, ['checkout', '--force', '--detach', tip]);
    return { status: 'completed', sessionId: 'historical-tip', value: { status: 'ready', summary: 'Historical input restored.', reportPath: 'recovery.md', unresolved: [] } };
  } };
  const attempt = await recoverExperiment({ dataDir: base.dataDir, caseId: base.caseId, experimentId: 'historical-tip', runId: 'historical-tip-run', environmentProvider: provider, sourceRoot: source, taskCase: base.taskCase, recovery, now });
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.recovery?.status, 'ready');
  const events = await readFile(join(attempt.experimentRoot, 'events.jsonl'), 'utf8');
  assert.match(events, /recovery.history_sealed/);
  assert.match(events, /recovery.lifecycle_completed/);
});

test('rebase conflict inputs survive the ready gate and sealing, while unrelated dirt still blocks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-rebase-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), work = join(root, 'work'); await mkdir(source);
  await git(source, ['init', '--template=']);
  const base = await commitTree(source, 'base', 'base\n');
  await git(source, ['checkout', '-b', 'topic']);
  await writeFile(join(source, 'staged.txt'), 'required staged input\n');
  await commitTree(source, 'topic change', 'topic\n');
  await git(source, ['checkout', '--detach', base]);
  const onto = await commitTree(source, 'onto', 'onto\n');
  await git(source, ['checkout', 'topic']);
  const task = taskCase({ initialInput: { id: 'message', role: 'user', text: 'Resolve the git rebase conflicts and continue.' } });
  const frozen = await freezeRecoveryGitEvidence(source, task, 'a'.repeat(64));
  await cp(source, work, { recursive: true });
  await assert.rejects(git(work, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'rebase', onto]));
  assert.equal((await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen)).readyAllowed, true);
  assert.equal((await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen)).readyAllowed, false);
  await writeFile(join(work, 'unrelated.txt'), 'post-task answer');
  assert.equal((await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen)).readyAllowed, false);
  await rm(join(work, 'unrelated.txt'));
  const refs = await git(work, ['show-ref']);
  assert.equal(await sealRecoveryGitHistory(work, onto), false);
  assert.equal(await git(work, ['show-ref']), refs);
  await writeFile(join(work, 'README.md'), 'resolved\n'); await git(work, ['add', 'README.md']);
  await git(work, ['-c', 'core.editor=true', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'rebase', '--continue']);
  assert.equal(await readFile(join(work, 'staged.txt'), 'utf8'), 'required staged input\n');
});


test("freeze streams commit objects and accepts plural rebase conflicts wording", async () => {
  const source = await readFile(join(process.cwd(), "src/environment/recovery-pre-task.ts"), "utf8");
  assert.match(source, /conflicts\?\\b\|冲突/);
  assert.match(source, /listCommitObjectsMissingFromMap/);
  assert.match(source, /createInterface/);
  assert.doesNotMatch(source, /git\(root, \["cat-file", "--batch-all-objects"/);
});

test("freeze keeps unreachable tips even when the object store has many non-commit objects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-many-blobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--template="]);
  const base = await commitTree(root, "base", "base\n");
  const tip = await commitTree(root, "historical tip", "historical\n");
  await git(root, ["reset", "--hard", base]);
  await git(root, ["reflog", "expire", "--expire=now", "--all"]);
  const blobDir = join(root, ".blob-factory");
  await mkdir(blobDir, { recursive: true });
  for (let i = 0; i < 250; i++) {
    const file = join(blobDir, `blob-${i}.bin`);
    await writeFile(file, `blob-payload-${i}\n`);
    await git(root, ["hash-object", "-w", file]);
  }
  await rm(blobDir, { recursive: true, force: true });
  const frozen = await freezeRecoveryGitEvidence(root, taskCase({}), "a".repeat(64));
  assert.equal(frozen.state, "git");
  assert.ok(frozen.commits[tip]);
  assert.ok(frozen.commits[base]);
});


test("rename onto an allowed rebase path still blocks the unrelated source path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-rebase-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), work = join(root, "work"); await mkdir(source);
  await git(source, ["init", "--template="]);
  const base = await commitTree(source, "base", "base\n");
  await writeFile(join(source, "unrelated.txt"), "keep me\n");
  await git(source, ["add", "unrelated.txt"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "unrelated"]);
  await git(source, ["checkout", "-b", "topic"]);
  await writeFile(join(source, "staged.txt"), "required staged input\n");
  await commitTree(source, "topic change", "topic\n");
  await git(source, ["checkout", "--detach", base]);
  const onto = await commitTree(source, "onto", "onto\n");
  await git(source, ["checkout", "topic"]);
  const task = taskCase({ initialInput: { id: "message", role: "user", text: "Resolve the git rebase conflicts and continue." } });
  const frozen = await freezeRecoveryGitEvidence(source, task, "a".repeat(64));
  await cp(source, work, { recursive: true });
  await assert.rejects(git(work, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "rebase", onto]));
  // Rename an unrelated tracked file onto the allowed rebase input path.
  await rm(join(work, "staged.txt"), { force: true });
  await git(work, ["mv", "-f", "unrelated.txt", "staged.txt"]);
  const check = await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen);
  assert.equal(check.readyAllowed, false);
  assert.ok(check.dirtyPaths.includes("unrelated.txt"));
});


test("identical preserved source renames stay ready while new renames still block", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preserved-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), work = join(root, "work"); await mkdir(source);
  await git(source, ["init", "--template="]);
  await commitTree(source, "before", "start\n");
  await writeFile(join(source, "old.txt"), "rename me\n");
  await git(source, ["add", "old.txt"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "add old"]);
  await git(source, ["mv", "old.txt", "new.txt"]);
  const frozen = await freezeRecoveryGitEvidence(source, taskCase({}), "a".repeat(64));
  await cp(source, work, { recursive: true });
  const preserved = await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen);
  assert.equal(preserved.readyAllowed, true);
  assert.equal(preserved.dirtyPaths.includes("old.txt"), false);
  await writeFile(join(work, "extra.txt"), "extra\n");
  await git(work, ["add", "extra.txt"]);
  await git(work, ["mv", "extra.txt", "hijacked.txt"]);
  const blocked = await evaluateRecoveryPreTaskConditions(work, taskCase({}), undefined, source, frozen);
  assert.equal(blocked.readyAllowed, false);
});


test("upstream rename maps rebase conflict path into retained inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-rebase-rename-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), work = join(root, "work"); await mkdir(source);
  await git(source, ["init", "--template="]);
  const shared = "line1\nline2\nline3\nline4\nline5\n";
  await writeFile(join(source, "old.txt"), shared);
  await writeFile(join(source, "README.md"), "readme base\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "base"]);
  const base = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["checkout", "-b", "topic"]);
  await writeFile(join(source, "old.txt"), shared + "topic\n");
  await git(source, ["add", "old.txt"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "topic"]);
  await git(source, ["checkout", "--detach", base]);
  await git(source, ["mv", "old.txt", "new.txt"]);
  await writeFile(join(source, "new.txt"), shared + "onto\n");
  await writeFile(join(source, "README.md"), "readme onto\n");
  await git(source, ["add", "-A"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "onto rename"]);
  const onto = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["checkout", "topic"]);
  const task = taskCase({ initialInput: { id: "message", role: "user", text: "Resolve the git rebase conflicts and continue." } });
  const frozen = await freezeRecoveryGitEvidence(source, task, "a".repeat(64));
  await cp(source, work, { recursive: true });
  await assert.rejects(git(work, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "rebase", onto]));
  assert.match(await git(work, ["status", "--porcelain=v1"]), /UU new\.txt/);
  const check = await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen);
  assert.equal(check.readyAllowed, true, check.reasons.join("; "));
  assert.equal(check.dirtyPaths.includes("new.txt"), false);
});

test("forged unmerged stages on unrelated paths do not inherit rebase retention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-rebase-forged-unmerged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), work = join(root, "work"); await mkdir(source);
  await git(source, ["init", "--template="]);
  const shared = "line1\nline2\nline3\nline4\nline5\n";
  await writeFile(join(source, "old.txt"), shared);
  await writeFile(join(source, "unrelated.txt"), "keep\n");
  await git(source, ["add", "."]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "base"]);
  const base = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["checkout", "-b", "topic"]);
  await writeFile(join(source, "old.txt"), shared + "topic\n");
  await git(source, ["add", "old.txt"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "topic"]);
  await git(source, ["checkout", "--detach", base]);
  await git(source, ["mv", "old.txt", "new.txt"]);
  await writeFile(join(source, "new.txt"), shared + "onto\n");
  await git(source, ["add", "-A"]);
  await git(source, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "onto rename"]);
  const onto = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["checkout", "topic"]);
  const task = taskCase({ initialInput: { id: "message", role: "user", text: "Resolve the git rebase conflicts and continue." } });
  const frozen = await freezeRecoveryGitEvidence(source, task, "a".repeat(64));
  await cp(source, work, { recursive: true });
  await assert.rejects(git(work, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "rebase", onto]));
  await writeFile(join(work, "unrelated.txt"), "forged answer\n");
  const blob = (await git(work, ["hash-object", "-w", join(work, "unrelated.txt")])).trim();
  const info = [
    `100644 ${blob} 1\tunrelated.txt`,
    `100644 ${blob} 2\tunrelated.txt`,
    `100644 ${blob} 3\tunrelated.txt`,
  ].join("\n") + "\n";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["update-index", "--index-info"], { cwd: work, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `update-index exited ${code}`)));
    child.stdin?.end(info);
  });
  const check = await evaluateRecoveryPreTaskConditions(work, task, undefined, source, frozen);
  assert.equal(check.readyAllowed, false);
  assert.ok(check.dirtyPaths.includes("unrelated.txt"));
});
