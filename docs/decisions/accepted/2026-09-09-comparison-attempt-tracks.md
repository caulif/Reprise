# 决策：Comparison attempt 的 history/candidate 双轨

状态：accepted

延续 [LaunchContext](./2026-09-09-candidate-launch-context.md) 与 [Runtime 事件与用户可见回合](./2026-09-09-candidate-runtime-events.md)。目标见 [Application 与候选链重构](../../plan/application-candidate-agent-refactor.md) 阶段 I。

## 问题

Comparison 需要同时阅读历史会话与候选运行，但不能把两侧压成同一份结构。若只保留 Agent 工具用的 `briefing/` 导航，attempt 根上缺少计划要求的 `history/` 与 `candidate/` 轨迹。

## 决定

CandidateRun 清理封存后，Host 生成不可变 `comparison-attempts/{attemptId}`，根上包含 `INDEX.md`、`facts/`、`history/`、`candidate/` 和 `work/`。`history/` 提供历史消息索引并指向 `observations/`；`candidate/` 提供过程索引、用户视图副本和 outcome。缺失 token/速度/费用保持缺失。Agent 仍通过既有 briefing 工具面阅读，挂载 `history/`、`turns/`、`run/`、封存 `candidate/` 与 `evidence/`。不访问活动 Session，不改写事实。

`RunRecord` 可携带绑定后的 `session`（`CandidateSessionHandle`），供 CLI/TUI 输出候选 `sessionId`。

## 备选方案

**只保留 briefing/ 目录。** Agent 能工作，但 attempt 根无法按计划分开两条轨迹。

**强行统一 history 与 candidate 的文件形状。** 两侧来源不同，补零或改写会伪造证据。

## 影响

报告失败不得覆盖候选 outcome 与已发布成功报告。TUI/CLI 不拼接 attempt 路径，使用 Application 返回的根。

## 验证

`test/application/comparison-tracks.test.ts` 从新建 attempt 根按 INDEX 挂载读取全部 settled user-view、Controller 消息、Runtime 过程、历史用户输入与历史 Agent 过程、artifacts 与 workspace snapshot。`test/codex-experiment.test.ts` 断言 attempt 根 `INDEX.md` 与 `candidate/outcome.json`。`npm run check` 必须通过。
