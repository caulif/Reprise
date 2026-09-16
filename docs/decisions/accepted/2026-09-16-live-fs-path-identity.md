# 决策：活路径比较分辨 8.3 短名与长路径

状态：accepted
日期：2026-09-16

## 问题

GitHub Windows runner 上 `os.tmpdir()` / `mkdtemp` 常给出 `C:\Users\RUNNER~1\...`，PowerShell 与 `git rev-parse --show-toplevel` 给出 `C:\Users\runneradmin\...`。`sameFsPath` 只做记录路径的斜杠与大小写归一，把同一目录判成不同路径。Recovery 因此把未出生的 Git 仓当成非仓库，也不挂 `artifact:historical-commit`。TUI 帧基线里的 `C:\user\...` 与 CI 生成的 `RUNNER~1` 只差路径拼写和列宽。

`git cat-file -e HASH^{commit}` 与 `rev-parse HASH^{commit}` / `HASH^` 在部分 Windows Git 包装下会丢掉 `^`。shell_exec 只在 Windows 把非零退出当结果返回，POSIX 直接抛错，覆盖率 lane 无法观察 `exitCode`。`runProcess`、CandidateRun cleanup、control 客户端超时与 `AbortSignal.timeout()` 的 `unref()` 后，事件循环可在超时触发前结束。macOS 上 `/var` 与 `/private/var` 是同一目录的两种拼写，catalog id map 与 `process.cwd()` 字面比较会失败。

## 决定

活文件系统比较用 `realpath`（`sameLiveFsPath`）。记录路径仍用 `sameFsPath`，8.3 与长名字符串不相等。Git toplevel 与 historical commit 探测走活路径；commit 存在性用 `git cat-file -t`，父提交用 `HASH~1`，避免 `^`。Git 探测带 `GIT_OPTIONAL_LOCKS=0`。Source fingerprint 忽略 `.git/`，避免 Host 自己的 `git status` 触发 source tripwire。Codex catalog 的路径键同样 `realpath`。TUI 帧比对先把 Users/temp 前缀（含 8.3）收成 `C:\user\...`，再去掉行末 `│` 前的多余空白。`shell_exec` 在所有宿主返回非零退出码。进程超时定时器保持引用，直到该次 `runProcess` / cleanup / headless `--timeout-ms` / control 客户端等待结束。

## 备选方案

**测试里同时接受 RUNNER~1 与 runneradmin。** 生产代码仍会把合法仓库判成非仓库。

**CI 把 TEMP 设成短固定盘符。** 不覆盖用户机器上的 8.3，且 audit 仍可能漂移。

**保留 `^{commit}` 并强制 `git.exe`。** PATH 上的 `git.cmd` 仍可能吃掉 `^`。

## 影响

- Recovery Git 探测把 8.3 与长路径视为同一工作树。
- Codex catalog 与 `runProcess` cwd 比较把 `/var` 与 `/private/var` 视为同一文件。
- 帧基线不必为每个 runner 用户名重录；真正的布局回归仍会使内容行失败。
- POSIX 上 Agent 能看到 shell 退出码，与 Windows 一致。

## 验证

- `sameFsPath('C:\\Users\\RUNNER~1\\a', 'C:\\Users\\runneradmin\\a')` 为 false；符号链接上 `sameLiveFsPath` 为 true。
- `canonicalizeAuditFrame` 让 `RUNNER~1` 与 `C:\user` 的 temp 行在比对时相等；内容不同的帧仍被拒绝。
- CandidateRun `hangStop` + `cleanupTimeoutMs` 能在超时后结束，不再留下 pending Promise。
- `catalogPathKey` 对符号链接与目标给出同一键；headless `--timeout-ms` 源码不含 `AbortSignal.timeout`。
- pre-task / contamination 源码不含 `^{commit}` 或 `HASH^`。
- `git status` 刷新 index 后 source fingerprint digest 不变（忽略 `.git/`）。
