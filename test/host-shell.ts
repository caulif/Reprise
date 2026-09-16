/** Host-selected shell_exec syntax. Windows uses PowerShell; POSIX uses bash. */
export function hostShellDelete(path: string): string {
  return process.platform === "win32"
    ? `Remove-Item -LiteralPath ${path}`
    : `rm -f -- ${path}`;
}

export function hostShellPwd(): string {
  return process.platform === "win32" ? "(Get-Location).Path" : "pwd";
}

export function hostShellSleep(seconds: number): string {
  return process.platform === "win32"
    ? `Start-Sleep -Seconds ${seconds}`
    : `sleep ${seconds}`;
}

export function hostShellReadFile(path: string): string {
  if (process.platform === "win32") {
    return `Get-Content -LiteralPath '${path.replaceAll("'", "''")}'`;
  }
  return `cat -- ${JSON.stringify(path)}`;
}

export function hostShellWriteFile(path: string, value: string): string {
  if (process.platform === "win32") {
    return `Set-Content -LiteralPath '${path.replaceAll("'", "''")}' -Value '${value.replaceAll("'", "''")}'`;
  }
  return `printf '%s\\n' ${JSON.stringify(value)} > ${JSON.stringify(path)}`;
}

export function hostShellMissingExecutable(): string {
  return process.platform === "win32"
    ? "& 'C:\\reprise-missing-shell-exec.exe'"
    : "command -v reprise-missing-shell-exec >/dev/null";
}

export function hostShellPipeAlpha(outFile: string): string {
  if (process.platform === "win32") {
    return `Write-Output alpha | findstr.exe alpha | Set-Content -LiteralPath ${outFile}`;
  }
  return `printf '%s\\n' alpha | grep alpha > ${JSON.stringify(outFile)}`;
}

export function hostNodeCommand(script: string): string {
  if (process.platform === "win32") {
    return `& '${process.execPath.replaceAll("'", "''")}' -e ${JSON.stringify(script)}`;
  }
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}
