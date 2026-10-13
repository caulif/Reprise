import { spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

type IdentityBackend = {
  capture(pid: number): string | undefined;
  terminate(pid: number, creationIdentity: string): boolean;
};
const identities = new WeakMap<ChildProcess, string>();
const systemRoot = () => process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
function powershell(script: string) {
  return spawnSync(join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
}
const native: IdentityBackend = {
  capture(pid) {
    const result = powershell(`$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $handle=$p.Handle; $p.StartTime.ToUniversalTime().Ticks } catch { exit 1 }`);
    const ticks = result.stdout?.trim();
    return result.status === 0 && ticks && /^\d+$/.test(ticks) ? ticks : undefined;
  },
  terminate(pid, ticks) {
    if (!/^\d+$/.test(ticks)) return false;
    // Keep the verified process handle open through taskkill. Windows retains the process object/ID
    // while that handle is open, so root exit between validation and taskkill cannot redirect to a reused PID.
    const script = `$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $handle=$p.Handle; if ($p.StartTime.ToUniversalTime().Ticks -ne [long]'${ticks}') { exit 2 }; & '${join(systemRoot(), 'System32', 'taskkill.exe').replaceAll("'", "''")}' /F /T /PID ${pid} | Out-Null; $code=$LASTEXITCODE; $p.Dispose(); exit $code } catch { exit 1 }`;
    return powershell(script).status === 0;
  },
};

/** Call synchronously immediately after a real spawn, while Node still owns its original process handle. */
export function captureWindowsProcessIdentity(child: ChildProcess, backend: IdentityBackend = native): void {
  if (child.pid === undefined) return;
  const identity = backend.capture(child.pid);
  if (identity) identities.set(child, identity);
}

export function terminateVerifiedWindowsTree(child: ChildProcess, backend: IdentityBackend = native): boolean {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
  const identity = identities.get(child);
  if (identity && backend.terminate(child.pid, identity)) return true;
  // child.kill addresses Node's retained process handle, never an arbitrary PID. Tree termination
  // remains unconfirmed when identity acquisition/verification fails; callers must retain that uncertainty.
  try { child.kill(); } catch { /* The original handle can already be closed; no PID fallback is allowed. */ }
  return false;
}
