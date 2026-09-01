# 对照 Pi 的 Recovery `powershell` 修改规划

状态：已落地  
范围：把 Recovery 的 Windows shell 启动对齐 [earendil-works/pi](https://github.com/earendil-works/pi) `main` 上已经验证过的部分；缩短 Harness 自造的超长 staging cwd，使 CreateProcess 能把工作目录设到隔离工作区。不改候选 Runtime、不灌完整 `process.env`、不把 Git Bash 设成 Recovery 默认壳。  
依据：[Environment §7.1](../architecture/environment.md#71-内部工作空间与实际边界)、[八工具](../decisions/accepted/2026-08-31-recovery-pi-aligned-tools.md)、[Windows shell 与点路径](../decisions/accepted/2026-08-31-recovery-windows-shell-and-dot-paths.md)、[凭据](../product/overview.md#13-凭据)、Pi `packages/coding-agent` 的 `src/utils/shell.ts`、`src/core/tools/powershell.ts`、`src/core/tools/bash.ts`、`src/utils/child-process.ts`、`docs/windows.md`。本机旧克隆 `C:\杂\pi` 没有 `powershell.ts`，对照以 GitHub `main` 为准。

A–F 与 MAX_PATH 变通已经让「找不到 pwsh」和「`.` 路径」可诊断；真实走查仍出现可执行文件存在、但 `spawn({ cwd: staging })` 报 `ENOENT`。那是 Windows `CreateProcess` 工作目录上限，不是 Pi 日常项目 cwd 的场景。Pi 没有为 260+ 字符的 Harness 路径写变通；它解决的是 **可执行文件发现、参数、编码、cwd 存在性、Windows 子进程收尾**。本规划把能抄的抄过来，把 Reprise 独有的超长 `recovery-candidates` 路径缩短，使 Pi 那套「cwd 就是工作区」成立。

## 1. 要变成真的事

同一次真实 Codex 恢复再走到确认页时：

1. **`powershell` 的启动语义与 Pi 的 PowerShell 工具一致。** `pwsh.exe` 优先、否则 `powershell.exe`；参数含 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`；命令作为 argv 传入（cwd 短于 MAX_PATH 时）；失败时 cwd 不存在与可执行文件不存在分开说。
2. **隔离工作区路径短到 CreateProcess 能把它设成 cwd。** 模型在 staging 根执行 `Remove-Item` 等，不必依赖「短目录 spawn + `Set-Location`」才能改 fingerprint。长路径变通只作兜底。
3. **输出按 UTF-8 读。** 中文会话的 PowerShell 输出不再依赖系统 ANSI 代码页。
4. **环境与出根约束不变。** 仍是白名单净化环境；`ls`/`pathIn` 仍拒绝 `..`、盘符、反斜杠。

Done means：`npm run check`；shell 改动带反向用例（`where` 找不到 pwsh 时失败可诊断；cwd 不存在与 MAX_PATH 文案分开；短 cwd 走 argv `-Command` 而不是 `Invoke-Expression`）；触及 on-disk 路径布局则写/改 `docs/decisions/` 并同步 Environment §7.1；不启动真实候选 Runtime。

## 2. 非目标

- 把 Recovery 默认壳改成 Git Bash，或按 Pi `defaultTools` 同时暴露 `bash` 与 `powershell`。
- 复制 `getShellEnv()`：展开全部 `process.env` 再插 PATH。凭据与全局配置不得进 shell。
- 允许工作区工具接受绝对路径或 `..`（Pi 的 `ls` 用 `resolveToCwd(path || ".", cwd)`，那是通用 coding agent，不是隔离恢复）。
- 引入 `cross-spawn` 只为抄依赖。Recovery spawn 的是 `.exe`，不是 `.cmd` shim。
- 为绿灯放宽 fingerprint 空变更。
- 把本机 `C:\杂\pi` 当作实现依赖；代码只读本仓库。

## 3. Pi `main` 里已经成立的事实

对照来源是 GitHub `main`（2026-09-01 读取），不是本机 `C:\杂\pi`。旧克隆的 `ToolName` 仍是 `read|bash|edit|write|grep|find|ls`，没有独立 PowerShell 工具。

### 3.1 可执行文件：PATH 上的 `where`，不是写死 Program Files

[`getPowerShellConfig()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/shell.ts) 仅在 `win32` 可用：`findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe")`。Windows 上 `findExecutableOnPath` 跑 `where`，取第一行且 `existsSync`。找不到则明确报「Install PowerShell or add powershell.exe/pwsh.exe to PATH」。

[`docs/windows.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md) 写明：可选 `powershell` 工具优先 `pwsh.exe`，否则 Windows PowerShell；启动参数 `-NoProfile -NonInteractive -ExecutionPolicy Bypass`。用户可用 `defaultTools` 关掉 `bash`、只留 `powershell`。`!` / `!!` 编辑器命令仍走 Bash，与 Recovery 无关。

已知失败模式（[issue 8582](https://github.com/earendil-works/pi/issues/8582)）：SEA/`pi.exe` 下 `where` 的 5s `spawnSync` 超时会把发现打成空，从而落到 5.1。Reprise 不是 SEA 打包，但发现逻辑不要只依赖一次短超时的 `where`；绝对路径探测与 `where` 应互补。

### 3.2 命令怎么进进程

[`powershell.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/powershell.ts) 是薄封装：`createLocalShellOperations("PowerShell", getPowerShellConfig)`，每条命令前加

`try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}`

再交给 bash 共用的 `createLocalShellOperations`。

[`bash.ts` `createLocalShellOperations`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)：

- 先 `fsAccess(cwd)`；不存在则 `Working directory does not exist: … Cannot execute PowerShell commands.`
- `spawn(shell, [...args, command], { cwd, env, windowsHide: true, stdio: stdin ignore, detached: false on win32 })`
- PowerShell 的 `args` 是 `POWERSHELL_ARGS`：`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`，**命令是 argv 最后一项**，不是 `Invoke-Expression $env:…`
- 环境默认 `getShellEnv()` = `{ ...process.env }` 并把 Pi bin 插 PATH。这一条 **不抄**。
- 用 `waitForChildProcess`：Windows 上子进程 `exit` 后若有分离后代占着管道，不立即 `destroy` stdout，避免截断或挂死（pi#5303）。

[`child-process.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/utils/child-process.ts) 另有 Windows `cross-spawn` 封装；当前 `bash.ts` 的 `createLocalShellOperations` 仍直接 `import { spawn } from "child_process"`。Recovery 不必为对齐而加依赖。

杀树：Pi 的 `killProcessTree` 在 Windows 上 spawn **`%SystemRoot%\System32\taskkill.exe`**，不依赖 PATH 上的 `taskkill`。

### 3.3 Pi 没有解决的：Harness 超长 cwd

Pi 的 cwd 是用户打开的项目目录。`spawn({ cwd })` 直接用该路径。仓库里没有 MAX_PATH / `Set-Location` / 短临时目录变通。

Reprise 的失败是 **Host 把 staging 放在 `dataDir\…\recovery-candidates\recovery-case-…-uuid` 下**，路径可以超过 Windows `CreateProcess` 的 `lpCurrentDirectory`（约 260）。Node `fs.mkdir` 仍能建目录，于是「目录存在 + pwsh 存在 + spawn ENOENT」。这不是 Pi 的产品场景；对齐 Pi 的正确方式是 **让 cwd 重新变成普通项目长度**，而不是假设 upstream 已有同样的补丁。

### 3.4 `ls` / 点路径

Pi：`path || "."` 再 `resolveToCwd`，`.` 就是 cwd，绝对路径合法。  
Reprise：`.` 已规范为 staging 根；绝对路径与 `..` 必须继续拒绝。此项 **已对齐「当前目录」语义，不要再抄 Pi 的绝对路径。**

## 4. 当前实现与差距

权威代码：[`recovery-workspace-tools.ts`](../../src/infrastructure/recovery-workspace-tools.ts) 的 `runShell` / `resolveWindowsPowershell`，[`process-runner.ts`](../../src/infrastructure/process-runner.ts)。

| 点 | Pi `main` | Reprise 当前 |
|---|---|---|
| 发现 pwsh | `where` PATH，再 powershell.exe | 写死 `C:\Program Files\PowerShell\7\pwsh.exe`，否则 System32 5.1 |
| argv | Bypass + `-Command` + 用户命令 | `-Command` + 固定 `Set-Location; Invoke-Expression $env:…`，无 Bypass |
| UTF-8 | 每条命令前设 `OutputEncoding` | 无 |
| cwd | 项目路径，spawn 前 `fsAccess` | staging；`length >= 248` 时 cwd=`os.tmpdir()` |
| env | 完整 `process.env` | `sanitizedEnvironment` + 两条 REPRISE_* |
| 杀树 | System32 `taskkill.exe` | PATH 上的 `taskkill` |
| 收尾 | `waitForChildProcess` 宽限管道 | `close` 即结算 |

短 cwd 时仍走 `Invoke-Expression`：多一层解析，且把整段命令塞进环境变量。Pi 用 argv 把命令交给 `-Command`，避免 IEX。长路径兜底可以保留 IEX，但不应是短路径的主路径。

## 5. 怎么改

同一次变更写决策（发现顺序、argv vs IEX 分界、路径缩短是否改 on-disk 布局）。Environment §7.1 只写结果约束，不写走查过程。

### A — 发现与 argv 对齐 Pi（已落地）

1. **解析顺序（失败才往下）：** 测试/配置覆盖 → `where pwsh.exe` 第一存在路径 → 已知安装位置（`ProgramFiles\PowerShell\7\pwsh.exe`）→ `where powershell.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。`where` 超时或非 0 不当成「本机没装」，继续绝对路径。反向：覆盖指向不存在文件 → `ENOENT` 且文案含未找到；存在 pwsh 但不在 Program Files 时仍能选中 PATH 条目。
2. **短 cwd（staging 长度低于 CreateProcess 上限）：** `args = POWERSHELL_ARGS + UTF8 前缀与用户命令`（一条 `-Command` 字符串，与 Pi 相同：前缀换行再命令）。**不要**设 `REPRISE_RECOVERY_COMMAND` / IEX。
3. **仍超长时的兜底：** 保持短目录 spawn + `Set-Location -LiteralPath` + IEX；文案继续区分「可执行文件不存在」与「CreateProcess 拒 cwd」。反向：强制超长 staging 时 `Remove-Item` 仍改 fingerprint。
4. **spawn 前 `access` staging。** 目录真不存在时不要报 MAX_PATH 或未找到 PowerShell。
5. **`-ExecutionPolicy Bypass`。** 5.1 默认 Restricted 时，仅 `-Command` 也可能被策略挡住；与 Pi 一致。

不引入 `shell: true`。不把 `process.env` 整表拷进子进程。

### B — 缩短 staging 路径（已落地）

选定：`recoveryId` 为无连字符 UUID；目录 `rs` / `rt` / `rc`。放弃单独 `\\?\` spawn cwd、以及只缩短 id 却保留 `recovery-staging` 长段名。超长路径兜底仍由 A.3 覆盖。

### C — 进程边界小对齐（已落地）

1. `terminateChild` 使用 `System32\taskkill.exe`（已落地）。
2. `waitForChildProcess` idle-grace：**不落地**（未见 powershell 退出后挂死或丢尾）。

### D — 文档与来源（已落地）

- 新决策 [对齐 Pi 的启动语义](../decisions/accepted/2026-09-01-recovery-powershell-pi-spawn-and-short-paths.md)；[Windows shell 与点路径](../decisions/accepted/2026-08-31-recovery-windows-shell-and-dot-paths.md) 把启动语义指过去。Environment §7.1 已同步。
- 本机 `C:\杂\pi` 是否 pull `main` 不阻塞本仓库。

## 6. 验收

- `npm run check`：已通过（2026-09-01）。
- `test/recovery-tools.test.ts`：PATH/覆盖发现；cwd 缺失；短 cwd 不写 `REPRISE_RECOVERY_COMMAND`；超长 cwd 仍能变异 staging；UTF-8 前缀出现在实际 `-Command` 文本（可用假 spawn 断言 argv）。
- 同一真实会话再走确认页：不在本规划代码范围内（不启动真实候选 Runtime）。

## Rollback

还原 `recovery-workspace-tools.ts` / `process-runner.ts` 与路径布局相关文件；若缩短了目录名，旧实验仍走原路径读取。验证：`npm run check`。
