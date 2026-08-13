# Reprise 真实运行复盘与 Comparison 报告重设计讨论稿

日期：2026-08-12
范围：仅分析本次真实 Codex 重放，不改动实现。

## 结论先行

这次验收证明了 **Harness 主链路基本可用**，但还没有证明候选模型完成了任务，更没有形成一个能帮助用户判断的比较报告。

- 主链路已工作：历史会话被冻结为不可变 `TaskCase`；Recovery 成功；候选在隔离工作区启动；运行事件已连续持久化；清理完成；HTML 报告已生成。
- 本次候选结果应标为 **未完成、证据有限**，而非“Luna 表现差”：候选的第一轮在 10 分钟安全超时后被中断，任务状态为 `not_assessed`。
- Controller 没有进入实质决策循环；它不是本次候选未完成的原因，而是候选没有自然结束后没有可继续控制的机会。
- Comparison Agent 被实际调用，但输出不满足每条 observation 都带证据的 schema，结果被安全拒绝并退回固定 fallback。
- 因此当前 `report.html` 是“运行账单”，不是“由 Agent 从真实过程里挑出值得看的差异的比较报告”。用户指出的问题成立。

本次工件：

- 历史会话：`019fd07f-c261-7063-bd08-82552d33cd12`
- 冻结任务：`case-952e8e701b0bf04f`
- 实验：`experiment-24c4c221-4b6c-458b-b05b-a515c847c2bf`
- 运行：`run-60f7fa06-1ea8-494f-8d98-49b3a7e7da3a`
- 报告：[report.html](C:/Users/15893/AppData/Local/Temp/reprise-p7-controller-019fd07f-xwNtGA/experiments/experiment-24c4c221-4b6c-458b-b05b-a515c847c2bf/report.html)

## 1. 本次运行实际发生了什么

### 已验证的有效部分

1. TaskCase 已冻结，输入没有回写到原始会话。
2. Recovery Agent 使用 Terra 完成了结构化恢复计划，且不是 fallback。
3. Candidate 由 Codex Runtime 解析为 `gpt-5.6-luna`；Harness 内部 Recovery、Controller、Comparison 使用 `gpt-5.6-terra`。
4. Candidate 在实验专属隔离 workspace 中运行；workspace scope 记录为 `changedPaths: 0`、`runtimeGeneratedPaths: 0`。
5. 事件流共有 971 条；序号连续、事件 ID 唯一、checksum 可验证；运行清理为 `complete`，没有遗留 `writer.lock`。
6. fidelity 为 `observational`，原因是历史会话没有可验证的环境 fingerprint。这是比较边界，不是运行故障。

### 本次不能得出的结论

不能把这次结果写成“Luna 不如 baseline”。候选没有得到完整执行窗口：

- 实验的单轮 `turnTimeoutMs` 是 600,000 ms（10 分钟）。
- 事件 953 显示候选仍在做 METR 资料检索；它不是崩溃或空转。
- 事件 956 为 `run.stop_requested / limit.turn_timeout`。
- 事件 960 的 Codex turn 为 `interrupted`，`durationMs: 599998`。
- 因此 `not_assessed` 是正确的任务评估状态；真正缺的是报告把这个状态解释清楚。

历史 baseline 已完成设计文档更新；本轮候选停在研究阶段。这个“完成产物 vs 尚在研究”是有价值的过程差异，但只能说明 **本次运行未完成，尚不能做质量对比**。

### Controller 的实际状态

`controller.started` 存在，但没有 `controller.decision`。候选第一轮未自然 settled 就被 safety budget 停止，正式多轮控制并未发生。

另外，结果摘要把“没有调用 Controller”呈现为 `usedFallback: true`，诊断又为 `null`。这会误导排障：应区分以下三种状态，而不应用一个 fallback 布尔值概括：

- `not_needed`：候选已完成，不需要下一条输入；
- `not_reached`：候选因超时/失败停止，未进入控制决策；
- `fallback_used`：实际调用过 Controller，但解析或模型调用失败后使用兜底。

## 2. 为什么当前 Comparison 失败

Comparison 不是没有调用。事件 969 为 `comparison.started`，事件 970 为 `comparison.completed` 且 `usedFallback: true`。

直接检查该次 Terra 的结果可见：模型返回了顶层 JSON，且有 7 条 observations；其中只有 3 条带 evidence，5 条缺少必填且非空的 evidence。当前 schema 对每一条 observation 都要求 `minItems: 1`，所以整份结果被拒绝。这是正确的安全策略，但当前产品处理不好：

1. prompt 只说明 evidence refs 可用，没有把“每一条都必须至少引用一个”写成不可违反的输出合同；
2. `ComparisonContext` 太贫乏，模型几乎只能看到任务文本、baseline final message、`task status; termination code`、trace 范围和 artifact ID；
3. 模型不知道哪些事件最重要，也没有候选的过程摘要、工具/命令摘要、最终消息、耗时、工作区范围等材料来挑选；
4. 任意一条泛泛 observation 不合格会使整份结果退回，随后只剩一句英文 fallback。

安全校验应保留。问题不是“放宽 evidence 要求”，而是让 Agent 在有足够事实的情况下只输出带证据的少量重点；如果没有重点，允许空 highlights，而不要编造。

## 3. 当前 HTML 为什么不符合产品目标

### 语言错误

`src/report/comparison-report.ts` 固定输出 `<html lang="en">`，标题和栏目也全部硬编码英文。任务内容即使是中文，页面的阅读框架仍是英文。这不是 Agent 输出语言问题，而是 renderer 没有 locale 输入。

报告语言应由用户明确选择的 TUI locale 决定；首期可只支持 `zh-CN` 和 `en`。如果尚未设置，才以初始用户输入语言作为一次性的 fallback。不要让 Comparison Agent 猜 UI 语言。

### 内容结构错误

当前页面固定为 Task / Baseline / Comparison / Candidate runs / Artifacts。即使 Comparison 成功，也只是把 observations 塞进固定列表。它不能回答用户真正先看的四件事：

1. 这次能不能比较？
2. 候选做到哪里、停在哪里，为什么？
3. 相对 baseline，最值得查看的 2–5 个差异是什么？
4. 我应点击哪条证据来自己判断？

本次报告的首屏反而把最关键的“10 分钟超时、未完成、不可据此判质量”埋在 `Candidate runs` 的技术字段里，而 Comparison 区只有 “agent unavailable”。

### Agent 自主性不足

当前 Agent 既没有足够事实，也没有“选择什么才值得展示”的产品任务定义；renderer 则只会展示固定标签。因此呈现出来像模板。正确的分工应是：

- **系统**：持久化事实、约束证据、生成安全链接、按 locale 渲染；
- **Comparison Agent**：在可控的事实摘要中，挑选少量信息增益最大的差异，排序并解释其为何影响用户判断；
- **用户**：打开证据和产物，自行决定模型是否更适合自己。

Agent 不应宣布赢家、虚构统一评分或脱离证据评价代码质量。

## 4. 最小重设计建议

不需要增加页面框架、第二套报告系统或通用评分引擎。保留现有 HTML renderer、artifact 链接和 schema 校验，只扩充它们的输入与结果合同。

### 4.1 Comparison 输入：给 Agent “可比较的过程摘要”，而不是全量 transcript

不要再次把几十万字符的历史 transcript 或所有 events 直接送给模型。建议在应用层从已持久化事实确定性地提炼以下小摘要，并为每项附可用 evidence ref：

- **比较状态**：baseline 是否完成、candidate 是否完成、termination、是否可作严格比较、原因；
- **时间线**：开始/结束/耗时、关键生命周期事件；
- **候选过程**：最后若干个工具调用或命令的简短摘要、执行状态、最后 agent message（如存在）；
- **baseline 过程/产物**：baseline final message、可枚举的产物/证据；
- **环境与隔离**：fidelity、workspace scope、cleanup；
- **可查看证据目录**：evidence ID、短标签、来源、可安全显示的摘要、链接目标。

这里的摘要应由代码从 trace 生成，不让 Agent 代替事实提取。Agent 只选择与解释，所有可点开的文本仍来自已持久化证据。

### 4.2 Comparison 输出：从“观察列表”改成“有状态的精选发现”

建议的最小结构（名称可调整）：

```ts
{
  comparisonStatus: 'comparable' | 'partial_evidence' | 'not_comparable',
  headline: string,
  highlights: [{
    kind: 'completion' | 'process' | 'artifact' | 'time' | 'environment' | 'limitation',
    statement: string,
    importance: 'high' | 'medium',
    side: 'baseline' | 'candidate' | 'both',
    evidence: string[],
    inspect: string[]
  }],
  limitations: string[],
  nextRunSuggestion?: string,
  generatedAt: string
}
```

约束：

- `highlights` 为 0–5 条；每条必须至少有一条已提供的 evidence；`inspect` 只能引用可安全打开的证据或 artifact；
- `comparisonStatus` 是事实分类，不是质量等级；本次应为 `not_comparable` 或 `partial_evidence`，具体取决于我们是否愿意把“未完成对已完成”的过程差异展示为比较；
- `nextRunSuggestion` 仅是实验建议，必须明确不是模型质量结论；
- prompt 明确“宁可少于两条，也不得给无证据的泛泛判断”；
- 解析失败时不丢掉确定性事实，而由本地 fallback 生成与语言匹配的诊断卡。

这样“展示哪些差异”由 Agent 自主决定，但选择空间受证据目录约束，结果可审计。

### 4.3 报告首屏：固定骨架只负责回答问题，不固定结论

无论 Agent 是否成功，首屏都应有本地确定性状态卡：

- **本次比较状态**：例如“候选未完成，不能据此判断质量”；
- **关键原因**：例如“第一轮在 10 分钟安全超时后中断”；
- **已验证运行条件**：隔离、清理、trace integrity、fidelity；
- **建议动作**：例如“延长单轮预算后重跑”，并说明这是实验建议。

只有在 Agent 成功时再放置“本次最值得看的差异”区块，按 `importance` 排序，提供简短结论和“查看证据”链接。其余技术字段放到可展开的“运行详情”，不要与主结论争夺首屏。

fallback 也不能再写“Comparison agent unavailable”。本次更合适的中文 fallback 是：

> 候选第一轮在 10 分钟安全超时后中断，尚未形成可评估产物；本报告仅展示已持久化运行事实，不能据此判断候选模型质量。

这句话完全可以由本地事实生成，不依赖模型。

## 5. 本次验收暴露的优先级

1. **P0：报告语言与运行状态解释**。否则用户会误读本次结果。
2. **P0：Comparison context 与 schema/prompt 的证据闭环**。否则 Agent 即使被调用，也持续退回模板。
3. **P1：报告的证据导航与动态 highlights**。这是产品差异化核心。
4. **P1：Controller 状态细分**。让“没到 Controller”不再伪装成“Controller fallback”。
5. **P2：执行预算策略**。当前任务明显超过 10 分钟；默认可考虑 30 分钟单轮，或根据历史会话的原始用时建议预算，但不应把历史时长当作强制限制。

P0–P1 可在现有 comparison/report 两三个模块中完成，无需新依赖、全量 trace 进 prompt 或评分框架。

## 6. 希望确认的产品决策

请优先确认下面五项；确认后再写最小实现与测试：

1. **报告语言来源**：建议“用户在 TUI 设置优先，未设置时按初始任务语言检测”。是否同意？
2. **未完成时的状态**：建议使用 `not_comparable`，同时允许展示“baseline 已完成 / candidate 被超时中断”的过程差异，但不展示质量优劣。是否同意？
3. **Agent 的职责**：建议只选择、排序、解释 highlights，并可选择证据 snippet；renderer 负责本地化和安全呈现。是否同意？
4. **评价形态**：建议帮助个人用户判断，不给单一数值总分或“赢家”。是否同意？
5. **重跑预算**：建议把此次 `turnTimeoutMs` 提至 30 分钟再验收，还是保留 10 分钟并在 TUI 让用户显式选择更长预算？

## 附：本次判断的直接证据

- `events.jsonl` 事件 953：候选仍完成了一条 METR 资料检索命令；
- 事件 956：`run.stop_requested`，代码为 `limit.turn_timeout`；
- 事件 960：Codex turn 为 `interrupted`，耗时 599,998 ms；
- 事件 968：`controller.started`，但不存在 `controller.decision`；
- 事件 969–970：Comparison 实际启动后完成，最终 `usedFallback: true`；
- `comparison.json`：固定 fallback 文案；
- `experiment.json`：本轮单轮预算为 600,000 ms。

实现对应关系：

- 比较上下文：`src/application/comparison.ts`
- Comparison schema/prompt：`src/agents/comparison-agent.ts`
- HTML renderer：`src/report/comparison-report.ts`
- 原设计约束：`docs/architecture/comparison.md`
