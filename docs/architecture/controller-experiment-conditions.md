# Controller 实验条件

状态：当前模块设计

本文定义的不是如何限制 Controller 的智能，而是如何让它在不同候选模型之间代表同一种用户协作能力。Controller 仍然可以根据每条候选轨迹自主决定下一条输入。

## 1. 已确认结论

1. Controller 模型由用户配置，直接复用 Pi 成熟的 provider 和 model API，不在 Harness 中重新实现 provider 抽象。
2. “固定 Controller”是指同一个 Experiment 内将 Controller 作为控制变量，不是把某个模型硬编码成产品默认值，也不是要求不同时间创建的所有 Experiment 永久使用同一模型。
3. 每个 CandidateRun 使用独立的 Controller session，候选之间不共享隐藏状态；同一 Experiment 的候选共享同一份已解析 Controller 配置。
4. Pi Agent Host 随项目正常更新，不要求恢复或固定历史 Host 版本，也不作为目标 Runtime 的比较变量。
5. Controller 可以且必须访问 TaskCase 中的完整原始会话。原始会话是理解用户目标、知识、偏好、纠正方式和验收习惯的证据，不是需要隐藏的标准答案；Target Runtime 仍只从 `TaskCase.initialInput` 开始。
6. 完整原始会话的使用边界由 canonical system prompt 明确限制：历史后续轨迹用于理解用户目标、知识、偏好和协作方式，不得把原 Agent 后来调查得到的答案或实现路径当作用户原本知道的事实直接提供给候选。第一版不再设计未来信息检测、答案泄漏评分、第二审查 Agent 或人工用户策略规则。
7. “同等人类能力”不能被证明，只能被操作化。产品实现的是固定条件下的适应性用户协作模拟，不声称精确预测真实用户在反事实情境中的唯一输入。
8. Controller 使用什么模型不属于 Harness 的产品判断，取决于用户通过 Pi 能访问什么模型。Harness 不捆绑、推荐或评价 Controller 模型。

## 2. “实验内固定”的准确含义

用户在创建 Experiment 时选择 Controller provider、模型及必要参数。Harness 在首个候选运行前通过 Pi 解析配置，得到一份 `ResolvedAgentConfig`。所有候选各自创建 session，但引用同一配置快照。

```text
用户选择 Pi provider / model / options
                ↓
       解析 Controller 配置
                ↓
       ResolvedAgentConfig
          ├── Candidate A 独立 session
          ├── Candidate B 独立 session
          └── Candidate C 独立 session
```

固定的是实验条件：

- 请求和解析后的 Controller 模型身份；
- canonical system prompt 版本或内容 hash；
- 工具能力边界；
- 原始会话可见范围；
- 可选总预算、单次超时、结构化修复和 provider 重试规则；
- 上下文压缩策略；
- privacy 与权限策略。

不要求实际行为相同：

- 不同候选触发的 Controller 决策次数可以不同；
- 实际 token、成本、延迟和工具调用可以不同；
- 压缩发生的时刻可以因轨迹长度不同而不同；
- Controller 生成的消息内容和意图可以不同。

这些差异正是 Controller 适应候选轨迹的结果，应进入 trace，而不是被强行抹平。

### 2.1 配置归属

Controller 配置属于 `ExperimentSpec` 的实验级条件，而不是 `CandidateSpec` 的候选级属性：

```ts
interface ExperimentSpec {
  experimentId: string;
  taskCaseId: string;
  candidates: CandidateSpec[];
  controller: AgentConfig;
  comparison: AgentConfig;
  runPolicy: RunPolicy;
  outputRoot: PathRef;
}
```

这样类型本身就能阻止无意中为每个候选选择不同 Controller，并冻结 Comparison 的实验级请求配置。Recovery 配置属于 Case Preparation，解析快照保存在 `TaskCase.provenance`；Controller 解析快照写入各 `RunManifest`；Comparison 解析快照写入 Comparison projection。setup 默认值后来变化不能静默覆盖这些快照。若用户确实想研究不同 Controller，应创建不同 Experiment；第一版不增加候选级 override 或“非公平模式”。

Harness 不保存 provider secret，只保存 Pi 能安全持久化的 provider 标识、请求模型、解析后模型身份、非敏感参数和配置 hash。

Controller 模型没有产品规定的能力门槛，也不参与 fidelity 判定。用户可以选择任意 Pi 可用模型；Harness 只校验它能否满足必要的调用、工具和结构化输出契约。模型不可用或调用失败时明确结束为 Controller failure，不能静默切换到另一个模型。

## 3. Pi Agent Host 版本

Pi Agent Host 是 Harness 的实现基础设施，不是需要恢复的历史 Agent Runtime，也不是被测变量。项目可以正常升级 Pi 和 Host 实现，不需要建立 Host 版本下载、历史恢复或 fidelity 匹配机制。

推荐只做最低限度的可观测性：

- RunManifest 记录 Harness 版本或构建标识；
- 记录 Pi 依赖版本和 Controller prompt hash，供问题排查；
- 同一个正在执行的 Experiment 默认由当前安装版本完成；
- 升级后新增或恢复运行时，可以在报告中提示实现版本不同，但不自动把它升级为新的 fidelity 维度。

这里的目标是可解释，而不是冻结项目演进。只有真实问题证明 Host 版本差异显著影响结果时，才增加更严格的约束。

## 4. Controller 工具集合

Controller 工具的目的只有一个：读取一个真实用户为了继续协作而合理能够看到的证据。工具必须只读、受 ownership 限制，并且不能绕过 Target Runtime 执行任务。

第一版推荐保留三个能力，而不是提供 shell 或通用文件系统：

1. 读取完整原始会话的指定消息范围；
2. 读取当前 Case/Run 拥有的 artifact 内容或片段；
3. 获取 Harness 已生成的确定性 artifact 预览和 metadata。

这些能力可以由一个小型 `ControllerEvidenceReader` 端口承载，再由 Pi Host 暴露成适合模型调用的工具；不需要为每种任务建立工具插件系统。

```ts
interface ControllerEvidenceReader {
  readTranscript(request: TranscriptReadRequest): Promise<TranscriptSlice>;
  readArtifact(request: ArtifactReadRequest): Promise<ArtifactSlice>;
  inspectArtifact(ref: ArtifactRef): Promise<ArtifactMetadata>;
}
```

工具边界：

- 不能写文件、执行命令、调用 Target 工具或直接修改环境；
- 不能读取 Case/Run 所有权之外的路径；
- 路径、artifact ID、读取范围、类型和大小在 Host 边界验证；
- 未支持的二进制内容返回 metadata 或 unavailable，不让模型猜测；
- 确定性 renderer 可以生成派生预览，但预览必须成为带 provenance 的新 artifact；
- 工具能力配置在同一 Experiment 的候选间一致，实际调用次数不要求一致。

当前环境和候选轨迹的轻量观察直接进入 `SteeringContext`。工具用于按需展开长内容，不应该让 Controller 自己在整个工作区里漫游。

## 5. 原始会话可见范围

Controller 对原始会话采用“完整可访问”，而不是“每轮把所有 token 永久塞进 prompt”。这一区分解决超长会话与模型上下文窗口的现实限制。

完整可访问意味着：

- 完整 transcript 是不可变事实源；
- 从 `initialInput` 到会话结束的全部原始消息和事件都可以读取；
- 不隐藏原始会话中的未来用户输入或原 Agent 结果；
- 摘要不能替代 transcript，也不能成为唯一仍可访问的历史；
- 每次读取保留消息 ID、顺序和 provenance；
- privacy policy 可以在发送给外部 provider 前脱敏，但脱敏事实必须可见。

默认上下文组装为：

```text
`initialInput`、目标和硬约束
+ 完整原始会话（可直接注入或按范围读取）
+ BaselineEvidence
+ 当前候选规范化轨迹
+ 当前环境和 artifact 观察
+ Controller 先前已发送的消息
+ 剩余预算和权限边界
→ SteeringContext
```

会话能够放入上下文时可以直接提供完整内容；超过窗口时，Host 提供稳定的 transcript 索引和按消息范围读取能力。无论采用哪种装配方式，Controller 都拥有访问完整会话的能力。

不同 CandidateRun 各自从同一个不可变 transcript 开始，不能看到其他候选轨迹或 Comparison 结果。

## 6. Controller 预算

Controller、Recovery 和 Comparison 的**资源预算默认均不设上限**。这不等同于取消安全和活性边界：每次调用仍有超时，结构化输出修复和 provider 重试仍有很小的固定次数上限；这些限制用于避免单次请求悬挂或无限重试，不是 Agent 的总调用、token 或成本预算。用户需要控制成本时，可以为单个 Agent 显式配置上限。

```ts
interface AgentBudget {
  maxCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  callTimeoutMs: number;
  maxStructuredRepairAttempts: number;
  maxProviderRetries: number;
}
```

- `maxCalls`、`maxTokens` 和 `maxCost` 默认未设置，即 Controller 资源预算无限制；
- `maxStructuredRepairAttempts` 限制 schema 修复调用，`maxProviderRetries` 限制瞬时 provider 错误重试；两者第一版都保持很小且分别计数；
- `callTimeoutMs` 防止一次 Controller 调用无限等待；
- CandidateRun 的 `RunPolicy` 仍独立约束 Target Runtime 的墙钟、turn 和模型调用；它不是 Controller 的资源预算；
- RunOrchestrator 执行 CandidateRun 限制；Controller 只能看到对应的运行快照并据此判断是否继续。

所有候选使用相同的显式 Agent 预算配置（默认均为无限制），但实际消费分别记录。Controller token、成本和耗时必须与 Target 指标分开，同时可以提供端到端总量。若用户配置了 Agent 预算，上限耗尽是独立终止原因，不能伪装成 `done` 或任务完成。

不需要为默认无限制预算校准具体数字；仅在提供显式限制时，才根据真实运行校准相应阈值。

## 7. 上下文压缩设置

第一版直接复用 Pi 的上下文管理和压缩能力，不重新实现 summarizer、记忆系统或通用 context engine。用户通常不需要配置；高级配置可以透传 Pi 已支持的选项。

同一 Experiment 固定的是压缩策略，而不是压缩结果：

- 每个候选拥有独立 Controller session；
- 因轨迹不同，压缩触发时刻和摘要内容可以不同；
- system prompt、任务目标、安全边界、当前 turn 和 Controller 已发送消息具有更高保留优先级；
- 较早的候选轨迹可以压缩，但 trace 与 artifact 引用必须保留；
- 原始 transcript 不被压缩产物替代，始终可通过只读工具重新读取；
- 压缩事件、输入范围和生成的摘要作为 Controller trace 记录。

推荐默认模式为 Pi 的自动上下文管理。关闭压缩或调整阈值属于实验级配置；第一版不暴露自定义压缩 prompt、分层记忆或按 Agent 产品定制的压缩逻辑。

## 8. 操作化表述

产品可以继续使用“同等人类能力”这一简洁名称，但架构和报告中的准确表述应是：

> Harness 使用用户选择且在 Experiment 内保持一致的 Controller 配置。Controller 基于完整原始会话、同一任务事实、当前候选轨迹和只读结果证据，模拟具有原用户目标、知识、偏好、权限和实际协作能力的用户，动态生成下一条输入。

这是一种可记录、可解释的操作化条件，不是对真实用户反应的证明。报告应显示 Controller 的请求模型、解析后身份、配置 hash、工具能力、预算配置（默认无限制）和压缩策略，使用户知道比较是在什么协作条件下产生的；不需要给 Controller 的“等同性”打分。

## 9. 后续可继续讨论

Controller 配置归属已经确认。其余几个实现细节可以继续讨论：

1. transcript 超出窗口时，是只提供按消息范围读取，还是同时提供确定性索引；本文倾向两者都提供，但不增加语义搜索或向量数据库。
2. `AgentBudget` 的显式阈值如何呈现给用户，需要在真实任务中验证；默认不设置总调用、token 或成本上限。
3. 第一版 artifact 预览支持哪些格式，应与 Comparison 的最小 artifact 集合保持一致。
