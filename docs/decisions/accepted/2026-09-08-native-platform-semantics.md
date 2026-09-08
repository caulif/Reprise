# 决策：原生平台语义

状态：accepted

目标批次见 [M6.1](../../plan/reprise-refactoring-execution.md#m61-明确原生平台语义)。

## 问题

宿主默认 shell 跟随 `SHELL`，macOS 落到 zsh。`runProcess` 仍接受 Node `shell`。POSIX 取消只 `child.kill()`。WSL 可把 Windows 路径当本机可执行文件。CandidateRun 在 `stop` 永不返回时无法把 cleanup 记为非成功。

## 决定

- Windows 默认 `powershell.exe`（System32）；macOS 与 Linux 默认 `/bin/bash`。不读取 `SHELL`。缺 bash 或 PowerShell 以 ENOENT 失败，不回退到用户 shell。
- 进程一律 `file + args[]` 且 `shell: false`。`.cmd` 仍走 ComSpec verbatim，不为此打开 Node shell。POSIX 需要杀进程树时 `detached` 并对 `-pid` 发 SIGKILL。
- WSL（`linux` 且存在 `WSL_DISTRO_NAME` 或 `WSL_INTEROP`）只接受发行版路径；拒绝盘符路径与 `/mnt/<盘符>/`。发现可执行文件跳过非本机候选。
- CandidateRun 等待 Runtime `stop` 的上限为 `cleanupTimeoutMs`（默认 10s）。超时写入 `runtime.stop_failed`（`reason: cleanup_timeout`），`cleanup.status` 为 `unknown`，`remainingResourceIds` 含 `runtime`。随后仍尝试释放环境，但不得记 `complete`。

## 备选方案

**继承 `SHELL`。** 同一命令在 zsh/fish/bash 下语义不同，跨 CI 宿主无法复现。

**Node `shell: true`。** 空格、中文与 quoting 随 ComSpec / `/bin/sh` 变化。

**超时仍标 `complete`。** 用户看到资源已清，实际 Runtime 可能仍在跑。

## 影响

[跨平台 Host ADR](./2026-09-05-cross-platform-host-and-agent-tools.md) 的默认 shell 与本文一致。真实三操作系统终端与 IME 仍属后续 M6 批次。本机 Windows 用 `shellInvocation(..., 'darwin'|'linux')` 作为 POSIX argv 模拟证据。

## 验证

`test/platform.test.ts`：darwin/linux 在 `SHELL=/bin/fish` 下仍是 bash。`test/paths.test.ts` 与 `test/process-discovery.test.ts`：WSL 拒绝 Windows 可执行路径。`test/process-runner.test.ts`：`shell: false`、空格 cwd、ENOENT、符号链接、killTree 取消。`test/candidate-run.test.ts`：挂起的 `stop` 得到 `unknown` 而非 `complete`。反向：`defaultShell` 在 darwin 上返回 fish、或 WSL 接受 `/mnt/c/...`、或超时 cleanup 为 `complete` 则红。
