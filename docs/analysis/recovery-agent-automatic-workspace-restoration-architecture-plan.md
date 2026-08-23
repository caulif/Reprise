# Recovery Agent 目标收敛与自动恢复架构调整方案

> 日期：2026-08-22  
> 依据：`recovery-sample-20260821-5plus5-rerun` 原始产物、`targeted-review-20260822` 定向复核、当前 Recovery 代码和既有架构文档。  
> 目的：把 Recovery 从“生成候选并等待人工判断”收敛为“后台自动恢复用户真正需要的工作状态”，并规划对应的代码修改和真实会话测试。  
> 本文只做设计和执行规划，不在本轮修改源码。

## 1. 先纠正当前定位

用户真正需要的不是：

```text
Recovery Agent -> 生成 candidate -> pending_user_review
```

而是：

```text
用户原任务上下文 + 当前缺失/损坏环境
    -> Recovery Agent 自动调查
    -> 在隔离环境中执行恢复
    -> 检查恢复后的环境是否能继续原任务
    -> 必要时继续调查、修正和重试
    -> 恢复完成后自动交给后续流程
```

Recovery 的最终产物不是候选本身，而是：

> 一个已经恢复到足以继续用户原任务的工作环境。

candidate、hypothesis、diff、review artifact 都应是 Host 的内部过程产物，不应成为正常用户流程中的中间交互。只有无法安全或合理完成时，才向用户暴露问题。

这意味着当前 `pending_user_review` 不是理想的正常终态，而是当前实现尚未完成自动闭环的信号。它可以保留作为异常/降级终态，但不应成为大多数真实 Recovery 的落点。

## 2. 对本轮真实结果的重新判断

### 2.1 `codex-02`：恢复了路径集合，没有恢复出可继续工作的状态

`codex-02` 生成了 47 条路径，主要涉及：

- `content/chapters`；
- `docs/analysis`；
- `labs/mini-codex`。

Agent 明确说明：

- 没有 baseline content hash；
- 没有 Git preimage；
- 结果是 path-level；
- 空目录残留；
- 外部副作用未观测。

因此它目前只能减少人工盘点工作，不能证明用户可以继续原任务。按新的目标定义，它不是“部分恢复成功”，而是：

> Recovery 停在了调查/候选阶段，没有完成工作状态恢复。

问题不在于它没有生成 candidate，而在于 Host 没有要求 Agent 把候选继续推进到“可继续工作”的验证阶段。

### 2.2 `claude-04`：保留了两个解释，没有完成状态选择

`claude-04` 生成了两个候选和三个路径，但仍然停在 `pending_user_review`。这说明 Agent 能够识别不确定性，却没有完成以下必要动作之一：

- 继续调查以消除不确定性；
- 选择一个风险最低、最能支持原任务的状态；
- 在 staging 中运行原任务相关的最小检查；
- 明确判定当前无法自动恢复并进入异常终态。

在新的产品目标下，多候选不是最终结果。它只是内部搜索过程。Recovery 应该自动比较、验证和收敛；不能把候选图直接交给用户作为正常结果。

### 2.3 两个 case 暴露出的共同根因

当前系统更重视：

- candidate 是否生成；
- candidate 是否隔离；
- artifact 是否落盘；
- verifier 是否安全拒绝。

但用户需要的是：

- 恢复后的 staging 是否真的能继续原任务；
- 原 Runtime 是否能在恢复后的环境中启动或继续；
- 关键文件、依赖、目录和配置是否足够；
- Recovery 是否会自主补充缺失部分，而不是停在 review。

因此下一阶段的核心不是继续完善 candidate 展示，而是补齐：

```text
恢复目标 -> 执行闭环 -> 任务相关验证 -> Agent 继续修复 -> 完成后交接
```

## 3. 第一性原理：恢复成功到底是什么

不能用“文件树完全等于某个历史快照”定义所有恢复成功，因为真实历史任务通常没有完整真值；也不能用 Agent 自述、confidence 或 candidate 存在定义成功。

对于用户而言，更实际的定义是：

```text
恢复后的隔离环境能够让原任务继续进行，且没有违反明确安全边界。
```

这需要一个由原会话提取的**任务继续条件**，而不是一个通用真值评分器。它应描述“继续工作需要什么”，例如：

- 必须存在的工作目录；
- 必须存在的源文件、配置或输入资源；
- 原任务中已经使用过的工具/命令能够执行；
- 关键脚本、测试或启动命令能够通过；
- 当前工作状态能够被后续 Runtime 读取；
- 不可恢复的外部副作用被明确隔离，不影响本地继续工作。

这不是要求 Agent 预先填写唯一答案。Host 从历史会话和工具事实中提供可观察的约束，Agent 负责判断哪些约束与原任务真正相关。

### 3.1 成功判据应是“任务就绪”，不是“候选通过”

建议将内部结果语义收敛为：

```text
not_started
recovering
ready_for_task
unrecoverable
blocked_by_safety
runner_failed
```

其中：

- `recovering`：Agent 仍在调查、执行、比较或修正；
- `ready_for_task`：恢复后的 staging 已通过与原任务直接相关的检查，可以交给后续 Runtime；
- `unrecoverable`：在当前证据和能力边界内无法继续恢复，Agent 已记录原因；
- `blocked_by_safety`：继续操作会越过硬边界，需要外部授权；
- `runner_failed`：Host/Provider/持久化等基础设施异常。

`pending_user_review` 不应作为普通恢复成功路径。若保留兼容现有 schema，可以把它限定为用户真正必须做出决定的异常情况，而不是“Agent 生成候选但没有继续验证”的通用兜底。

这不是增加大量状态机。现有 `RecoveryOrchestrator` 可以继续持有生命周期；只需让“candidate pending review”不再是正常完成出口，而是回到 `candidate_running` 或进入明确不可恢复终态。

## 4. 目标架构：Agent 主导的自动闭环

### 4.1 新的核心循环

```text
prepare
  -> observe evidence
  -> form/refresh hypothesis
  -> execute recovery operations in staging
  -> inspect resulting state
  -> run task-relevant readiness check
  ->
       ready       -> hand off automatically
       not ready   -> return feedback to Agent and continue
       unsafe      -> stop as blocked_by_safety
       exhausted   -> unrecoverable
```

Agent 的任务不是一次输出一个 plan，而是对结果负责：

- 读取实际执行反馈；
- 检查候选是否真的改变了工作状态；
- 发现路径存在但内容、依赖或结构仍不对时继续处理；
- 比较候选而不是把选择交给用户；
- 在没有合理进展时停止并说明原因。

### 4.2 Host 的职责

Host 不替 Agent 做语义推理，但必须提供闭环所需的事实和反馈：

- staging 当前状态摘要；
- 每次操作后的 bounded diff；
- 关键文件存在性、类型、大小、hash 和可读取性；
- 原会话中可复用的命令和检查入口；
- 工具执行结果和失败原因；
- 任务相关 readiness check 的结果；
- 预算、超时、取消、重试和安全边界。

Host 不能只在最后接收一个 candidate，然后一次性调用 verifier。Agent 需要在运行过程中看到结果并据此继续工作。

### 4.3 Verifier 的职责

Verifier 只做三类事情：

1. 拦截安全越界和协议错误；
2. 执行明确、低歧义的机械检查；
3. 判断当前是否达到“任务就绪”的证据条件，并把反馈返回给 Agent。

Verifier 不负责决定用户语义，也不负责把所有历史任务压缩为 exact tree match。

### 4.4 Candidate 的位置

candidate 仍然可以存在，但它是内部搜索状态：

```text
candidate -> apply -> inspect -> readiness check -> Agent feedback
```

不能再是：

```text
candidate -> artifact -> pending_user_review -> 用户自己完成 Recovery
```

只有内部循环结束，candidate 才应被提升为最终 staging baseline；用户不需要知道中间产生过几个候选。

## 5. 代码修改方向

以下按优先级排列，遵循“先打通现有链路，再增加最小能力”的原则。

### P0-1：把 Recovery Agent 从“一次 plan”改为“结果驱动循环”

重点检查并修改：

- `src/agents/recovery-agent.ts`；
- `src/application/experiment.ts`；
- `src/application/recovery-orchestrator.ts`；
- `src/infrastructure/recovery-tools.ts`；
- 两个 Product Pack 的 Recovery playbook/prompt。

当前 Agent 能生成 plan、写 report、写 manifest，但真实结果表明它在候选形成后没有持续负责“环境是否已经可用”。

最小改法不是增加新 Agent，而是让现有执行函数支持有限的内部迭代：

```ts
for (;;) {
  const decision = await recoveryAgent.nextTurn(context);
  const result = await host.execute(decision);
  const readiness = await host.checkReadiness(result);
  if (readiness.ready) return readyForTask;
  if (readiness.blocked || budget.exhausted) return terminal;
  context = appendFeedback(context, result, readiness);
}
```

这段循环可以留在现有 Recovery experiment 编排中，不需要引入通用 workflow abstraction。

关键约束：

- 迭代次数/时间/模型预算只作为兜底，不是 Agent 的成功目标；
- 每次循环必须有新的工具反馈或证据变化，避免无效重复；
- Agent 可以一次完成，也可以多次调查；
- 没有新增证据时可以主动停止；
- 不允许无限重试。

### P0-2：从历史会话提取“任务继续条件”

当前输入偏重 evidence 和历史观察，但没有把“恢复后如何判断可以继续原任务”作为一等输入。

建议在 Host 侧从以下内容提取候选 readiness signals：

- 原会话中的工作目录；
- 用户任务目标和初始输入；
- 已执行成功的命令；
- 任务相关文件路径；
- 已观察到的输入和输出资源；
- 原 Runtime 曾经使用的启动/测试入口。

这些 signals 只作为 Agent 可调查的事实和检查入口，不是自动生成唯一答案。Agent 仍需判断相关性。

最小结构可以是：

```ts
type RecoveryReadinessContext = {
  taskSummary: string;
  observedWorkspaces: string[];
  relevantPaths: string[];
  priorCommands: string[];
  availableChecks: string[];
};
```

如果跨模块持久化或模型可见输入发生变化，需要同步更新 schema、event log 和相应 ADR；不要只在应用层临时拼接字符串。

### P0-3：增加“任务就绪检查”而非通用恢复评分器

新增的检查应尽可能复用已有 Runtime/Provider 能力：

- 工作目录是否存在；
- 任务相关文件是否存在且可读取；
- 原会话中成功执行过的直接相关命令能否在 staging 执行；
- 关键脚本/测试/构建入口是否能运行；
- 输出是否能被后续 Runtime 读取。

不要实现一个通用“恢复正确性评分器”。检查器只返回 Agent 能采取行动的反馈，例如：

```json
{
  "ready": false,
  "observations": [
    "workspace exists",
    "task input missing",
    "historical command failed: dependency unavailable"
  ],
  "nextEvidenceNeeded": ["..."],
  "safeToContinue": true
}
```

### P0-4：自动完成后直接交接，不把正常流程停在 `pending_user_review`

当前 `experiment.ts`、`recovery-verifier.ts` 和 terminal/evaluation 逻辑需要重新定义：

- candidate 生成不等于完成；
- candidate 通过机械检查后，继续做 readiness check；
- readiness 通过后，自动选定内部 baseline；
- 只有明确安全问题或不可消除的语义冲突才进入 review/degraded outcome；
- `pending_user_review` 不作为默认候选出口。

如果现有 Provider 的“accepted”语义代表实际接受 staging candidate，需要重新检查它是否可以作为 Host 内部 promotion，而不是用户操作。

### P1-1：修正失败信息保留和分类

继续修正之前真实样本暴露的 Claude-01/02 问题：

- Agent 已完成但 Provider validation failed，不得泛化为 `runner_crashed`；
- 保留 Agent report、manifest、candidate、hypothesis、unresolved 和 validation reason；
- 只有真正进程/编排异常才使用 `runner_crashed`；
- 自动恢复循环的最后一次 feedback 要落入 artifact 和 event log。

### P1-2：把候选图降为内部实现细节

当前 `candidate graph` 对调试有价值，但不应成为用户交互中心。应确保：

- 正常成功只暴露最终 staging baseline 和简洁 recovery summary；
- 中间候选仍可审计；
- 用户不需要选择候选才能完成恢复；
- 只有自动收敛失败时，才展示候选分支和请求协助。

### P1-3：补齐物化能力，但只补任务需要的部分

`codex-02` 报告空目录残留，说明工具能力存在限制。不要立刻扩展成通用文件系统管理器。

先确认空目录是否影响原任务：

- 如果不影响，作为非阻塞 observation；
- 如果影响任务就绪，增加一个受限的 staging-only directory cleanup capability；
- 仍然禁止 source 删除和 source 外操作。

这是“由任务反馈决定工具能力”，而不是为覆盖所有边界预先增加工具。

### P1-4：修正定向复核事实提取

当前 `targeted-review-facts.json` 将存在的 `events.jsonl` 记录为 `eventLog: false`，应修正复核脚本，保证真实评估事实可信。此问题不直接改变 Agent 恢复能力，但会污染后续诊断。

## 6. 真实会话测试：必须测试“恢复后能否继续任务”

现有 5+5 主要测试了：

- staging；
- forensics；
- source unchanged；
- candidate 持久化；
- resume。

这些仍然是必要条件，但对新的目标不够。下一轮真实测试必须把 Recovery 后的环境交给原任务的最小继续路径。

### 6.1 样本选择

不要随机增加 case 数量。优先从真实历史会话中选择能明确继续验证的 case：

- transcript 完整；
- task goal 可理解；
- 有至少一个历史成功命令、输出或任务相关文件；
- 有可重复的本地继续操作；
- 能在隔离 staging 中运行，不依赖不可控外部副作用。

第一批建议 4 个：

- Codex 2 个；
- Claude Code 2 个；
- 每个 Provider 一个高证据、一个中等证据；
- 暂不把完全没有 task-path outcome 的 case 作为主要成功验证样本，只作为安全拒绝样本。

### 6.2 每个真实 case 运行三段，而不是只看 Recovery artifact

```text
A. 原始会话基线
B. Recovery Agent 自动恢复
C. 恢复后的任务继续验证
```

#### A：原始会话基线

在测试前由人工记录：

- 用户原任务是什么；
- 任务继续需要哪些输入和工作区；
- 原会话成功执行过什么命令；
- 预期的最小继续动作是什么；
- 哪些外部状态不纳入本地恢复范围。

不要把答案写入 Agent prompt；这是测试者自己的评估基线。

#### B：Recovery 自动恢复

- 只启动一次真实 Recovery Agent；
- 不人工提示下一步；
- 允许 Agent 读取证据、形成假设、执行操作、检查反馈并继续迭代；
- 直到 readiness 通过、明确不可恢复或安全/预算终止；
- 不把中间 candidate 交给用户选择。

#### C：任务继续验证

用原任务中最小、直接相关、可重复的继续动作验证 staging：

- 重新读取原任务需要的文件；
- 执行原会话中已成功的关键命令；
- 运行原任务相关的最小测试或构建；
- 让后续 Runtime 从恢复后的 staging 开始实际继续一小步；
- 检查输出是否能支持下一步工作。

这里不是要求结果和历史目录 exact match，而是验证“原任务是否真的能继续”。

### 6.3 自动运行测试的终态

真实测试应该观察 Recovery 是否自动完成，而不是人工把它从 pending 推进下去。

每个 case 最终只能进入以下几类：

```text
ready_for_task
unrecoverable_with_explanation
blocked_by_safety
runner_failed
```

如果仍然停在 `pending_user_review`，测试结果应记录为：

> 自动恢复闭环未完成。

而不是把它当作正常成功结果。

### 6.4 真实测试记录

每个 case 保存：

- recovery run 和 session hash；
- Agent 每一轮的观察、操作和反馈；
- 每个候选的内部状态；
- 最终选中的 staging baseline；
- readiness check 结果；
- 任务继续验证的命令、输出摘要和退出状态；
- source 前后 digest；
- 最终终态和失败原因；
- 模型调用、耗时和预算消耗。

人工只在测试结束后评价：

- 任务是否真正继续；
- 恢复结果是否满足原任务需要；
- 是否有不必要的猜测或遗漏。

## 7. 真实测试方案

### 阶段 A：当前版本建立行为基线

先不修改 Agent，使用当前版本选 4 个真实 case 运行一次，目的是记录：

- 当前有多少 case 停在 `pending_user_review`；
- 有多少 case 能生成路径候选；
- 恢复后任务能否继续；
- 哪些 case 的失败来自缺证据，哪些来自没有任务相关检查。

预计当前版本会再次暴露：

- candidate 已生成但没有继续验证；
- path-level 结果被当作主要产物；
- `pending_user_review` 过早终止；
- Provider validation 和真实任务 readiness 没有闭环。

### 阶段 B：完成最小自动闭环后重复同一批 case

只修改 P0 项：

1. 任务继续条件输入；
2. Agent 反馈循环；
3. readiness check；
4. 自动选定最终 staging baseline；
5. 明确异常终态。

不要同时改 prompt、候选图、工具面、指标和 UI，否则无法知道哪项改变有效。

### 阶段 C：对比真实任务继续能力

比较同一批 case 的：

- 是否从 pending 继续进入 ready 或明确 unrecoverable；
- 是否实际执行了额外调查；
- 是否减少了人工接管；
- 恢复后的任务继续动作能否完成；
- Agent 是否因为反馈而修正候选；
- 无法恢复时是否比旧版本更具体地说明缺口。

关注结果变化，不追求模型调用次数下降。多调用几次但成功恢复用户状态，比一次调用生成候选更符合目标。

### 阶段 D：再扩大到 5+5

只有在 4 个代表性 case 的自动闭环明确工作后，再重跑完整 5+5。

5+5 的报告应新增：

- `ready_for_task` 数量；
- 任务继续验证通过/失败及原因；
- 自动恢复轮数；
- 自动终止原因；
- 仍需人工介入的 case；
- source safety 和 resume 结果。

这些是观测维度，不应组成一个总分，也不应成为 Agent 的硬性目标。

## 8. 测试通过标准

### 8.1 安全和工程底线

以下必须全部满足：

- source 未修改；
- staging 隔离；
- 工具和路径边界有效；
- 每一轮 Agent 操作可追溯；
- terminal 与实际结果一致；
- Agent 完成但 Provider validation 失败时产物不丢失；
- resume 不重复已经完成的 case；
- 真实运行费用和网络能力符合预期。

### 8.2 自动恢复能力

不设统一成功率，但每个代表性 case 必须能清楚回答：

- Agent 是否一直运行到 readiness 通过或明确不可恢复；
- 是否执行了至少一次任务相关的恢复后检查；
- 是否把检查反馈交回 Agent；
- 是否在有新证据时继续修正；
- 是否避免无新信息的盲目循环；
- 最终是否自动选择 staging baseline，而不是把候选选择推给用户。

### 8.3 用户结果

对熟悉原任务的人进行真实交接验证：

- 恢复后的 staging 是否可以继续原任务；
- 用户是否无需重新从头定位关键上下文；
- 恢复结果是否包含任务需要的核心文件和状态；
- 缺失内容是否明确，且不会误导用户；
- 如果不能恢复，是否清楚知道不可恢复的具体原因。

这里的目标是“恢复用户工作状态”，不是“candidate 数量更多”或“verified 数字更高”。

## 9. 不应采用的方案

为避免再次偏离目标，明确不做：

- 不把 `pending_user_review` 作为正常 Recovery 完成状态；
- 不把 candidate graph 直接交给用户让用户完成恢复；
- 不把路径列表当作内容或工作状态恢复；
- 不为了通过 verifier 强行要求所有历史 case 有 content hash；
- 不增加通用 truth engine、统一评分器或复杂 Agent 角色；
- 不用模型 confidence、模型调用次数、candidate 数量定义成功；
- 不在没有新证据时盲目重跑真实模型；
- 不把人工 acceptance 伪装成 Agent 自动恢复。

## 10. 推荐实施顺序

### 第一步：修复评估事实和当前工程阻塞

- 修正 `targeted-review-facts.json` 的 `eventLog` 误报；
- 判断并解决 TUI frame baseline 差异；
- 继续修正 Claude validation failure 的错误分类。

### 第二步：设计并接入任务继续条件

先从现有历史会话中提取最小的：

- task summary；
- relevant workspace；
- relevant paths；
- prior successful commands；
- available readiness checks。

跨模块协议或模型可见输入变化时，更新 schema、事件和 ADR。

### 第三步：将 Agent 改成反馈驱动的自动循环

- candidate 只作为内部状态；
- apply 后立即 inspect；
- 执行 task-relevant readiness check；
- 未就绪时将反馈交回 Agent；
- Agent 自主继续、修正或停止；
- 就绪后自动选定 staging baseline。

### 第四步：用 4 个真实 case 验证任务能否继续

必须运行原任务的最小继续动作，不能只查看 artifact。

### 第五步：再跑完整 5+5

将报告重点从：

```text
candidate generated / pending review
```

改为：

```text
ready for task / task continuation result / unrecoverable reason
```

## 11. 最终结论

你指出的问题是正确的：如果 Recovery Agent 的正常结果是生成候选后让用户自己判断和继续恢复，那么它还没有完成 Recovery 的核心职责。

这次真实定向复核证明 Agent 已经具备调查和候选生成能力，但也证明当前实现过早把控制权交还给用户：

- `codex-02` 停在路径级候选；
- `claude-04` 停在多候选比较；
- 两者都没有完成“恢复后可以继续原任务”的验证。

下一阶段应把架构收敛到：

```text
Recovery Agent 对恢复结果负责
    -> 自主调查
    -> 实际执行
    -> 检查恢复后的工作状态
    -> 根据反馈继续修复
    -> 自动选择最终 staging baseline
    -> 只有无法安全或合理恢复时才暴露给用户
```

最重要的修改不是增加更多候选、更多报告或更多人工复核，而是补上**任务继续条件、恢复后检查、Agent 反馈循环和自动完成/异常终态**。

这样既能充分相信 Agent 的能力，又不会让系统停留在“安全地产生半成品”。
