# Recovery Agent 真实 Runtime 5+5 结果审查与克制优化方案

> 审查日期：2026-08-21  
> 审查对象：当前工作区 Recovery Agent 实现、真实 Runtime 5+5 rerun、逐 case terminal / mechanical audit / recovery validation / lifecycle events，以及现有 deterministic 测试。  
> 样本目录：`C:\Users\15893\Documents\model-test\Reprise\.reprise\recovery-sample-20260821-5plus5-rerun`

## 1. 结论先行

当前 Recovery Agent **已经能够可靠完成“安全调查、隔离候选生成、机械审计、终态持久化和批次断点续跑”**，但**还不能宣称完成“语义上恢复用户真正想要的内容”**。

这是一个重要但不悲观的结论：本轮结果证明了恢复系统的外壳和安全边界基本工作，尚未证明恢复内核的正确性。

### 当前已经被真实 Runtime 5+5 证明的能力

- 10/10 staging 成功；
- 10/10 forensics 完成；
- evidence source coverage 为 40/40；
- 10/10 source unchanged；
- 10 个 terminal artifact 均成功落盘；
- 完整批次未中断；
- 平均模型调用 1.1 次/case，说明多数 case 一次调查即可形成候选或明确结论；
- 10/10 resume 安全跳过已有 terminal case，且没有新增模型调用；
- 4 个 Codex case 因 `no_task_path_outcome` 被拒绝，属于正确的证据不足拒绝，不应通过放宽 verifier 强行提高成功率。

### 当前没有被证明的能力

- `verified` 为 0；
- candidate replay pass 未观测；
- truth recovery 未观测；
- user acceptance 未观测；
- 8 个 case 仍为 `pending_user_review`；
- 2 个 Claude case 的 terminal failure 为 `runner_crashed`，尽管 Agent 已返回候选；
- 当前样本没有建立“候选内容与真实期望状态相等或满足语义 invariant”的闭环。

因此，当前模块的准确定位应是：

> **一个 Agent 主导、Host 隔离、Verifier 兜底的恢复候选生成与审计系统；尚未是自动接受恢复结果的系统。**

## 2. 先定义预期：Recovery 到底要完成什么

从第一性原理看，Recovery 不是“让模型说它恢复了”，也不是“生成一个看起来合理的目录”。它要解决的是：

```text
已损坏/缺失的工作状态 + 可追溯历史证据
    -> Agent 调查事实并形成假设
    -> 在隔离副本中提出一个或多个候选
    -> 工具和机械验证提供反馈
    -> Agent 根据反馈修正、比较或停止
    -> 人或明确授权策略接受候选
```

这里有三个不可混淆的层次：

1. **调查完成**：Agent 看到了相关证据，形成了可解释的假设，并说明了不确定性；
2. **候选可审计**：候选操作符合协议、工具和路径边界，可以在隔离环境中查看和继续处理；
3. **用户认为有用**：Agent 给出的恢复结果、解释和遗留问题足以支持用户决定是否采用。

第三层通常没有统一、便宜且可靠的自动指标。它依赖任务语义、证据质量和用户判断，不能被一个 `truth recovery rate` 或 exact tree match 取代。本轮 5+5 已较好证明前两层，但没有产生足够的第三层人工或产品证据。`stagingSucceeded`、`forensicsCompleted`、`candidateCreated` 和 `sourceAudit=passed` 只能证明过程安全，不能代替 Agent 的语义判断或用户接受。

## 3. 对真实结果的逐项解释

### 3.1 10/10 staging、forensics、source unchanged：外壳可靠

这些指标是本轮最有价值的正面证据。它们说明：

- source 与 recovery staging 的隔离路径可用；
- Agent 能得到至少四类 evidence source；
- forensics 工具链没有在真实 Runtime 下普遍崩溃；
- Agent 的写操作没有直接污染源目录；
- terminal 结果和 resume 所依赖的持久化文件能够产生。

但这些指标的性质是**必要条件**，不是充分条件。一个完全错误的候选也可以在 staging 中生成、审计通过并安全落盘。

### 3.2 平均 1.1 次模型调用：效率好，但不能单独解释为能力强

1.1 次/case 有两种可能：

- Agent 迅速获得了足够证据，合理地停止；
- Agent 很快生成了未经充分验证的候选，Host 随后把它标记为 partial / pending / failed。

从当前结果看，两种情况都存在。尤其是 Claude case 中有候选路径和 partial 说明，但仍进入 `runner_crashed`；Codex case 中有候选生成但因 task-path outcome 不足被 verifier 拒绝。因此，模型调用次数只能作为成本和流程观测，不能作为质量指标，更不能驱动“必须少调用”或“必须多调用”的硬策略。

Agent 的正确目标应保持为：

```text
observe -> hypothesize -> investigate -> propose -> verify -> revise/stop
```

如果证据不足，合理的结果是停下来请求复核或报告不可证明，而不是为了提高成功率继续猜测。

### 3.3 4 个 Codex `no_task_path_outcome`：正确拒绝，不要放宽

这 4 个 case 没有足够的可验证任务路径结果。当前 verifier 拒绝它们，是在拒绝一个无法证明的候选，而不是在拒绝一个已经证明错误的候选。

这一区分很重要：

- `no_task_path_outcome` = 证据不足，不能安全宣称恢复；
- `candidate_replay_failed` = 候选实际不能通过重放；
- `invariant_failed` = 候选违反明确目标约束；
- `runner_crashed` = 编排或 Provider 路径异常；
- `pending_user_review` = 候选已有价值，但系统没有获得自动接受授权或真值证明。

建议保留拒绝。不要把 `no_task_path_outcome` 转换成 warning，也不要因为 `verified=0` 而降低 verifier 门槛。否则系统会从“保守但可信”退化成“成功率看起来更高但结果不可托付”。

### 3.4 8 个 `pending_user_review`：不能简单理解为 Agent 失败

`pending_user_review` 在当前设计中同时承载了几种不同情形：

- 候选确实有内容，但缺少自动真值；
- 候选为 partial，存在未解决状态；
- Provider validation / runner 路径没有完成；
- 没有用户接受记录；
- 候选安全但语义上只能交给人判断。

把这些情况全部压成一个状态，会损失最重要的诊断信息。这里不建议增加复杂状态机，而建议做一个最小修正：

- 保留现有生命周期状态；
- 在 terminal/evaluation 中明确一个稳定的 `reviewReason` 或现有 failure/rejection reason 的规范值；
- 只区分“需要人工判断的语义问题”和“系统执行失败”两大类即可。

换言之，`pending_user_review` 是对外决策状态，不能同时承担内部故障分类。

### 3.5 Claude-01/02 `runner_crashed`：本轮最值得修的真实缺口

逐 case 产物显示：

- Agent invocation 已返回 `status=completed`；
- 已生成 recovery report / manifest；
- 已有候选路径、hypothesis 和 candidate artifact；
- 但 `recovery-validation.json` 为 failed，terminal 被归类为 `runner_crashed`。

这说明“Agent 产出了结果”和“Host 完成了恢复验证”之间存在断裂。当前外部观察结果把它们混成了一个失败终态，导致：

1. 用户无法判断是候选错误、证据不足，还是验证器/Provider 崩溃；
2. 评估无法知道 Agent 的语义产出是否值得人工复核；
3. 真实运行中可能出现“有候选但被系统故障覆盖”的信息损失。

克制的修正不是增加更多 recovery 状态，而是确保已有信息不丢失：

- Agent 返回成功后，先持久化 `agentResult` 和候选摘要；
- Provider validation 失败时，terminal 应记录明确的 `validation_failed`/现有对应 failure code，而不是泛化为 `runner_crashed`；
- 如果确实是进程异常，才使用 `runner_crashed`；
- 失败终态仍可以是 failed，但 `evaluationRow` 必须保留 Agent 的候选、hypothesis、recoveredPaths、attempts 和 validation failure reason。

应增加反向测试：模拟 Agent completed + validation failed，断言不会丢失候选信息，也不会被错误归类为普通 runner crash。

## 4. 当前 Recovery Agent 是否能满足预期需求

### 可以满足的部分

如果预期是：

- 不修改用户 source；
- 读取历史会话并提取可用事实；
- 让 Agent 自主调查和提出候选；
- 允许多个候选存在；
- 将操作在隔离 staging 中物化；
- 给出 diff、report、manifest 和审计信息；
- 在批次中断后安全续跑；
- 对证据不足的 case 保守拒绝；

那么当前实现已经基本达到预期，且本轮真实 5+5 提供了较强证据。

### 还不能满足的部分

如果预期是自动判断所有历史恢复是否“正确”、自动选择并写回最佳候选，当前实现不应承诺这一点。不是因为 Agent 不够强，而是这类判断依赖具体任务语义、证据完整性和用户意图，无法由一个通用硬指标可靠替代。

当前合理目标是：让 Agent 在证据范围内自主调查、提出候选、解释把握与遗留问题；系统保证过程安全、结果可追溯，并把最终采用权交给用户或明确授权策略。

## 5. 最小必要架构调整

### P0：保持 `candidateCreated`、`review` 与安全终态的语义边界

当前最必要的不是增加一个自动判定“恢复正确”的框架，而是保证已有结果不被错误解释：

```text
candidateCreated != verified != accepted
```

在现有 schema 上保持字段独立即可：

- `candidateCreated`：Agent 形成了结构化候选，并已在隔离环境中物化；
- `verified`：仅表示已有机械检查或明确的协议检查通过，不代表系统理解了用户意图；
- `accepted`：用户或明确授权策略决定采用候选。

对于真实历史 session，若没有可复核的任务终点，就不要为了填充 `verified` 而猜测 truth contract。将其如实呈现为 `pending_user_review` 或 `insufficient_evidence`，同时保留 Agent 的候选、证据引用、假设、解释和 unresolved 项。

### P0：修复结果保留和终态分类，不扩张状态机

Agent 已完成但 Provider validation 失败时，应保留 Agent 产出，并记录具体的 validation failure；只有进程或编排确实异常时才使用 `runner_crashed`。这比增加更多状态更重要，也更容易落地。

建议继续使用现有 `verification` 与 terminal failure code，并建立清晰优先级：

```text
候选已生成且可供人判断 -> completed + pending_user_review
证据不足             -> completed + insufficient_evidence
候选越过硬边界       -> failed + verifier_rejected
Agent/Provider 执行异常 -> failed + 对应 failure code
```

必要时只增加一个稳定的 `reviewReason` 或复用现有 rejection/failure reason，用于解释为什么交给人判断；不要为每一种语义差异创建新的 lifecycle state。

### P1：把 replay 和 deterministic fixture 定位为辅助能力

如果候选操作本身需要机械确认，可以在 fresh staging 中做一次最小 replay，检查操作协议、路径边界、幂等性和明显的文件系统结果。它的作用是给 Agent 反馈、发现工具错误和保护 source，不是替代 Agent 判断，也不是所有 Recovery case 的自动成功门槛。

同理，deterministic fixture 适合验证工具、候选协议和已知 invariant；不应被误解为真实历史 session 的通用真值。没有可靠真值的 case 不强行纳入成功率统计。

不需要设计复杂 candidate graph、自动多轮搜索、统一评分器或后台调度器。Agent 是否继续调查、比较候选或停止，应由证据和任务语义决定。

### P1：保留 Agent 自主调查，Host 只提供能力和反馈

不要把 Recovery 改造成固定 playbook：

- 不规定唯一调查顺序；
- 不规定必须提出几个 hypothesis；
- 不把模型 confidence 当成证据；
- 不把 average model calls 当成成功门槛；
- 不把 candidate count 当成质量门槛。

Host 需要做的是：

- 给 Agent 可追溯 evidence；
- 约束工具、路径、artifact 和预算；
- 在每次候选重放后返回机械反馈；
- 对越界、证据伪造、source 写入和 schema 错误做硬拒绝。

### P1：修正终态分类，不增加冗余状态

建议继续使用现有 `verification` 与 terminal failure code，但建立清晰优先级：

```text
机械检查通过     -> completed + verified
证据不足       -> completed + insufficient_evidence
等待人判断     -> completed + pending_user_review
候选被机械拒绝 -> failed + verifier_rejected
执行链异常     -> failed + runner/provider/evaluation failure
```

关键是让 `runner_crashed` 只表示真正的运行崩溃，不要覆盖 Provider validation failure 或 Agent 已完成但结果未被验证的情况。

## 6. 测试是否足够：结论是“不够”，但不是要无限加测试

当前测试已覆盖较好的基础可靠性：

- schema-invalid draft 分类；
- terminal persistence failure 阻止 aggregate；
- source tripwire；
- lifecycle 单 case 和跨 case 反向校验；
- candidate digest 的 baseline 隔离；
- truth fixture 的 write/rename/delete/binary/large repo/symlink/conflicting evidence；
- resume 不重复模型调用。

但真实 5+5 暴露出三个关键测试空洞：

### 6.1 Agent 已完成、验证失败的信息保留

测试步骤：

1. fake Agent 返回 completed；
2. fake Provider validation 返回 failed；
3. 断言 terminal failure code 是具体 validation failure，而非 `runner_crashed`；
4. 断言 report、manifest、candidate summary、hypotheses 和 recovered paths 仍可追溯；
5. 断言 aggregate 不把它计为 verified。

这是本轮最应优先补的回归测试。

### 6.2 候选协议与 Agent 反馈

测试重点不是构造一个自动判断所有恢复正确性的 truth engine，而是验证候选不会突破安全边界，并且机械反馈能回到 Agent：

| Fixture | 目标 |
|---|---|
| exact file restore | 检查结构化写入、路径边界和内容摘要 |
| rename restore | 检查 rename 操作和旧路径处理 |
| delete/cleanup | 检查删除能力边界及允许的残留 |
| conflicting evidence | 检查 Agent 能看到冲突，而不是被 Host 强行归一化 |

对有明确预期的 deterministic fixture，可以额外检查 invariant；对真实历史 session，不要求伪造统一真值。测试输出应包含候选 recipe、机械反馈、Agent 的后续决定和最终 review 信息。

### 6.3 `pending_user_review` 与 `runner_crashed` 的边界

至少覆盖：

- candidate valid but no truth -> `pending_user_review` 或 `insufficient_evidence`；
- candidate mechanically invalid -> `verifier_rejected`；
- Agent completed + validation failed -> validation failure；
- Agent process crashed before output -> `runner_crashed`；
- source changed -> source tripwire failure；
- terminal write failed -> no aggregate。

这组测试能防止业务状态和基础设施错误再次混淆。

## 7. 真实 Runtime 测试如何继续设计

不要直接把 5+5 扩大成 50+50。先建立分层证据：

### 层 A：确定性协议测试

每次代码改动必须运行现有 `npm run check`。新增的每个门禁都必须附一个能使门禁失败的反向用例。

### 层 B：deterministic Agent/tool loop

使用少量有明确预期的小样本，验证：

- Agent 能读到证据并暴露冲突；
- 候选可物化且不越过 source/capability 边界；
- 必要时可以在 fresh staging replay，并把机械反馈交回 Agent；
- source 不变；
- terminal 与 event log 一致。

有明确 invariant 的 fixture 可以检查 invariant，但它是工具和协议回归证据，不是对真实历史 session 的通用成功判定。

### 层 C：真实 Runtime smoke

5+5 已足以验证 Provider 接入、真实时延、不同 Runtime 的事件/工具兼容性。后续每次只需要小规模 rerun：

- 代码/协议改变：每个 Provider 1 个 representative case；
- Agent prompt 或工具改变：每个 Provider 2 个 case；
- 发布前：再跑完整 5+5；
- 真实 Runtime 必须继续显式 opt-in。

### 层 D：人工复核样本

从 8 个 `pending_user_review` 中抽取有代表性的 2–3 个，而不是全部人工阅读：

- 一个候选内容丰富但证据弱；
- 一个 partial 且有 unresolved；
- 一个 Provider validation failure；
- 一个 Codex `no_task_path_outcome`。

记录人工判断：候选是否有用、缺什么证据、是 Agent 问题还是 Host/Verifier 问题。这些结果可作为下一轮 truth fixture 设计依据。

## 8. 指标设计：硬性指标只做兜底

当前 metrics 文件中很多 ratio 的 denominator 为 0，例如：

- candidate replay pass rate；
- truth recovery rate；
- user acceptance rate。

这不是 0% 成功，而是**没有观测到该指标**。报告层必须继续区分：

```text
observed: numerator / denominator
unobserved: denominator = 0
```

建议保留当前指标，但在展示和文档中明确三种状态：

- `pass`：有分母且满足条件；
- `fail`：有分母且未满足；
- `unobserved`：分母为 0。

指标只用于：

- 发现回归；
- 比较不同 Runtime / prompt / tool 版本；
- 指示需要人工复核的样本；
- 评估成本、时延和覆盖。

指标不应用于：

- 迫使 Agent 产生更多候选；
- 迫使 Agent 少调用模型；
- 把 pending 强行转成 verified；
- 用 success rate 代替语义判断。

真正的 Agent 质量应看其是否能：

- 找到相关证据；
- 暴露冲突和不确定性；
- 形成可检验假设；
- 根据 verifier feedback 修正；
- 在无法证明时主动停止。

## 9. 性能和时延：先解释，再优化

本轮：

- 平均 wall-clock：100844.2 ms；
- P50：67071 ms；
- P95：200734 ms；
- 平均 model request：92040.8 ms；
- 平均 forensics：146 ms；
- 平均 candidate materialization：2525.5 ms。

结论很明确：主要成本来自模型请求，而不是 forensics。当前不应先优化文件扫描或引入复杂并行调度。优先做两件事：

1. 保持 case 级隔离和可续跑；
2. 记录并比较 model request 的实际耗时、超时、重试和输出大小。

只有在确认模型请求中存在可避免的重复证据、过长输入或无效重试后，才优化 prompt/evidence packing。不要用“必须一次完成”限制 Agent 调查深度。

## 10. 安全与边界：保持当前克制方向

当前 source unchanged 10/10 是好结果，但它不等于完整 sandbox。尤其 Windows shell 仍应理解为显式 capability，而不是 OS 级隔离。

保持以下最小边界：

- structured read 默认允许但按 capability 限制范围；
- staging write 默认允许，source write 默认拒绝；
- 通用 shell 默认关闭；
- 网络默认关闭，`networkAccess` 只在实际有阻断能力时宣称；
- artifact 和 report 不写入凭据、完整 session secret 或未脱敏路径；
- 证据文件、候选 recipe、验证结果必须经过 schema 校验；
- cleanup 先复用已有幂等 primitive，暂不引入复杂 scheduler。

不要继续堆叠越来越长的 lexical deny list 来假装解决 shell 安全。长期方向是减少通用 shell，增加少量结构化工具；但在没有真实需求前，不要一次性重做工具面。

## 11. 推荐实施顺序

### 第一步：修复真实结果暴露的分类/信息丢失

- 区分 Agent completed 与 validation failed；
- 保留 Agent candidate/report/manifest 摘要；
- 只在真正进程异常时使用 `runner_crashed`；
- 增加上述反向测试。

### 第二步：建立一个最小 deterministic replay 闭环

- 选 2–4 个小 fixture；
- 为每个 fixture 定义 invariant；
- 一次 fresh staging replay；
- 结果写回现有 evaluation row；
- 不增加复杂 candidate graph。

### 第三步：人工复核 2–3 个真实 pending case

目的不是给 5+5 伪造成功率，而是判断：

- 候选是否有实际价值；
- Agent 缺的是证据、工具、提示，还是验证路径；
- 哪些 unresolved 是工具能力缺口（例如只能删文件不能删空目录）。

### 第四步：重新运行小规模真实 smoke，再运行完整 5+5

重新生成样本时写入：

- run id；
- source session hash；
- code/schema/prompt/tool version；
- 是否 resume；
- 每 case terminal 与 lifecycle digest。

这样才能把新旧结果真正比较起来。

## 12. 验收矩阵

| 能力 | 当前证据 | 判断 | 下一步 |
|---|---|---|---|
| source 隔离 | 10/10 unchanged | 已达到基础要求 | 保持反向测试 |
| staging | 10/10 | 已达到基础要求 | 无需扩张 |
| forensics | 10/10 | 已达到基础要求 | 关注证据质量 |
| candidate generation | 10/10 | 已证明能产出候选 | 不等于正确 |
| candidate replay | 0/0 | 未观测 | 仅在需要时补最小 replay |
| semantic judgment | 未形成可统计证据 | 不能自动量化 | 保留 Agent 解释并支持人工复核 |
| user acceptance | 0/0 | 未观测 | 人工复核记录 |
| lifecycle integrity | 本地反向测试 + 本批完整结束 | 基本可信 | 保持跨 case gate |
| resume | 10/10，无新增模型调用 | 已达到 | 加 crash injection |
| provider resilience | Claude 2 个 runner/validation failure | 有问题 | 分类和错误保留 |
| performance | P95 200.7s | 可接受但需解释 | 先观测，不急于并行化 |
| shell boundary | capability gate | 基本合理 | 不宣称 OS sandbox |

## 13. 最终建议

当前不建议重写 Recovery 架构，也不建议增加更多角色、复杂候选图、自动搜索策略或硬性成功阈值。最小且有价值的优化只有三类：

1. **让失败可解释且不丢 Agent 产出**；
2. **在确有必要时补最小的候选 replay，用于工具反馈和边界保护**；
3. **用少量 deterministic fixture 验证协议和工具，不把它们扩张成恢复真值系统**。

在第一项完成前，继续扩大真实 Runtime 样本的收益有限。第一项完成后，再通过少量人工复核判断 Agent 产出是否有实际价值；不追求用一个成功率把这种判断自动化。

最终应保持这样的权责边界：

- Agent 负责观察、假设、调查、比较、解释不确定性和决定停止；
- Host 负责证据、工具、隔离、预算、持久化和反馈；
- Verifier 负责硬边界、协议一致性和必要的机械检查，不替代 Agent 的语义判断；
- 人或明确授权策略负责在候选、证据和遗留问题之间做最终接受决定。

这能同时满足两点：**硬性规则只防止不可接受的越界和伪造，Agent 负责真正的调查与判断；系统又不会因为模型自信或候选存在而错误写回用户 source。**

## 14. 本轮验证与限制

本次分析使用了：

本轮实现补充：Agent 已完成且已创建候选时，Provider validation failure 保留为 `provider_validation_failed`，并在 `recovery-validation.json` 写入稳定的 `validationFailureReason`；不放宽 `no_task_path_outcome`，不新增 lifecycle state。

- `evaluation-metrics.json`；
- `summary.json`；
- 10 个 case 的 `case.terminal.json`、`mechanical-audit.json`、`source-audit.json`；
- 代表性 `recovery.json`、`recovery-validation.json` 与 `events.jsonl`；
- 当前 Recovery 评估、编排、验证和真实 runner 代码；
- 已有 deterministic 与生命周期反向测试。

本轮只新增本文档，没有修改源码，也没有提交或 push。文档验证应运行：

```powershell
npm run verify:docs
```

源码修复后的验证：`npm run build`、`node --test dist/test/codex-experiment.test.js`。本轮未运行新的真实 5+5；旧的 5+5 rerun 结果仅作为修复前基线。

未完成事项：

- 尚未对 8 个 pending case 做人工语义复核；
- 尚未观测 candidate replay；
- 尚未形成足以支持产品结论的人工复核记录；
- 已修正 Agent completed + Provider validation failure 被归类为 `runner_crashed` 的信息丢失问题，并增加了 completed-candidate 分类反向测试；旧样本本身不重新解释为修复后的真实 Runtime 结果；
- 不能据此把 Recovery 的语义价值压缩成一个真实恢复率。
