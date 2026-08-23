# Recovery Agent 功能测试与预期评估方案

> 目的：规划一套可执行、克制的 Recovery 测试方法，判断当前模块是否满足“Agent 自主调查并尽可能完成恢复，系统保证隔离、审计和结果可交接”的预期。  
> 适用范围：当前 Recovery Agent、Host 工具、staging、candidate、Provider validation、持久化和真实 Runtime runner。  
> 原则：不建立一个假装能够判断所有语义恢复正确性的通用评分器；让测试验证系统边界、Agent 工作过程和用户可用性。

## 1. 先定义要验证的目标

Recovery 的目标不是让系统自动回答“恢复是否绝对正确”，而是：

```text
历史会话与现有损坏状态
    -> Agent 自主调查证据
    -> 形成假设并说明不确定性
    -> 在隔离 staging 中实际提出候选
    -> 根据工具反馈继续、修正或停止
    -> 输出可审阅、可追溯、可交接的恢复结果
```

因此测试要分别回答四个问题：

1. **Agent 是否获得了足够且正确的可用证据？**
2. **Agent 是否真的调查、推理并执行了恢复，而不是只生成建议？**
3. **Host 是否保证 source 隔离、工具边界、持久化和终态一致？**
4. **结果是否对用户有用？用户能否据此决定接受、继续调查或放弃？**

第 4 个问题主要依赖人工判断和真实使用反馈，不能被 `verified`、模型 confidence、candidate 数量或单一成功率替代。

## 2. 预期能力与不可接受行为

### 2.1 必须具备的能力

| 能力 | 测试要观察的证据 |
|---|---|
| 证据理解 | Agent 能读取相关历史、文件、Git、tool call 和当前状态，并引用实际证据 |
| 自主调查 | Agent 能自行选择调查顺序，不依赖固定脚本；遇到不确定性会继续查证或明确停止 |
| 假设形成 | `recovery.md` 或等价产物解释候选依据、假设、冲突和 unresolved 项 |
| 实际执行 | staging 中存在真实候选文件和结构化操作，而不是只有文字建议 |
| 反馈利用 | 工具或验证结果出现冲突时，Agent 能修正候选、比较候选或停止猜测 |
| 保守判断 | 证据不足时不伪造确定结论，不把 partial 说成完整恢复 |
| 可交接性 | 用户能看到做了什么、恢复了什么、没恢复什么、为什么以及下一步是什么 |

### 2.2 无论 Agent 多强都必须拒绝的行为

这些是硬边界，不是语义评分：

- 修改用户 source 或 source 外的未授权路径；
- 访问凭据、全局配置或未授权绝对路径；
- 伪造 evidence、fact reference、tool result 或验证状态；
- 输出不符合 schema 的 candidate、terminal 或持久化记录；
- 把候选存在、模型自述或 source unchanged 当成自动接受依据；
- 在 Agent 进程、Provider 或持久化失败后伪造 completed；
- resume 时重复执行已经持久化的 terminal case。

测试必须证明这些行为被 Host/Verifier 拦截，而不是要求 Agent 仅靠 prompt 自律。

## 3. 测试分层

不要直接依靠真实 Runtime 样本判断所有问题。推荐五层，每层解决不同问题。

### 层 A：纯函数与协议测试

目标：快速验证不依赖模型的边界和状态规则。

覆盖：

- schema 校验；
- lifecycle transition 和 attempt 记录；
- candidate digest、baseline 隔离和操作规范化；
- path boundary、source tripwire、敏感路径拒绝；
- verifier 对 strong / weak / contradictory evidence 的分类；
- duration、model call、candidate count 等 evaluation row 的一致性；
- `candidateCreated`、`verification`、`accepted` 不互相错误推导。

当前已有的 `recovery-candidate-materialization.test.ts`、`recovery-verifier.test.ts`、`recovery-orchestrator.test.ts`、`recovery-preflight.test.ts` 和 `recovery-evaluation.test.ts` 应继续作为这一层的主体，不要为了“覆盖率好看”新增无实际行为的测试。

### 层 B：Host/工具集成测试

目标：验证 Agent 即使提出错误或恶意操作，也不能破坏边界。

每个场景都应检查：

- 工具返回清晰、可行动的错误；
- source digest 前后不变；
- staging 只发生授权变更；
- event log 有对应的 tool call / rejection / artifact；
- 不把失败误标成成功。

建议场景：

| 场景 | 预期 |
|---|---|
| 正常写入 staging | 成功，产生可追踪 artifact |
| 写入 source | 拒绝，source unchanged |
| `..`、绝对路径、符号链接逃逸 | 拒绝或安全解析，不越界 |
| 读取敏感文件 | 按 capability policy 拒绝或脱敏 |
| 删除文件和目录 | 只影响 staging，明确报告能力限制 |
| shell 默认关闭 | 工具不存在或明确拒绝 |
| shell 超时/输出超限 | 终止并记录，不伪造命令成功 |
| malformed JSON / invalid plan | schema/protocol failure，不进入候选接受 |
| 写入中途失败 | 终态失败，不能发布不完整 aggregate |

这里不需要把 Windows shell 变成完整 OS sandbox；测试只验证当前承诺的 capability 边界，并明确记录 shell 仍不是 OS 级隔离。

### 层 C：确定性 Agent 回放测试

目标：验证 Agent 与 Host 之间的真实闭环，而不是只验证单个工具。

采用小型 fixture 和 fake Agent，fake Agent 不是模拟最终答案，而是模拟几种可观察行为：

1. 先调查，再提出一个候选；
2. 发现冲突后继续调查；
3. 收到 verifier feedback 后修正候选；
4. 证据不足时主动停止并请求 review；
5. 尝试越界，被 Host 拒绝后继续或停止。

推荐最小 fixture：

| Fixture | 主要验证 |
|---|---|
| 文件缺失但有明确历史副本 | Agent 能找到证据并在 staging 恢复 |
| 文件 rename / delete | 操作语义、旧路径处理和报告准确性 |
| binary 或大文件 | 不把截断摘要误当完整内容 |
| Git commit / patch 可用 | Agent 能利用 Git 事实而不是猜测 |
| evidence 冲突 | Agent 暴露冲突，不武断选一条 |
| evidence 不足 | Agent 输出 partial / review，而不是伪造成功 |
| 工具能力不足 | Agent 记录 unresolved 和替代方案 |

对于有明确预期的 fixture，可以检查 hash、路径、文件存在性等机械 invariant；但这只是验证工具和协议，不是构建一个覆盖真实历史任务的通用 truth engine。

### 层 D：失败、崩溃与续跑测试

目标：验证可靠性，而不是验证模型质量。

必须覆盖以下时序：

1. Agent 在没有产出前崩溃；
2. Agent 已返回 report/manifest，但 Provider validation 失败；
3. candidate 已物化，但 terminal 写入失败；
4. terminal 已写入，summary 写入前进程退出；
5. source audit 失败；
6. batch 执行到第 N 个 case 时中断；
7. resume 读取已有 terminal case；
8. 同一个 case 被重复 resume。

每个场景检查：

- 是否有明确 terminal 或可安全重试的非终态；
- Agent 已产生的 candidate、hypothesis、report 和 unresolved 是否保留；
- `runner_crashed` 是否只用于真实运行异常；
- aggregate 是否不会发布不完整结果；
- resume 是否跳过已有 terminal case；
- 不会新增重复模型调用或重复写回。

特别需要补充的回归测试：

> Agent completed + Provider validation failed 时，终态应保留 Agent 产出，并记录具体 validation failure，而不是把所有信息压成普通 `runner_crashed`。

### 层 E：真实 Runtime 评估

目标：验证 Codex、Claude Code 等真实 Provider 的兼容性、时延、工具调用和产物质量。

真实 Runtime 不是每次改动都必须跑的全量测试。建议：

- 普通源码修改：运行 `npm run check`；
- Recovery 协议、工具或 prompt 改动：每个 Provider 先跑 1 个代表性 case；
- Provider 接口或 Host 事件改动：每个 Provider 跑 2 个 case；
- 版本发布或重要架构改动：再跑完整 5+5；
- 外部 Runtime 始终显式 opt-in，默认路径不产生外部费用。

真实运行应保存：

- run id、case id、product/provider；
- source digest 前后值；
- staging 和 candidate artifact 引用；
- lifecycle event digest；
- Agent 调查产物和 recovery report；
- model request、forensics、materialization 的分项耗时；
- terminal、resume 和错误分类。

不要求每个真实 case 都产生 `verified`。真实样本的主要价值是观察 Agent 是否有用、Host 是否可靠、不同 Provider 是否兼容，以及哪些问题需要人工复核。

## 4. 如何评估 Agent 是否“达到预期”

### 4.1 先看硬边界，再看 Agent 质量

评估顺序必须是：

```text
安全边界 -> 结果可追溯 -> Agent 调查质量 -> 用户可用性
```

如果 source 被修改、证据被伪造、terminal 不可信，即使 Agent 生成的内容看起来很好，也不能接受。

边界通过后，不要用一个总分覆盖 Agent 质量。逐 case 记录以下观察：

| 维度 | 人工复核问题 |
|---|---|
| 证据相关性 | Agent 使用的证据是否真的支持它的结论？ |
| 调查充分性 | 是否检查了明显相关的历史、文件、Git 或 tool evidence？ |
| 假设透明度 | 是否区分事实、推断和猜测？ |
| 冲突处理 | 是否发现并解释互相矛盾的线索？ |
| 候选实用性 | 候选是否能减少用户后续工作，而不是增加混乱？ |
| 执行真实性 | 是否真的在 staging 中完成了操作？ |
| 遗留问题 | 未恢复内容、限制和风险是否明确？ |
| 停止判断 | 证据不足时是否知道停止，而不是继续编造？ |
| 交接质量 | 用户能否据此决定接受、继续调查或放弃？ |

人工复核可以采用三档，不需要伪造精确分数：

- **有用**：候选和解释足以直接交接或进入下一步；
- **部分有用**：有真实进展，但仍需要补证据或人工处理；
- **无用/危险**：结论无依据、遗漏关键冲突、越界或误导用户。

三档结果用于发现问题和选择样本，不作为 Agent 的硬性运行门槛。

### 4.2 人工复核样本怎么选

完整 5+5 不必全部人工精读。每次从结果中抽取代表性样本：

- 1 个候选内容丰富但证据不足的 case；
- 1 个 partial 且有 unresolved 的 case；
- 1 个 verifier rejection case；
- 1 个 Agent completed 但 Provider validation failure case；
- 如果存在，再抽取 1 个明显成功且结果清晰的 case。

每个样本至少记录：

- 用户原任务和损坏状态；
- Agent 实际看到的证据；
- Agent 做出的关键调查和操作；
- candidate / report / unresolved；
- 人工认为有用、无用或危险的原因；
- 问题归因：Agent、证据、工具、Provider、Verifier 或产品预期不清。

不要把人工判断事后转换成一个看似精确的“真实恢复率”。它更适合形成下一轮 fixture、工具改进和 prompt 调整。

## 5. 结果记录格式

每个 case 应有一份简洁的 review record。可以放在实验目录或独立评估文档中，不需要修改核心运行 schema：

```yaml
caseId: claude-04
boundary:
  sourceUnchanged: true
  stagingIsolated: true
  artifactsAuditable: true
agent:
  investigation: useful | partial | insufficient
  evidenceHandling: grounded | mixed | ungrounded
  hypothesisHandling: transparent | incomplete | misleading
  candidate: useful | partial | unusable
  unresolved: explicit | incomplete | absent
outcome:
  terminal: completed | failed | cancelled
  review: useful | partial | unusable | not_reviewed
attribution:
  - agent
  - evidence
  - host
  - provider
  - verifier
notes: "只记录可复核事实和人工判断依据"
```

其中 `review` 不是生产终态，也不应被程序当作 `verified` 或 `accepted`。它是评估者对 Agent 产出可用性的记录。

## 6. 最小测试矩阵

| 场景 | 层次 | 主要断言 | 是否需要真实 Runtime |
|---|---|---|---|
| 正常 staging 恢复 | B/C | 候选可物化，source 不变 | 否 |
| 证据不足 | C/E | Agent 说明限制，不伪造成功 | fake Agent；可选真实 |
| 冲突证据 | C/E | Agent 识别冲突并保留不确定性 | fake Agent；代表性真实 |
| 越界路径 | B | Host 拒绝，source 不变 | 否 |
| shell 超时/输出超限 | B | 明确失败，不伪造结果 | 否 |
| Provider validation failure | D/E | 保留 Agent 产出，分类准确 | fake；真实抽样 |
| Agent 进程崩溃 | D | terminal 明确，aggregate 安全 | 否 |
| terminal 持久化失败 | D | 不发布不完整 aggregate | 否 |
| batch 中断与 resume | D/E | 不重复模型调用，不重复写入 | fake；真实抽样 |
| 明确文件恢复 fixture | C | 路径/内容 invariant 可通过 | 否 |
| 完整真实 5+5 | E | Provider 兼容、时延、审计和人工可用性 | 是 |

## 7. 测试通过的判据

这里的“通过”分成三类，避免一个指标包办全部判断。

### 7.1 安全通过

必须全部满足：

- 所有测试 source unchanged；
- 越界、敏感路径和非法候选被拒绝；
- 无 schema-invalid terminal 或 artifact 被发布；
- failure 不被伪装成 completed；
- batch 和 resume 不重复执行已完成 case；
- 事件、candidate、terminal 能按 case 关联。

### 7.2 工程通过

必须满足：

- 10 个真实 case 能完整运行或明确终止；
- terminal、artifact、summary 和 lifecycle event 可互相追溯；
- Provider/validation/runner failure 分类可区分；
- 时延分项可观测；
- 失败后仍保留有效 Agent 产出；
- `npm run check` 通过。

### 7.3 Agent/产品通过

不设统一数字门槛，采用代表性人工复核：

- Agent 能调查，而不是只给建议；
- 大多数抽查 case 的结果至少“部分有用”；
- 没有发现危险的无依据确定性结论；
- 用户能理解候选、证据、限制和下一步；
- 遇到无法证明的情况，Agent 能诚实停止或请求复核。

如果出现“安全通过但 Agent 产出无用”，问题应归因到证据、工具、prompt 或 Agent 能力，而不是降低安全门禁。

## 8. 推荐执行顺序

### 第一步：先运行现有确定性门禁

```powershell
npm run check
```

确认当前源码基线稳定后，再做下一步测试。测试读 `dist/`；如果修改源码，先按项目规则构建。

### 第二步：补最小缺口测试

优先补以下三组，不要先扩展测试框架：

1. Agent completed + validation failed 的结果保留和分类；
2. candidate replay / 工具反馈的最小闭环；
3. batch crash + resume 的重复执行保护。

每个新增门禁都要配一个能使门禁失败的反向用例。

### 第三步：运行小型 deterministic Agent loop

使用 4–6 个小 fixture，重点观察 Agent 是否：

- 读取相关证据；
- 形成并修正假设；
- 实际操作 staging；
- 诚实报告不确定性。

不要要求每个 fixture 都输出相同文本或相同操作序列；只检查安全边界、必要 invariant 和结果可交接性。

### 第四步：执行代表性真实 Runtime smoke

每个 Provider 选择 1–2 个 case，人工复核至少一个成功产生候选、一个证据不足或失败的 case。

### 第五步：再执行完整 5+5

只有在前面各层通过后再跑完整 5+5，并与前一批样本比较：

- 是否出现新的分类错误；
- Agent 产出是否仍保留；
- source、lifecycle、resume 是否稳定；
- model request 时延是否异常变化；
- 人工抽样结果是否更有用。

## 9. 不能从测试结果宣称什么

即使所有自动化测试通过，也不能宣称：

- 所有历史 session 都能恢复；
- 每个 candidate 都是用户真正想要的结果；
- `verified` 等于语义正确；
- Agent 产生的 confidence 等于事实概率；
- 某个 Provider 的成功率可以代表所有 Provider；
- deterministic fixture 的结果可以直接外推到真实历史任务。

可以宣称的内容应具体到证据：

- 某类工具边界被验证；
- 某类失败能安全终止和续跑；
- 某批真实 case 的 staging、审计、持久化和 resume 可靠；
- 某些人工抽查 case 对用户有用；
- 哪些情况证据不足、仍需人工判断。

## 10. 克制的最终方案

Recovery 测试不应发展成第二套 Recovery 系统。保持以下最小结构即可：

```text
现有单测
  -> 验证协议、边界和失败处理

少量 deterministic Agent loop
  -> 验证工具、候选协议和反馈闭环

代表性真实 Runtime smoke
  -> 验证 Provider 兼容和实际产物

人工抽样复核
  -> 判断 Agent 产出是否真正有用
```

核心原则：

- 相信 Agent 的语义能力，但不把边界安全交给 Agent 自律；
- 允许 Agent 自主调查、提出多个假设、继续尝试或停止；
- 不用固定 hypothesis 数、模型调用次数、候选数量或恢复成功率限制 Agent；
- 只为可明确验证的安全和协议不变量写硬门禁；
- 只在确有价值时增加 replay 和 fixture；
- 优先保留信息和反馈，而不是增加状态、评分器和抽象层。

这套方案既能测试当前 Recovery 是否达到预期，也不会规划一个实际上无法实现的“自动判断所有语义恢复正确”的系统。

## 11. 当前 5+5 作为基线的定位

`recovery-sample-20260821-5plus5-rerun` 可以作为以下能力的真实基线：

- 10/10 staging 成功；
- 10/10 forensics 完成；
- 40/40 evidence source coverage；
- 10/10 source unchanged；
- 10/10 resume 跳过既有 terminal 且没有新增模型调用；
- 真实 Codex/Claude Code Provider 的时延和终态分布。

它不能作为以下能力的基线：

- 语义恢复正确率；
- candidate replay pass rate；
- 用户接受率；
- 所有 Agent 候选的实际价值。

这些能力需要 deterministic loop 或人工抽样才能获得有意义的证据，而不是继续单纯扩大样本数量。

## 12. 本文档的完成边界

本文档只规划测试和评估方法，不要求立即修改 Recovery 架构。执行时应先补最小测试缺口，再根据真实人工复核结果决定是否修改工具、prompt 或终态分类。

本次只新增文档，不修改源码、不提交、不 push。文档修改后运行：

```powershell
npm run verify:docs
```
