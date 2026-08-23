# Recovery 双层评估指标

- 状态：accepted
- 日期：2026-08-18

## 背景

历史 completed session 通常没有任务开始时的文件真值。它们可以衡量最大努力调查是否覆盖、是否生成候选，以及用户或重放是否认可候选，但不能证明字节级恢复准确率。把这类数据与带 checkpoint 的故意中断样本混为同一成功率，会把不可验证的候选误报成恢复正确率。

## 决策

新增 `RecoveryEvaluationCase` 作为只读评估输入，分成两个互不混合的层：

- `history_completed`：报告调查覆盖率、候选生成率、用户接受率、候选重放通过率、调用成本和延迟；
- `interrupted_checkpoint`：在同样指标外，基于 checkpoint 的预期路径与已验证候选路径报告 verified precision/recall。

`evaluateRecoveryCases` 在聚合前以 `Value.Check(RecoveryEvaluationCaseSchema, row)` 校验每一行。分母为零的比率不伪造为 0 或 100%，而是省略 `value`。checkpoint recall 的真值分母覆盖该层全部 fixture，而不只覆盖已标记 verified 的候选。

## 后果

产品可无费用地使用 fixture 或已持久化的测量行验证指标计算；真实外部模型实验仍需要显式 opt-in。任何 99% 声明必须以预先定义的 `interrupted_checkpoint` 人群、完整真值和独立样本为依据，不能由历史 completed session 推断。
