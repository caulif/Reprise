# 非确定性 Agent 的最小验证边界

本文约束当前实现。未关闭验收见 [MASTER](../progress/MASTER.md)。

状态：当前模块设计

本文定义 Harness 如何验证包含非确定性 Agent 的系统。目标不是证明 Agent 总能做出好判断，而是保证 Agent 的任何输出都不会破坏系统的安全性、一致性和可追溯性。

## 1. 核心原则

> 相信 Agent 完成语义判断；确定性代码只守住不可交给概率行为负责的边界。

Controller 自主决定下一条输入或结束，Recovery Agent 自主分析恢复方法，Comparison Agent 自主选择值得展示的差异。测试不约束它们的具体措辞、推理路径或固定策略。

Harness 只验证四类不变量：

```text
Schema
Capability
Lifecycle
Fact integrity
```

## 2. Schema

Agent 输出进入系统前必须符合对应公共协议：

- Controller 输出合法的 `ControllerDecision`；
- Recovery 输出合法的恢复计划；
- Comparison 原样写入完整 `report.html`，并输出合法的薄 `ComparisonEnvelope`；
- `send` 包含非空、可提交的输入；
- artifact、run、environment 和 evidence 引用能够解析。

非法输出可以由 Pi Agent Host 在相同上下文中进行有限次数修复；达到上限后使用确定性 fallback。修复次数由 Host 强制，不由 Agent 决定。

Schema 验证只判断输出是否可执行，不判断内容是否聪明或措辞是否理想。

## 3. Capability

Agent 只能使用 Host 显式提供的能力：

- Controller 使用与 Recovery 相同的七个工具名；隔离副本只读挂载，不得写用户源目录、不得调用 Target 工具或改 CandidateRun 状态机；
- Comparison 使用同一七个工具名；`candidate/` 只读挂载，只许写本次 attempt 的 `scratch/`、`work/comparison-plan.md` 与 `report.html`；不得改实验状态或排名候选；
- Recovery 的写入能力只作用于 Harness 持有的 staging；
- 路径、ownership、隐私和大小限制由工具实现验证；目录包含用规范化后的真实路径关系，不用简单字符串前缀；
- 恢复接受、候选投递、报告发布由 harness 拥有，不增加跨角色 Verifier 接口；
- 权限扩大、真实发布、付款、删除和其他不可逆动作必须来自真实用户授权。

这些约束通过不给予能力和在工具边界验证实现，不依赖 system prompt，也不测试 Agent 是否会自觉遵守。

## 4. Lifecycle

Harness 自己维护实验生命周期和副作用一致性：

- CandidateRun 只能进行合法状态迁移；
- 输入 submission 使用稳定 operation ID，不能因重试重复发送；
- accepted、rejected 和 delivery unknown 必须区分；
- stop、cancel、timeout、Runtime crash 和 cleanup failure 都进入明确状态；
- trace、RunRecord 和 artifact 在崩溃恢复后仍然一致；
- cleanup 和 release 应幂等，失败必须被记录。

Agent 只提供决定，不拥有 Orchestrator 状态，也不负责持久化一致性。

## 5. Fact integrity

Agent 可以解释事实，但不能创建或提升事实：

- Comparison 引用的 evidence 必须真实存在并属于当前 experiment；
- Recovery 的推断不能自行提升为 `verified`；
- telemetry、当前执行 Runtime 事实、fingerprint 和 artifact hash 由确定性代码产生；
- `unavailable`、`unknown` 和 `runtime_drift` 不能被 Agent 改写为已匹配、稳定或已完成；
- 所有运行事实写入 append-only trace，派生结果保留来源。

## 6. 最小验证方式

### 6.1 确定性检查

直接测试公共协议、状态机、持久化、权限、ownership、事件顺序、fallback 和 Product Pack 的事件规范化。测试可以主动提供空消息、非法引用、越权路径、malformed JSON、重复提交和崩溃状态，确认确定性边界拒绝或降级。

### 6.2 Runtime 测试替身

Orchestrator 测试可以在测试目录中使用一个极小的 `ScriptedRuntime`：

```ts
const runtime = scriptedRuntime([
  inputAccepted(),
  turnSettled(),
  processExited(),
]);
```

它只负责触发 accepted、rejected、delivery unknown、turn settled、crash、cancel 和 timeout。它不模拟 Codex 或 Claude Code，不生成模型内容，不形成通用 scenario DSL，也不是生产架构组件。

Controller、Recovery 和 Comparison 的测试使用普通 stub 返回预设的合法或非法结构化结果，不建立通用 Fake Agent 框架。

### 6.3 Product Pack smoke

每个 Product Pack 可以提供一个可选的真实 Runtime smoke，只验证：

```text
启动
→ 接受输入
→ 识别 turn settlement
→ 多轮提交
→ 停止
```

这类 smoke 依赖本机安装、账号、网络和费用，不作为普通 CI 的默认必过项，也不要求 Runtime 完成固定任务。Session 解析和事件规范化优先使用脱敏 fixture。

## 7. 明确不验证

第一版不建立以下测试：

- Controller 是否采用某种纠正方式或总能适时结束；
- Recovery 是否选择了预期恢复路径；
- Comparison 是否选出了维护者认为最好的展示内容；
- Agent 是否生成指定措辞或固定推理过程；
- 不同模型是否对固定场景做出相似决定；
- prompt 质量评分、内部 Agent benchmark 或行为回归平台。

这些属于模型与 Agent 的实际能力，也是 Harness 希望让用户在真实任务中观察的部分。

## 8. 验收条件

- Agent 的合法语义空间不被测试用例预先规定；
- 非法、越权或不存在的输出无法进入执行边界；
- Agent 失败不会破坏 CandidateRun、环境或持久化事实；
- `ScriptedRuntime` 和 Agent stub 仅存在于测试支持代码；
- 真实 Runtime smoke 不成为普通开发和 CI 的硬依赖；
- 新增验证首先对应一个明确的不变量，不为假想行为建立框架。
