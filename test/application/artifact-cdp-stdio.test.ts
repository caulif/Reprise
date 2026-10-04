import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { drainBrowserStdio } from "../../src/infrastructure/artifact-cdp.js";

test("preview browser stdio drain resumes stdout and stderr without consuming them into logs", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.pause();
  stderr.pause();
  let stdoutResumes = 0;
  let stderrResumes = 0;
  const stdoutResume = stdout.resume.bind(stdout);
  const stderrResume = stderr.resume.bind(stderr);
  stdout.resume = function resumeStdout() {
    stdoutResumes += 1;
    return stdoutResume();
  };
  stderr.resume = function resumeStderr() {
    stderrResumes += 1;
    return stderrResume();
  };

  try {
    drainBrowserStdio({ stdout, stderr });
    assert.equal(stdoutResumes, 1);
    assert.equal(stderrResumes, 1);
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdout.readableFlowing, true);
    assert.equal(stderr.readableFlowing, true);
    const payload = Buffer.alloc(64 * 1024, 7);
    stdout.write(payload);
    stderr.write(payload);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdout.readableLength, 0);
    assert.equal(stderr.readableLength, 0);
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);
  } finally {
    stdout.destroy();
    stderr.destroy();
  }
});
