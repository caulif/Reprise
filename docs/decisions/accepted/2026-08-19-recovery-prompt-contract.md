# Recovery Agent 上下文与候选边界提示词契约

- 日期：2026-08-19
- 状态：accepted
- 范围：Recovery system prompt 的证据层、候选隔离和外部副作用声明

## 决策

Recovery prompt 必须明确告诉 Agent：

1. `history` 输入只是历史线索，不得把推断出的命令、文件、工具调用或结果写成观察事实；
2. `investigation` 包含 Host 持久化的 hypothesis 和事实引用，候选应保留竞争分支，而不是盲选一个答案；
3. Agent 在 Host 选定的 candidate 隔离目录中工作，不能把 staging 或 source 当作可写目标；
4. `runtimeCapabilities.externalSideEffects` 只声明能力边界。`unobserved` 时，本地 workspace 恢复不能证明远程、IDE、浏览器或数据库副作用已经回滚；
5. 弱证据也必须先检查当前 workspace、Git 状态和可用 session evidence；只有完成记录化调查后，才可以使用 `insufficient_evidence`；
6. `pending_user_review` 是合法的调查结果，不是模型失败；`verified` 仍必须由 Provider 的独立验证和 manifest/evidence 约束支持。

## 影响

该契约变更会改变 Recovery system prompt 的稳定文本，因此同步更新专用 snapshot。snapshot 只验证提示词契约是否被意外漂移，不放宽任何 source isolation、source tripwire、路径、symlink、evidence ownership、hash verifier 或显式 accept 边界。

## 验证

- `test/snapshots.test.ts` 必须验证 Recovery prompt 与已接受契约一致；
- Agent host 和 Recovery evaluation 反向测试继续验证无效输出、未知 evidence ref、工具失败、Provider rejection 和 source tripwire 不会被提示词改写成成功。
