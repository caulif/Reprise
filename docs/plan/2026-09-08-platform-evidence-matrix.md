# 三平台 TUI 与 Runtime 证据矩阵

未关闭原因：真终端交互与 Runtime smoke 缺少完整证据，Controller 真实模型 lane 仍有失败，生产 provider 模型输入对拍未完成。新 N6 Recovery+Controller 复刻另见 [N6 开放验收](./2026-09-16-share-card-and-n6-replay.md)。

本文是人工验收清单。支持声明只覆盖有证据的组合；未测项标为 unverified，不能写成已支持。真实 Runtime 与付费模型只能显式 opt-in。以下历史记录不是本批重跑证据。

入口：[TUI 真终端探针](../../package.json) `probe:tui-terminal`、[Codex smoke](../codex-smoke-gate.md)、[Controller 能力 lane](../architecture/controller.md)。本机报告放在不受控目录，不提交密钥或模型原文。

## 矩阵

| 平台 | 终端 / shell | 项 | 状态 | 证据 |
|---|---|---|---|---|
| Windows 11 | Windows Terminal + PowerShell | TUI 启动、中文画面 | verified（部分） | [WT 历史观察](#wt-历史观察)：1.24.11911.0 启停与中文画面，不涵盖键盘交互 |
| Windows 11 | Windows Terminal | 键盘导航、IME 组字 | unverified | 须真人键盘；合成 Unicode 不得冒充 IME |
| Windows 11 | Windows Terminal | 滚轮输入 | verified（部分） | [WT 历史观察](#wt-历史观察)：前台 OS SendInput 进入 ConPTY，不证明完整视口行为 |
| Windows 11 | Windows Terminal | 拖选复制 | unverified | 原始鼠标事件不证明选区或剪贴板内容 |
| Windows 11 | PowerShell | Ctrl+C、异常退出恢复 | verified（自动化） | CLI timeout/SIGINT 与 TUI close 测试 |
| Windows 11 | 本机 | 候选 Runtime 启停/取消/非零退出 | unverified | 须授权 smoke；默认检查不跑 |
| macOS | Terminal.app + Bash | 同一 TUI 矩阵 | unverified | 本轮未测 |
| macOS | Terminal.app + Bash | Runtime smoke | unverified | 本轮未测 |
| Linux | 选定终端 + Bash | 同一 TUI 矩阵 | unverified | 本轮未测 |
| Linux | 选定终端 + Bash | Runtime smoke | unverified | 本轮未测 |

CI `windows-latest` / `macos-latest` / `ubuntu-latest` 只证明离线模拟（shell、路径、进程），不顶替本表真终端行。

## WT 历史观察

2026-09-08，Windows Terminal 1.24.11911.0：`TERM=xterm-256color`、`WT_SESSION` 存在、stdout 为 TTY；启动预览含 Reprise 与入口命令。`rows=30`，中文画面含「导入历史」「中文路径测试」，`closed=true`；能力探测报告 hyperlinks，`fileLink` 发出 OSC 8，关闭鼠标报告时发出对应序列。这只证明启动、渲染与协议输出，不证明真人键盘导航、链接打开或异常退出恢复。

同版本人工窗口最大化等待 40s：`viewportMouse=76`、`rawStdin=76`、`viewportWheel=0`、`imeLike=0`。聚焦前台 WT 后 OS `SendInput` 滚轮/拖选：`viewportWheel=2`、`viewportMouse=185`、`imeLike=0`。证据止于鼠标与滚轮进入 ConPTY；没有选区、剪贴板内容或真人 IME 证据，不能据此关闭拖选复制或键盘导航。

Cursor 保持前台时合成注入未进入该 ConPTY（`rawStdin=0`）；`hostWheelOk=true` 也不能替代 stdin 收到事件。合成 Unicode 不算 IME 组字。macOS/Linux 真终端无历史记录。

## Controller 与 provider 开放证据

2026-09-08 MiniMax-M3 能力 lane 历史摘要（不是本批重跑，也不是当前生产工具面的完整验收）：

- 首轮无 briefing/工具：五族代表均未匹配预期；`01-complete` failed，`02-missing-artifact` 与 `09-conflict` send 但 intent 不符，`11-no-progress` 与 `05-user-decision` 应 done 却 send。
- v2 使用生产同构 INDEX 与 workspace 工具的记录：五族均 failed，`invalid_output` / `protocol`。
- v3 夹具仅保留 ls/read/grep/find：仅 `01-complete` 匹配 done（1/5）；`02-missing-artifact` send/intent 不符；`11-no-progress`、`05-user-decision` 为 `invalid_output` / `protocol`（schema 根联合校验失败）；`09-conflict` 为 `agent_failure`。

Controller lane 仍未关闭；只读夹具的一次合法 done 不证明全部能力，合成 briefing 与脚本合同 lane 也不替代真人历史。后续授权验收须记录模型、工具面、预期与实际结果以及剩余失败，不提交密钥或模型原文。

生产 provider 输入对拍仍 open：缺少 `REPRISE_AGENT_CONTEXT_PROBE=1` 下真实 `streamFn` 输入与事件日志重建输入的一致性证据；离线模型输入重建测试不能替代这项验证。

## Windows 后续 opt-in 命令

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
