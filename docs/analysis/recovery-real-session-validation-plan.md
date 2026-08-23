# Recovery Agent 真实会话验证方案

> 目的：通过真实历史会话和真实 Runtime，判断 Recovery Agent 是否能在实际场景中帮助用户恢复工作环境。  
> 范围：真实 Codex / Claude Code 会话、真实 Recovery Agent、真实 staging、真实候选产物和人工复核。  
> 本文不是单元测试或代码门禁设计；代码门禁只作为运行真实会话前的最低前置条件。

## 1. 要验证的不是“指标”，而是实际可用性

Recovery 的真实问题不是“模型是否输出了某个固定 JSON”，而是：

> 给定一段真实历史会话和一个隔离的损坏/缺失状态，Recovery Agent 能否通过调查历史证据，在不污染 source 的前提下，产出一个对用户有实际帮助、可解释、可继续使用或可人工接手的恢复候选？

真实会话测试需要观察完整过程：

```text
真实历史会话
    -> 选择恢复 case
    -> 冻结 source 和证据
    -> 真实 Runtime 调用 Recovery Agent
    -> Agent 自主调查、形成假设并执行
    -> staging 中产生候选和恢复报告
    -> Host 保存完整审计和终态
    -> 人工复核结果是否有用
```

测试重点不是强迫所有 case 进入 `verified`，也不是计算一个看似精确的“真实恢复率”。历史任务的正确恢复结果往往取决于用户意图、上下文和证据完整性，最终价值必须通过实际产物和人工复核判断。

## 2. 真实会话测试的成功定义

一次真实会话测试至少要能回答以下问题：

### 2.1 Agent 是否真的工作

需要看到：

- Agent 读取了与任务相关的历史证据；
- Agent 能从证据中提出合理假设；
- Agent 根据证据选择调查方向，而不是机械执行固定 playbook；
- Agent 在 staging 中真实执行恢复操作；
- Agent 能利用工具反馈继续、修正、比较候选或停止；
- `recovery.md`、manifest、candidate 和 event log 之间相互对应。

### 2.2 结果是否对用户有用

人工复核者需要判断：

- 恢复出的内容是否接近用户当时真正需要的工作状态；
- 候选是否减少了用户后续工作；
- Agent 是否清楚区分了事实、推断和猜测；
- 未恢复内容和不确定性是否被明确记录；
- 用户是否可以基于结果决定接受、继续调查或放弃。

### 2.3 系统是否安全可靠

真实会话中必须同时确认：

- source 前后 digest 一致；
- 所有写入都发生在隔离 staging；
- 未访问凭据、全局配置和未授权路径；
- 候选和报告可从 artifact、event log 和 case terminal 追溯；
- Agent、Provider 或持久化失败不会被伪装成成功；
- resume 不会重复执行已有 terminal case。

这些是系统硬边界，不是对 Agent 能力的评分。

## 3. 不要从所有历史会话开始：先建立真实样本分层

真实会话测试最容易失败的方式，是随机挑很多历史 session，然后把所有失败都归因于 Agent。应先按照证据和任务类型分层，再选择少量代表性样本。

### 3.1 第一批建议选 8 个 case

如果成本允许，可继续使用 5+5 作为完整批次；但用于第一次实际验证时，建议先选 8 个：

| 层 | 数量 | 选择条件 | 目的 |
|---|---:|---|---|
| 高证据、可观察结果 | 2 | 有完整 transcript、tool call 和明确工作区变化 | 验证 Agent 能否完成清晰恢复 |
| 中等证据、存在缺口 | 2 | 有部分历史结果，但缺少某些 preimage 或 task outcome | 验证 Agent 能否表达不确定性 |
| 冲突或多候选 | 2 | 不同证据指向不同路径、workspace 或版本 | 验证 Agent 是否调查和比较，而不是猜测 |
| 低证据或无法恢复 | 2 | 历史 session 不足以支持可靠恢复 | 验证 Agent 是否能安全停止并交接限制 |

每个 Provider 至少选 2 个 case。若继续使用 Codex 5 + Claude Code 5，应保证每个产品都包含高证据和低证据样本，而不是只看产品平均结果。

### 3.2 样本选择前必须检查

不要把以下情况直接当作 Agent 测试样本：

- 历史 session 本身损坏或无法读取；
- source、transcript、tool artifact 和 session metadata 无法关联；
- 没有办法描述 case 的损坏状态；
- 会话包含真实凭据、个人隐私或不可用于本地测试的敏感内容；
- 任务目标完全不清楚，且没有任何可供人工判断的上下文。

这类 case 可以作为“证据不足样本”，但不能用来评价 Agent 是否恢复失败。

### 3.3 每个 case 建立一个冻结清单

在启动真实 Runtime 前，为每个 case 保存一份 Host-owned `baseline-dossier`，至少包含：

- `caseId`、Provider、session hash；
- 历史会话的 evidence level；
- initial input 或任务摘要；
- source digest、文件数和 warning 数；
- 可用 evidence source 列表；
- 人工对损坏状态的简短描述；
- 不把唯一答案写给 Agent 的情况下，人工可观察的预期线索；
- 样本选择原因和风险等级。

baseline-dossier 是测试基线，不是给 Agent 的答案。它要帮助测试者判断“Agent 看到了什么”和“测试结束后发生了什么”。

## 4. 真实会话运行前的准备

### 4.1 运行边界

每个 case 必须拥有独立的：

- staging workspace；
- recovery experiment root；
- event log；
- artifact root；
- terminal row；
- source before/after audit。

真实 Runtime 必须显式 opt-in，默认命令不能产生外部模型费用。不要在用户真实工作目录直接运行 Recovery。

### 4.2 运行版本记录

每次真实批次必须记录：

- run id；
- 运行时间和机器信息；
- Provider 和 Runtime 版本；
- Reprise commit 或工作区摘要；
- Recovery prompt / playbook 版本或 digest；
- schema 版本；
- 工具面和 capability 配置；
- 是否 resume、offset 和 limit；
- 运行是否允许网络、shell 以及相关实际能力。

如果这些信息没有记录，后续无法判断两次真实测试差异来自 Agent、Runtime、代码还是样本。

### 4.3 运行前人工只做三件事

测试者不应提前替 Agent 规划恢复步骤，只确认：

1. source 已冻结且 digest 已记录；
2. sample 的证据和 staging 已正确绑定；
3. 运行范围和费用已明确。

不要把“预期恢复路径”通过额外 prompt 注入 Agent，否则测试到的是人工提示能力，不是真实 Recovery 能力。

## 5. 真实会话执行方案

### 5.1 第一轮：正常运行

对每个 case 只启动一次真实 Recovery Agent，让它在现有工具和 playbook 下自主工作。不要在中途通过人工提示纠正它。

运行时记录：

- Agent 实际调用的工具和顺序；
- 读取了哪些 evidence source；
- 形成了哪些 hypothesis；
- 哪些操作成功或失败；
- 是否产生候选、report、manifest 和 diff；
- 是否执行了直接相关的最小核验；
- Agent 最终为何继续、停止或请求 review；
- Host / Provider 的验证结果和终态。

第一轮的目的，是观察系统自然行为，不是追求成功率。

### 5.2 第二轮：只对有价值的 case 做定向复核

第一轮结束后，不要自动对所有 case 重新调用模型。只选择以下情况进行第二轮：

- Agent 已经发现证据冲突，但没有足够信息做决定；
- 工具反馈显示候选有明显问题，且存在可调查的新证据；
- Provider validation 失败，但 Agent 产出仍可能有价值；
- 用户人工判断候选“部分有用”，且知道下一步应该补哪条证据。

第二轮必须记录为什么重跑，以及新增信息是什么。不能为了把 `pending_user_review` 改成 `verified` 而盲目重试。

### 5.3 不要把人工接受混入 Agent 首轮测试

首轮测试应只评估 Agent 的调查和候选产出。不要自动写回 source，也不要把人工接受动作和 Agent 执行混在同一个 case 中。

如果要验证“用户接受后是否能安全交付”，另建 promotion / acceptance 测试批次，使用已经人工复核过的候选，避免把语义判断和写回安全问题混为一个结果。

## 6. 真实会话结束后的审查顺序

每个 case 按以下顺序审查，先确认事实，再评价价值。

### 6.1 第一层：机械安全审查

不通过则停止后续评价：

- source digest 是否保持一致；
- staging 是否独立；
- 是否出现越界写入或敏感文件访问；
- artifact、event、terminal 是否完整且可关联；
- terminal 是否与实际执行结果一致；
- 是否存在丢失 Agent 产出的 runner/validation 分类错误。

### 6.2 第二层：Agent 工作过程审查

从 event log、model input artifact、tool trace、recovery.md 和 candidate 中核对：

- Agent 是否读了真正相关的证据；
- 是否把 evidence fact 和自身推断分开；
- 是否主动调查了明显的替代解释；
- 是否正确处理冲突证据；
- 是否使用了工具反馈；
- 是否在证据不足时减少承诺，而不是增加猜测；
- 是否执行了与任务直接相关的最小核验。

### 6.3 第三层：结果可用性审查

人工复核者在不看 terminal classification 的情况下，先阅读 Agent 产物并回答：

1. 我能否理解原任务和当前损坏状态？
2. 我能否知道 Agent 恢复了什么？
3. 我能否知道这些恢复依据是什么？
4. 我能否知道哪些内容仍不确定或缺失？
5. 这个候选是否能直接减少我的工作？
6. 如果不能直接使用，我是否知道下一步调查什么？
7. Agent 是否过度自信或误导？

用三档记录即可：

- **可直接交接**：结果和解释足够进入下一步工作；
- **部分有用**：有真实进展，但需要人工补证据或处理遗留项；
- **不可用/危险**：无依据、误导、遗漏关键冲突或边界不安全。

不要求所有 case 都达到第一档。对于低证据样本，诚实且具体的“部分有用”或“不可证明”可能是正确结果。

## 7. 人工复核记录

每个真实 case 建议产生一份独立的 `human-review.md`，不要把人工判断伪装成运行时 schema 字段。模板如下：

```markdown
# Recovery 人工复核

- case:
- provider:
- run:
- reviewer:
- reviewedAt:

## 1. 运行事实

- source unchanged:
- staging isolated:
- terminal:
- candidate count:
- model calls:

## 2. Agent 做了什么

- 关键调查：
- 关键证据：
- 关键假设：
- 实际恢复操作：
- 验证或反馈：

## 3. 结果判断

- 可用性：可直接交接 / 部分有用 / 不可用或危险
- 证据是否支撑结论：充分 / 部分 / 不足
- 是否正确表达不确定性：是 / 部分 / 否
- 是否发现冲突：是 / 否 / 不适用
- 是否建议人工接受：是 / 否 / 需要补证据

## 4. 问题归因

- Agent：
- evidence：
- tool/Host：
- Provider：
- verifier/终态：
- 产品预期不清：

## 5. 结论

只记录可复核事实、人工判断依据和下一步建议，不填写虚构的恢复成功率。
```

## 8. 真实批次结果如何汇总

批次汇总只报告可观测事实，不把不同性质的结果合并成一个分数。

### 8.1 运行可靠性

报告：

- staging 成功数；
- forensics 完成数；
- source unchanged 数；
- terminal 持久化成功数；
- lifecycle integrity 通过数；
- resume 跳过数和重复模型调用数；
- Provider / runner / persistence failure 数；
- wall-clock、model request 和工具阶段耗时。

### 8.2 Agent 行为观察

按 case 列出：

- evidence source 使用情况；
- hypothesis 是否有依据；
- candidate 是否物化；
- unresolved 是否明确；
- 是否进行了反馈后的修正；
- 是否主动停止或请求人工判断。

### 8.3 用户可用性

汇总人工复核的：

- 可直接交接；
- 部分有用；
- 不可用或危险；
- 未复核。

这些数字只用于比较不同 prompt、工具和 Provider 版本，不作为 Agent 运行时硬门槛，也不宣称为通用语义恢复率。

## 9. 运行批次建议

### 批次 A：小规模真实试跑

- 2 个 Codex + 2 个 Claude Code；
- 每个 Provider 包含一个高证据 case 和一个低证据/冲突 case；
- 全部人工复核；
- 目标是发现运行链、证据提供、终态分类和产物可读性问题。

### 批次 B：真实 5+5

在批次 A 没有发现阻断性安全或持久化问题后执行：

- Codex 5 个；
- Claude Code 5 个；
- 记录完整批次和分 Provider 结果；
- 每个 Provider 至少人工复核 2 个代表性 case；
- 对 Agent completed 但 validation failure 的 case 必须单独抽查。

### 批次 C：定向复核

只重跑批次 B 中确实有新增证据或新增调查价值的 case：

- 不超过 2–3 个；
- 预先记录重跑原因；
- 允许 Agent 获得新增反馈，但不直接告诉它人工预期答案；
- 比较第一轮和第二轮的假设、候选和 unresolved 是否改善。

### 批次 D：用户交接试用

从真实批次中选择 2–3 个“可直接交接”或“部分有用”的候选，由熟悉原任务的用户实际查看：

- 是否能继续原工作；
- 是否需要重新调查；
- 哪些信息仍然缺失；
- 是否愿意接受该候选；
- 用户是否能理解 Agent 的限制说明。

这个批次才用于回答“实际场景下能不能使用”，而不是仅由工程人员阅读 artifact 判断。

## 10. 真实测试的停止和通过标准

### 10.1 立即停止条件

出现以下任一情况，停止批次并先修复系统：

- source 被修改；
- 凭据或敏感内容泄露到 artifact、event 或报告；
- Agent 越界操作未被 Host 拦截；
- terminal 与实际结果不一致；
- resume 重复执行已有 terminal case；
- Agent 已完成但产出被错误丢弃，且无法追溯；
- 真实 Runtime 运行费用或网络能力超出预期。

### 10.2 工程层通过

满足以下条件，才认为这批真实运行在工程上可用：

- 每个 case 都有独立、完整、可追溯的运行产物；
- source 全部保持不变；
- 正常、证据不足、Provider failure 和 runner failure 都能有明确终态；
- 中断后可安全 resume；
- 不需要人工修改 artifact 才能解释结果。

### 10.3 实际使用层通过

不设置统一成功率阈值。建议至少满足：

- 抽查 case 没有发现危险的无依据确定性结论；
- 每个 Provider 至少有一个 case 的产物被人工认为“部分有用”或“可直接交接”；
- 对低证据 case，Agent 能明确说明无法证明的部分；
- 熟悉原任务的用户能够使用至少部分恢复产物继续工作，或清楚知道下一步怎么补证据；
- 发现的问题可以归因并指导下一轮修改，而不是只得到一个失败数字。

如果所有样本都只是“安全但无用”，就说明 Recovery Agent 尚未达到实际预期，即使所有机械指标都是 10/10。

## 11. 当前 5+5 结果如何继续使用

`recovery-sample-20260821-5plus5-rerun` 已经可以作为真实运行工程基线：

- 10/10 staging；
- 10/10 forensics；
- 40/40 evidence source coverage；
- 10/10 source unchanged；
- 10/10 resume 无新增模型调用。

下一步不要首先扩大到更多真实 case，而应：

1. 从已有 8 个 `pending_user_review` 中抽取 2–3 个；
2. 查看 Agent 是否真的完成了有价值的调查和候选生成；
3. 单独分析 Claude-01/02 的 `runner_crashed` 及 Provider validation 产物是否被保留；
4. 为每个 Provider 形成至少两份人工复核记录；
5. 再决定是调整 evidence、工具、prompt、终态分类，还是保持实现不变。

这一步将首次把“编排闭环已完成”与“真实 Agent 产出有用”区分开来。

## 12. 约束与克制

本方案明确不做以下事情：

- 不把人工判断包装成自动 truth engine；
- 不要求所有 case 输出统一答案；
- 不按模型 confidence、模型调用次数、hypothesis 数量或 candidate 数量判定成功；
- 不为了提高成功率放宽 `no_task_path_outcome` 等安全拒绝；
- 不因为一次真实失败就增加新的 Agent 角色或复杂状态；
- 不把 deterministic fixture 结果外推为所有真实历史任务的恢复能力；
- 不在没有新证据时盲目重复调用真实 Runtime。

测试的核心产物不是一个漂亮的分数，而是：

```text
真实会话 -> Agent 行为 -> 候选与解释 -> 隔离审计 -> 人工可用性判断
```

## 13. 执行说明

本文档只规划真实会话测试，不要求立即修改 Recovery 源码。执行真实 Runtime 前，仍应先运行现有工程门禁；如果只修改文档，运行：

```powershell
npm run verify:docs
```

真实 Runtime 必须显式 opt-in，并确认运行范围、网络能力、模型费用和输出目录。不要提交凭据、真实敏感 session 内容或未经脱敏的测试 artifact。
