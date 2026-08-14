import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLAUDE_REQUIRED_ARGS } from '../src/products/claude-code/runtime-port.js';

const exe = process.env.REPRISE_CLAUDE_EXECUTABLE ?? join(homedir(), '.local', 'bin', 'claude.exe');
const cwd = await mkdtemp(join(tmpdir(), 'reprise-claude-diag-'));
const child = spawn(exe, [...CLAUDE_REQUIRED_ARGS], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: process.env,
});
const frames: unknown[] = [];
const stderrChunks: string[] = [];
child.stdin.on('error', () => undefined);
child.stdout.on('data', (chunk: Buffer | string) => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const wrapper = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
        ? parsed.response as Record<string, unknown>
        : undefined;
      const inner = wrapper?.response && typeof wrapper.response === 'object' && !Array.isArray(wrapper.response)
        ? wrapper.response as Record<string, unknown>
        : undefined;
      const payload = inner ?? wrapper;
      frames.push({
        type: parsed.type,
        wrapperSubtype: wrapper?.subtype ?? null,
        keys: Object.keys(parsed),
        wrapperKeys: wrapper ? Object.keys(wrapper) : [],
        innerKeys: inner ? Object.keys(inner) : [],
        request_id: parsed.request_id ?? wrapper?.request_id ?? null,
        modelCount: Array.isArray(payload?.models) ? payload.models.length : Array.isArray(payload?.data) ? payload.data.length : 0,
        hasAccount: Boolean(payload && 'account' in payload),
      });
    } catch {
      frames.push({ raw: line.slice(0, 80) });
    }
  }
});
child.stderr.on('data', (chunk: Buffer | string) => { stderrChunks.push(String(chunk)); });
const requestId = randomUUID();
child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`);
await new Promise((resolve) => { setTimeout(resolve, 20_000); });
const exitCode = child.exitCode;
try { child.stdin.end(); } catch { /* already closed */ }
if (process.platform === 'win32' && child.pid) {
  await new Promise<void>((resolve) => {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).once('close', () => resolve());
  });
} else {
  child.kill();
}
const stderr = stderrChunks.join('')
  .replace(/https?:\/\/[^\s]+/gi, '[endpoint]')
  .replace(/(?:sk-|Bearer\s+)\S+/gi, '[secret]')
  .slice(0, 800);
console.log(JSON.stringify({ exitCode, frameCount: frames.length, frames: frames.slice(0, 12), stderr }, null, 2));
await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
