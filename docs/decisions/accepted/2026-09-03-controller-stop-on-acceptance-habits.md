# 决策：Controller 按这个人的验收习惯停，不按种类或剧本

状态：accepted
日期：2026-09-03

## 问题

同等人类能力要求 Controller 看见完整会话并自行 `send` / `done`。现行 prompt 把停机第一条收成 `baseline.finalMessage` 的交付物种类，并禁止「形式上再确认」；后续用户句还要等候选先问。多轮改稿任务会在第一枪同类产物上提前 `satisfied`。按序重放全部历史用户句会把对照收成剧本，候选换路时下一句对不上屏幕。

## 决定

- 停止条件是：这个人按原会话表现出来的验收习惯，面对**当前**产物会不会停。种类对齐不够；完成声明不够。
- 用户后续句是知识与习惯，不是队列。适用则用这个人的口吻说；已经满足则不重复。不必等候选先问。
- 不按历史下标投递用户句。不因「还有未用的 historicalUserTurns」拒绝 `done`。不把「send 次数 ≈ 历史用户句数」做成门禁。
- Host `current.summary` 不内嵌候选终态正文；可投影后续用户句条数。

## 备选方案

**种类匹配即停。** 展示页、文案类任务会在第一版离席。

**Host 按序强制投完历史用户句。** 轮次绑定历史结构，不同路径的更好候选被拖去复读。

## 影响

[Controller 设计](../../architecture/controller.md) §9–10。[实验条件](../../architecture/controller-experiment-conditions.md) §1.6 与 §5。实现规划：[看完整会话再自主停](../../plan/controller-judge-from-full-session.md)。

## 验证

- `test/snapshots/controller-system-prompt.txt` 含 acceptance habits，不含 ask-then-inform 与 formal re-confirmation。
- `test/controller-full-session-judgment.test.ts`：briefing 含改稿且仅一轮时假模型 `send`；无后续句时 `done`。
- `test/experiment-inspection.test.ts`：`currentSummary` 不含候选终态正文。
