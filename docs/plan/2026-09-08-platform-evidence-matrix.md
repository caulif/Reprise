# 三平台 TUI 与 Runtime 证据矩阵

本文是人工验收清单。支持声明只覆盖有证据的组合；未测项标为 unverified，不能写成已支持。真实 Runtime 与付费模型只能显式 opt-in。

入口：[TUI 真终端探针](../../package.json) `probe:tui-terminal`、[Codex smoke](../codex-smoke-gate.md)、[Controller 能力 lane](../architecture/controller.md)。本机报告放在不受控目录，不提交密钥或模型原文。

## 矩阵

| 平台 | 终端 / shell | 项 | 状态 | 证据 |
|---|---|---|---|---|
| Windows 11 | Windows Terminal + PowerShell | TUI 启动、中文画面、键盘导航 | verified（部分） | MASTER：WT 1.24 帧与人工窗口 |
| Windows 11 | Windows Terminal | IME 组字 | unverified | 合成 Unicode 不得冒充；须真人键盘 |
| Windows 11 | Windows Terminal | 滚轮、拖选复制 | verified（部分） | MASTER：OS SendInput 进入 ConPTY；Cursor 合成不计入 |
| Windows 11 | PowerShell | Ctrl+C、异常退出恢复 | verified（自动化） | CLI timeout/SIGINT 与 TUI close 测试 |
| Windows 11 | 本机 | 候选 Runtime 启停/取消/非零退出 | unverified | 须授权 smoke；默认检查不跑 |
| macOS | Terminal.app + Bash | 同一 TUI 矩阵 | unverified | 本轮未测 |
| macOS | Terminal.app + Bash | Runtime smoke | unverified | 本轮未测 |
| Linux | 选定终端 + Bash | 同一 TUI 矩阵 | unverified | 本轮未测 |
| Linux | 选定终端 + Bash | Runtime smoke | unverified | 本轮未测 |

CI `windows-latest` / `macos-latest` / `ubuntu-latest` 只证明离线模拟（shell、路径、进程），不顶替本表真终端行。

## Windows 本轮可重复命令

```powershell
npm run check
npm run probe:tui-terminal -- C:\absolute\tui-probe.json
```

`REPRISE_REAL_TERMINAL=1` 且 stdout 为 TTY 时探针才运行。IME 仍须操作者在聚焦的 Windows Terminal 里组字。

Runtime 与付费 lane：

```powershell
$env:REPRISE_RUN_CODEX_SMOKE = '1'
# 按 smoke 闸门提供绝对 data-dir 与授权后再执行
$env:REPRISE_REAL_MODEL = '1'
npm run evaluate:controller -- C:\absolute\data-dir C:\absolute\controller-eval.json
$env:REPRISE_AGENT_CONTEXT_PROBE = '1'
node dist/scripts/agent-context-probe.js
```

## macOS / Linux（操作者后续自测）

在对应系统安装同一版本 Reprise 后，记录终端版本、`TERM`、是否 TTY，并逐项填写：中文输入、IME 组字、滚轮、拖选复制、缩放、键盘导航、Ctrl+C、异常退出、历史重开。未填行保持 unverified。
