# 决策：Recovery Runtime 的外部副作用可观测性能力声明

状态：accepted

## 背景

Recovery 的隔离 staging、checkpoint、受控写入 journal 和 tree/hash verifier 只能证明本地候选工作区的状态。模型运行期间还可能触发远端 API、浏览器下载、IDE 操作、数据库写入或其他外部命令副作用；如果这些副作用没有被 Host 观察或补偿，本地文件树恢复不能被表述为“全部恢复”。

不同产品 Pack 对这些副作用的可见性和补偿能力不同。若由应用层按产品 ID 推测，新的 Pack 容易遗漏声明，并会让产品差异扩散到 Recovery 编排逻辑。

## 决定

`RuntimePort.recoveryCapabilities()` 统一返回 `externalSideEffects`：

- `unobserved`：Runtime 未提供 Host 可验证的外部副作用清单、补偿动作或结果证据；Recovery 只能恢复并验证本地 workspace，必须在模型上下文和审查结论中保留该限制。
- `compensatable`：仅在该 Runtime 未来能够提供 Host 可观察的操作分类、补偿请求/结果证据、失败策略和审查路径时使用；声明该值之前必须在两个 Pack 同步实现对应的 port 合同、事件与验证。

当前 Codex 与 Claude Code Pack 都明确声明 `unobserved`。这不是拒绝最大努力调查：Agent 仍可在隔离 candidate 中调查、生成候选、执行受控本地恢复并提出审查建议；它只禁止把未观察到的远端或工具副作用伪报为已恢复。

任何新增 Runtime 能力必须先修改 `src/core/runtime.ts` 的 port，再同步实现两个产品 Pack 和 fake runtime。应用层只消费能力声明，不以产品 ID 分支。

## 后果

- 本地 checkpoint/manifest/hash 验证的结论范围被明确限定为 workspace；`verified` 不自动外推到 browser、database、remote API 或 IDE 状态。
- 恢复模型 prompt 可向 Agent 暴露该限制，使其将外部影响列为待审查或待补偿事项，而非臆造回滚完成。
- 后续的 `compensatable` 实现必须新增 Host-owned request/result 事件和 evidence ref，记录操作分类与补偿验证；失败不得降格为“已恢复”。事件不得保存凭据、命令行、用户正文或外部响应正文。
- 本决策不改变默认真实 Runtime/API opt-in 要求，也不放宽 source isolation、path boundary、evidence ownership 或自动接受条件。

## 验证

`test/codex-pack.test.ts`、`test/claude-code-pack.test.ts` 与 `test/codex-experiment.test.ts` 覆盖两个 Pack、fake runtime 和 Recovery 模型 context 的能力声明。源码验证应运行 `npm run build`、受影响测试、`npm run verify:docs` 和 `npm run check`。
