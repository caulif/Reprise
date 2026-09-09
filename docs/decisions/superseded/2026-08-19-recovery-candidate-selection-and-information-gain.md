# Recovery 候选选择与信息增益边界

状态：superseded

被 [单工作副本自主三轮循环](../accepted/2026-09-09-recovery-single-workspace-agent-loop.md) 取代。下文冻结。

- 日期：2026-08-19
状态：superseded
- 范围：Recovery Agent 候选图、人工选择、重复工具调用

## 决策

1. 候选图由 Host 根据已验证事实生成并持久化。Agent 可以调查、提出假设、执行候选并报告结果，但不能凭模型自述改变候选状态或证明用户已经选择了候选。
2. `pending_user_review` 候选必须保留在 Provider-owned 隔离目录。Host 暴露 `selectCandidate(candidateId)` 作为人工选择入口；选择写入 `recovery.candidate_selected_by_user`，包括 candidate、hypothesis、graph artifact 和 `requiresReexecution`。
3. 人工选择不直接复制候选到 source，也不直接 `accept`。尚未重新执行并通过 Provider 验证的 alternate candidate 必须继续拒绝接受，避免把审查意图误报成 `verified`。
4. Recovery attempt 返回后，选择事件使用短生命周期 ExperimentStore writer 持久化并通知 Host event listener；不能依赖已关闭的主 attempt writer。
5. Host 按 hypothesis 递减剩余搜索预算，并拒绝估计成本超过剩余预算的 probe。内部 Agent 工具调用不再按次数、破坏性次数或相同输入拦截；上下文走 Pi 压缩，见 [对齐 Pi 循环](../accepted/2026-09-02-internal-agent-pi-alignment.md)。受控写入或 shell 成功仍推进 mutation version，供候选图与证据记账，不用于拒绝重复读取。

## 不变的安全边界

- source isolation、source tripwire、路径边界、symlink ancestor 检查、evidence ownership、manifest/hash verifier 和显式 accept 不放宽。
- `partial`、`insufficient_evidence`、人工选择和 `verified` 继续分层；没有独立真值和机械验证时不得宣称恢复成功。
- 默认不调用真实 Runtime/API；本决策不改变费用和凭据边界。

## 后续实现

- **已完成：**为每个 alternate candidate 建立独立的重新执行上下文、controlled-write journal、report/manifest 和 Provider validation 事件；accept 仅允许最新已重新执行并验证的候选。
- **已完成：**将用户 accept/reject/needs_more_evidence 记录为 schema-checked immutable feedback artifact 和 `recovery.review_feedback_recorded` Host event，并绑定 staging digest；accept feedback 同时生成 Provider-owned reviewed staging checkpoint，供后续运行复用。
- **已完成基础：**在不牺牲安全边界的前提下，记录每个 hypothesis 的 evidence 增益、风险、成本和剩余预算；无新信息停止，弱但新证据继续调查。更复杂的跨次预算校准仍可继续扩展。

