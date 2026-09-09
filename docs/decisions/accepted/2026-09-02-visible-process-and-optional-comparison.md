# 决策：内部 Agent 可见短句、运行分屏与显式对照

状态：accepted

## 问题

Host 只把最后一条 assistant JSON 当完成合同，中间可见短句不进事件。TUI 只能画工具名。Comparison 在候选 `finished` 后自动开跑，无头路径会悄悄计费。

## 决定

- Pi 循环在 `message_end` 把非信封、非 thinking 的 assistant 纯文本写成 `agent.assistant_visible`。空则不发。Host 不编造旁白。
- 三个内部 Agent 的 prompt 允许工具批次之间 1–3 句过程说明；该次 invocation 的最后一条仍只是 JSON 信封。
- Recovery 单列：短句为脊，调查折叠；阶段条跟人话；等待文案是「仍在恢复」。
- 候选运行左右分屏：左 Controller（历史回合与多余思考默认折叠），右栏是 Pack 译出的产品可见会话。用户句（含 `send` 回显）走 Input 紫声部。两栏独立滚动。
- Comparison 默认不跑。TUI 在候选结束后询问；Enter 才对照，`s` 跳过且第一版不在同一 Experiment 补跑。CLI 必须显式 `--compare`。

## 备选方案

**继续只画工具名。** 操作者看不到调查意图。

**Host 另调模型写旁白。** 伪造过程，且与事件日志复原冲突。

**候选结束后自动对照。** 无头脚本和「只想看候选」的路径都会产生对照费用。

## 影响

[TUI §3.2](../../product/tui.md#32-每次比较)、[TUI §4.1](../../product/tui.md#41-主活动时间线)。[架构总览](../../architecture/overview.md) 的 Comparison 启动时机。实现：`src/infrastructure/agent/model-caller.ts`、`src/application/experiment-report.ts`、`src/tui/pages/run.ts`。

## 验证

`test/narrative-canvas.test.ts` 与 `test/codex-experiment.test.ts`：有说明则出现该句；无说明不编造；右栏用户句为 Input 紫；右栏无 Controller 工具名；不传 `compare` 则无 `comparison.started`。反向：自动对照、Controller 工具进右栏、或右栏用户句走产品青色则红。
