# 决策：Recovery 机械检查失败不得沿用未通过的 ready 信封

状态：accepted

## 问题

`probeRecovery` 失败后再给 Agent 一轮 feedback 时，若反馈未完成却恢复上一份 `ready` 信封，Application 会在 staging 未通过时放行 Candidate。

## 决定

机械 feedback 调用未完成时抛错，不得把 `lastCompletedRecovery` 当作已通过检查。Agent `blocked` / `insufficient_evidence` 以及 ready 但没有 staging 都不能获得 Candidate 启动门。

## 备选方案

**反馈失败时恢复上一份 completed 信封并 finalize。** 机械检查被旁路。

## 影响

机械 verifier 只拒绝不安全或不完整结果。

## 验证

`test/application/experiment-operations.test.ts` 覆盖 blocked 信封与缺 staging 不能启动。
