# 决策：Controller 协作协议与评估分层

状态：accepted

目标批次见 [M3.2](../../plan/archive/reprise-refactoring-execution.md#m32-验证协作语义和投递边界)。

## 问题

脚本化测试容易把“历史句全部发出”或固定自然语言当成完成证据。若不区分历史用户要求、历史 agent 发现和当前候选事实，Controller 会把原助手结论当成用户先验。投递若先于决策落盘，或未知/取消后重发，会破坏可追溯投递。把合同 lane 分数说成与原用户语义等价会掩盖真实局限。

## 决定

- briefing INDEX 与 system prompt 标明三类事实；历史用户句不是发送队列；完成条件是该用户会否停止，而不是句是否发完。
- Host 先写入 `controller.decision`，再按唯一 `clientMessageId` 投递。`unknown` 与取消不重发。不同 `runId` 不共享 Controller Session。
- `controller.requested` 快照记录 `promptDigest`。用量以 Invocation `modelRequests` 和压缩 `tokensBefore` 为准。
- 合同 lane 覆盖五类判断样例，只验证协议与分类边界。真实模型语义评估经 `npm run evaluate:controller` 写出调用方指定路径，不进入 `npm run check`，不与合同 lane 合成总分。
- 非法或未观察的 `evidenceRefs` 不得静默过滤；路径不是 artifact id。合法观察引用须出现在模型可见工具返回正文。无后续历史用户句不构成验收证明。

## 备选方案

**用脚本分数宣称协作习惯已验证。** 无法区分协议回归与真人语义，故不采用。

**静默丢弃畸形 evidenceRefs 后宣布成功。** 证据链断裂且模型看不到真实引用，故不采用。

## 影响

本批不运行付费真实模型。人工结论：当前机械测试不能证明与原用户等价；已知局限是脚本输出可对 intent/reason 拿满分，而真实协作质量只能在 opt-in 能力 lane 与人工复核中观察。

## 验证

`test/controller-collaboration-protocol.test.ts`、`test/controller-capability-evaluation.test.ts`、`test/candidate-run.test.ts`、`test/codex-experiment.test.ts`、`test/application/agent-host.test.ts`（路径伪引用修复 / 持续非法失败）、`test/application/controller-tools.test.ts`（模型可见 Evidence refs）覆盖协议；随后 `npm run check`。
