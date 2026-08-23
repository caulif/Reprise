# Recovery task outcome semantics

- 状态：accepted
- 日期：2026-08-22

## 决策

Recovery 的最终交接结果由 Host 根据隔离 staging 的事实决定，Agent 不能通过自述设置终态。持久化的 `taskOutcome` 允许值为：

- `ready_for_task`：任务相关 readiness 检查通过，Host 已自动接受 staging baseline；
- `unrecoverable`：在当前证据、工具和有界反馈预算内无法恢复到可继续状态；
- `blocked_by_safety`：继续检查或操作会越过 staging、路径或其他安全边界；
- `runner_failed`：Provider、Runtime、Host 或持久化基础设施失败。

只有 `ready_for_task` 才是正常自动交接出口。`pending_user_review` 继续作为兼容和异常审查结果保留，但不代表任务已恢复，也不能替代 readiness 检查。

`taskOutcome` 同时写入恢复 baseline 和 evaluation row；`taskOutcomeCounts` 用于批次观测，不作为模型能力的单一评分。source safety、失败产物保留和 resume 语义不因该字段放宽。

## 边界

- `taskOutcome` 由 Host 写入，Recovery Agent 的报告、candidate 或 hypothesis 不能改变它；
- `ready_for_task` 必须伴随 `recovery.ready_for_task` 事件和自动接受事件；
- readiness 越界必须归类为 `blocked_by_safety`，不得降级为普通证据不足；
- readiness 有界重试耗尽或连续无进展归类为 `unrecoverable`；
- Provider/Runtime/持久化故障归类为 `runner_failed`，并保留可追溯的失败 artifact。

## 验证

- 自动 ready 测试验证 baseline、evaluation row、事件和自动接受；
- 无进展测试验证 `recovery.no_progress`、feedback 次数和 `unrecoverable`；
- readiness 越界测试验证 `blocked_by_safety`；
- 修改源码后执行 `npm run build` 和受影响 Recovery 测试，最终执行 `npm run check`。
