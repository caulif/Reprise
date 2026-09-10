import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { RUNTIME_PROCESS_CLOSE_TIMEOUT_MS, RUNTIME_PROCESS_STOP_GRACE_MS, settlesWithin } from './spawn.js';

async function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    await new Promise<void>((resolveWait) => spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).once('close', () => resolveWait()));
    return;
  }
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* child is not a process-group leader */
    }
  }
  child.kill('SIGKILL');
}

/** After stdin shutdown, wait the grace window, then SIGKILL, then fail if the process is still alive. */
export async function forceCloseRuntimeProcess(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
  fail: () => Error,
): Promise<void> {
  if (await settlesWithin(closed, RUNTIME_PROCESS_STOP_GRACE_MS)) return;
  await forceKill(child);
  if (await settlesWithin(closed, RUNTIME_PROCESS_CLOSE_TIMEOUT_MS)) return;
  throw fail();
}
