import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockSourceWrites, type SourceWriteLockHost } from "../../src/environment/source-write-lock.js";
import type { ProcessResult } from "../../src/infrastructure/process-runner.js";

function ok(): ProcessResult {
  return { stdout: "", stderr: "", exitCode: 0, outputTruncated: false };
}

function fail(): ProcessResult {
  return { stdout: "", stderr: "denied", exitCode: 1, outputTruncated: false };
}

function recordingHost(script: ProcessResult[]): { host: SourceWriteLockHost; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    host: {
      platform: "win32",
      homedir: tmpdir(),
      systemRoot: "C:\\Windows",
      runProcess: async (input) => {
        calls.push([...input.args]);
        return script[calls.length - 1] ?? ok();
      },
    },
  };
}

test("source write lock is a no-op off Windows", async () => {
  const { host, calls } = recordingHost([]);
  const lock = await lockSourceWrites("C:\\source", join(tmpdir(), "unused-lock-state"), {
    ...host,
    platform: "linux",
  });
  await lock.release();
  assert.deepEqual(calls, []);
});

test("source write lock saves ACLs, denies Everyone write, and restores on release", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reprise-acl-mock-"));
  const { host, calls } = recordingHost([ok(), ok(), ok()]);
  const lock = await lockSourceWrites("C:\\users\\src", stateDir, host);
  await lock.release();
  await lock.release();
  assert.equal(calls[0]?.includes("/save"), true);
  assert.equal(calls[1]?.some((arg) => arg.includes("/deny") || arg.includes("WD,AD")), true);
  assert.equal(calls[1]?.some((arg) => arg.includes("WEA,WA,DC")), false);
  assert.equal(calls[2]?.includes("/restore"), true);
  assert.equal(calls.length, 3);
  await rm(stateDir, { recursive: true, force: true });
});

test("source write lock restores when deny fails", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reprise-acl-deny-fail-"));
  const { host, calls } = recordingHost([ok(), fail(), ok()]);
  await assert.rejects(lockSourceWrites("C:\\users\\src", stateDir, host), /write deny ACL/);
  assert.equal(calls[2]?.includes("/restore"), true);
  await rm(stateDir, { recursive: true, force: true });
});

test("source write lock fails closed when ACL backup cannot be saved", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reprise-acl-save-fail-"));
  const { host } = recordingHost([fail()]);
  await assert.rejects(lockSourceWrites("C:\\users\\src", stateDir, host), /save source ACLs/);
  await rm(stateDir, { recursive: true, force: true });
});

test("source write lock removes the deny ACE when restore fails", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "reprise-acl-restore-fail-"));
  const { host, calls } = recordingHost([ok(), ok(), fail(), ok()]);
  const lock = await lockSourceWrites("C:\\users\\src", stateDir, host);
  await lock.release();
  assert.equal(calls[2]?.includes("/restore"), true);
  assert.equal(calls[3]?.includes("/remove:d"), true);
  await rm(stateDir, { recursive: true, force: true });
});

test("source write lock denies mutation until release", async (t) => {
  if (process.platform !== "win32") {
    t.skip("live NTFS ACL requires Windows");
    return;
  }
  const source = await mkdtemp(join(tmpdir(), "reprise-acl-source-"));
  const stateDir = await mkdtemp(join(tmpdir(), "reprise-acl-state-"));
  const target = join(source, "keep.txt");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(target, "original\n");
  const lock = await lockSourceWrites(source, stateDir);
  t.after(async () => {
    await lock.release();
    await rm(source, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });
  await assert.rejects(writeFile(target, "mutated\n"));
  await assert.rejects(writeFile(join(source, "nested", "new.txt"), "x\n"));
  assert.equal(await readFile(target, "utf8"), "original\n");
  await lock.release();
  await writeFile(target, "after-release\n");
  assert.equal(await readFile(target, "utf8"), "after-release\n");
});
