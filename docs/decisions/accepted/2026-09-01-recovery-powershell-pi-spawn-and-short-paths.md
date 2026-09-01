# 决策：Recovery PowerShell 对齐 Pi 启动语义并缩短隔离目录

状态：accepted

## 问题

Windows 上 Recovery `powershell` 必须在 Harness 自有 staging 里跑起来，才能产生 fingerprint 变更。Pi 用 PATH `where` 发现 `pwsh.exe`、argv `-Command`、UTF-8 输出编码和 spawn 前检查 cwd。Reprise 若把可执行文件写死在 Program Files、把每条命令都塞进 `Invoke-Expression`，或把 `recoveryId` 嵌进超长目录名，CreateProcess 会在可执行文件存在时仍报 `ENOENT`。完整 `process.env` 会把凭据带进 shell。

## 决定

- 发现顺序：覆盖路径 → `where pwsh.exe` → `%ProgramFiles%\PowerShell\7\pwsh.exe` → `where powershell.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。`where` 超时或非 0 继续绝对路径，不视为未安装。
- 参数固定为 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`。短于 CreateProcess cwd 上限时，UTF-8 `OutputEncoding` 前缀与用户命令作为 argv 最后一项；不设 `REPRISE_RECOVERY_COMMAND`。
- staging 仍超长时：在短目录 spawn，再 `Set-Location` + `Invoke-Expression`。文案区分可执行文件缺失、cwd 不存在、CreateProcess 拒 cwd。
- 子进程环境仍是白名单净化副本，不复制 `getShellEnv()`。
- 新实验目录：`rs/<recoveryId>`、`rt/<recoveryId>`、`rc/<recoveryId>/<8-hex>`。`recoveryId` 为无连字符 UUID；候选段名是 `sha256(candidateId)` 前 8 位。旧实验不迁移；进行中的恢复只活在进程内 Map。
- Windows 杀树使用 `%SystemRoot%\System32\taskkill.exe`。

## 备选方案

**灌入完整 `process.env` 以换 spawn 成功。** 把 API 密钥与用户凭据送进 Recovery 模型可见的 shell。

**把 Git Bash 设成 Recovery 默认壳。** 已验证平台是 Windows PowerShell；与八工具决策冲突。

**仅用 `\\?\` 长路径前缀当 spawn cwd。** Node 部分 fs API 可用，CreateProcess `lpCurrentDirectory` 仍受 MAX_PATH 限制。

**只缩短 id、不改目录段名。** `recovery-staging` / `recovery-candidates` 仍占路径预算；与嵌 caseId 的 id 叠加后仍易超限。

**预防性把 Pi 的 `waitForChildProcess` idle-grace 整段搬进 `process-runner`。** 未见 Recovery powershell 退出后挂死或丢尾的证据。

## 影响

[Environment §7.1](../../architecture/environment.md#71-内部工作空间与实际边界) 的目录名与 shell 启动语义。[Windows shell 与点路径](./2026-08-31-recovery-windows-shell-and-dot-paths.md) 不再描述可执行文件发现与 argv。

## 验证

`test/recovery-tools.test.ts`：PATH 上的 pwsh 进入 spawn command；短 cwd 的 argv 含 Bypass、UTF-8 前缀、用户命令且无 `REPRISE_RECOVERY_COMMAND`；缺失 staging 报 cwd 不存在；超长 cwd 走 IEX 且 `Remove-Item` 仍改文件。`test/environment.test.ts`：`recoveryId` 为 32 位 hex，根路径为 `rs` / `rt` / `rc`。`test/process-runner.test.ts`：`windowsTaskkillExecutable` 指向 System32。反向：短 cwd 再塞 IEX、发现只认 Program Files、或 `beginRecovery` 再拼 `recovery-${caseId}`，测试红。
