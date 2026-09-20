# 决策：Comparison Prompt 禁止直接浏览器 shell

状态：accepted

延伸[自主 Prompt 闭环](./2026-09-19-comparison-autonomous-prompt-loop.md)与[受控产物渲染与报告预览](./2026-09-19-controlled-artifact-render.md)：补强可执行 System Prompt 对截图路径的纪律；不替代 Comparison 工具装配层对 `shell_exec` 的硬拒绝（handoff D）。

## 问题

模型在 `render_artifact` / `preview_report` 不可用或失败时，会经 `shell_exec` 直接跑 Chrome/Edge `--version`、`--dump-dom` 或打开用户 profile。Windows 上普通 `msedge.exe` 可能挂入既有 GUI 会话且不退出，导致 Comparison 长期卡住。仅靠 Prompt 不能挡住绕过，但缺少明确规则时模型会默认走探测路径。

## 决定

- System Prompt 写明：需要截图或查看页面时，只使用 `render_artifact` / `preview_report`。
- 禁止执行 Chrome、Edge、Firefox 二进制；禁止 `--version`、`--dump-dom`；禁止直接打开用户浏览器 profile。
- 渲染工具失败时记录 limitation，继续文本证据分析；不得反复尝试等价的浏览器 shell 命令。
- Prompt 仅为第二道防线。权威拒绝仍在 Comparison 专用 shell 包装（工具装配边界）；本决定不在通用 Recovery/Controller shell 规则中加入产品判断。

## 备选方案

**只改 Host shell 拒绝、不改 Prompt。** 硬边界必要，但模型仍会先发起注定失败的浏览器探测，浪费预算并污染审计。拒绝。

**从 Comparison 移除 `shell_exec`。** 文本静态检查与受控脚本仍需要 shell；一刀切过宽。拒绝。

## 影响

- 可执行文本：[`comparison-agent.ts`](../../../src/agents/comparison-agent.ts) 的 `COMPARISON_SYSTEM_PROMPT`。
- 快照：`test/snapshots/comparison-system-prompt.txt`。
- 事实层：[证据与 Comparison](../../architecture/evidence-and-comparison.md)。

## 验证

- `test/application/comparison-report.test.ts`：Prompt 含 only-through render/preview、禁止 Chrome/Edge/Firefox 与 `--version`/`--dump-dom`、失败后记录 limitation 且不得 browser shell 重试。
- `test/core/snapshots.test.ts`：`comparison-system-prompt` 快照与源码一致。
- 反向：删掉上述禁令后上述测试必须失败。
- `npm run check` 必须通过。
