# Comparison 真实任务比较卡重构方案

状态：proposed

## 目标

本方案针对 2026-09-10 PPT 复刻对照结果暴露的问题：报告首屏被长文占满、真实交付物不可见、Host 只提供终态文本、baseline/candidate 指标口径不一致、第四轮无法看到实际页面。目标不是美化某一份 HTML，而是让 Comparison 稳定生成一张可分享、可核查的真实任务比较卡。

## 已确认的产品设计

- 首屏固定为：标题、一句任务、三张 Host 指标卡、Agent 的关键差异。
- 三张卡只展示时间、token、费用；每张都并列 Baseline 与 Candidate。
- 指标数字和单位由 Host 确定性计算并写入，Agent 不得修改。
- Baseline 指标从冻结历史事件计算；Candidate 指标从本次所有相关 usage/cost 事件汇总，不能取最后一次 usage。
- 无法采集的值显示“未采集”，不补零、不估算 baseline 费用。
- 标题和一句任务由 Agent 填写；关键差异由 Agent 判断并放在指标卡之后。
- 具体过程、逐轮材料和限制放在关键差异之后，默认可折叠；不要求逐轮配对。
- Agent 可以自主选择实物、截图、局部 diff 或缺测占位作为关键证据；没有实物时必须明确呈现缺测或可验证的示意，不声称看见不存在的媒体。
- Host 预写报告壳；Agent 只能修改标题、任务句和壳下内容，不能改指标卡数字。
- Comparison 使用一个连续 Session 和四个固定工作委托；前三轮自由文本，第四轮审阅并返回信封。

## 当前代码问题

实施 Agent 必须追踪以下真实调用链，而不是只改 CSS：

```text
experiment-compare-persisted / comparison entry
  → comparison-briefing.ts
  → briefingComparisonContext / reportFacts
  → comparisonLinks()
  → ComparisonAgent four turns
  → Host report validation / publish
```

当前问题包括：

1. `comparisonLinks()` 主要索引最后助手文本、最后 candidate visible 文本和 artifacts，不能保证收录历史/候选产物、媒体、清理前交付副本和稳定 href。
2. Candidate snapshot 可能发生在 Runtime cleanup 后，PNG/PPTX/HTML 已被清空，Comparison 只能看到占位或终态树。
3. `reportFacts` 与 TUI 使用不同 token/cost 口径：可能只取最后 usage，或只认 `total`；历史 baseline telemetry 未被确定性投影。
4. Host 没有给 Comparison 一个真实首屏的可观察输入，第四轮只能读 HTML 源码，无法按“截图首屏”审阅。
5. Agent 仍可能把任务列表、整体摘要和逐轮日记放在关键差异之前，缺少首屏结构约束。
6. 旧设计允许 Agent 自由发明顶部指标和布局，导致 baseline 指标缺位、停机状态占卡、硬指标被模型改写。

## 目标架构

### Host 事实层

`comparison-briefing.ts` 负责生成唯一的 `reportFacts`：

- `time`: baseline 与 candidate 的明确起止和 elapsed seconds；历史真人等待与候选自动续接分开标注。
- `tokens`: baseline/candidate 的累计 input、output、cache 及 total（按产品事件语义汇总，避免重复计数）。
- `cost`: 只使用有来源的实际成本；baseline 无价格则为 unavailable；candidate 汇总所有相关 cost 事件并记录 cost basis。
- `delivery`: 双方实际交付物、媒体类型、字节数、清理状态、快照状态和稳定 artifact/report href。
- `activity`: turns/controller 数量等辅助事实，不进入三张指标卡。

所有数字先过 schema 和确定性计算，再写入 `briefing/facts/context.json`。TUI、Comparison 和最终报告使用同一份投影，禁止各自计算。

### 交付物保存层

在 Runtime cleanup 之前捕获候选最终交付物和必要媒体；如果产品会恢复或清空 cwd，保存到 Host-owned artifact/snapshot，并记录原路径、媒体类型、字节数、清理状态和 evidence ref。清理后的占位文件不能冒充交付物。

`comparison-links.json` 应索引：

- baseline 交付物和可读文本；
- candidate 交付物、截图、HTML、PPTX、PNG、压缩包及清理状态；
- 关键 user-view、turn 过程和必要事实文件；
- 稳定的相对 `reportHref` 和 `evidenceRef`。

即使文件为 0 字节，也记录 `byteLength`、`cleared` 或 `unavailable`，让 Agent 能诚实展示缺测。

### 报告壳层

Host 在第三轮之前写入 `report.html` 壳：

```text
标题 slot（Agent）
一句任务 slot（Agent）
三张指标卡：时间 / token / 费用（Host，不可改）
关键差异 slot（Agent）
具体过程与证据 slot（Agent）
```

壳可以固定视觉样式，但不固定 Agent 关键差异的内容。Agent 使用 `data-host="metrics"` 识别不可修改区域。Host 发布前检查这些卡仍存在且数字未变。

### Agent 观察层

Agent 首轮读取用户输入索引和 briefing 导航；后续按需读取 `comparison-links.json`、实际交付物、媒体、turn 过程和 facts。不要把完整 host trace 塞进首包。对视觉内容：

- 能读取实际媒体时，使用稳定链接或内嵌副本；
- 不能读取时，写清“不可观察/已清理/0 字节”，可用 SVG 示意解释结构但必须标明是示意；
- 不把历史助手自述当作视觉观察。

## Prompt 方案

### System Prompt

只保留稳定规则：比较真实任务中的历史方案和候选方案；依据可读取材料；区分观察、推断和未知；不修改被比较的交付物；使用 Host 指标卡；关键差异优先；不夸大、不虚构媒体和指标；遵守离线、隐私和工作区边界；四个委托在同一 Session 中继续。不要在 System Prompt 写具体数字、固定报告章节或指标公式。

### Turn 1：理解任务

读取完整用户输入索引和必要关联材料，形成对用户目标、最终要求和评价重点的理解。本轮不评价双方，不写正式报告；不必遍历全部工具过程。

### Turn 2：调查关键差异

按需调查双方实际交付、关键过程、媒体、限制和 Host 指标。优先寻找最能解释用户影响的具体差异，不强行逐轮配对，不把摘要当证据。可以写工作笔记和准备材料。

### Turn 3：填充比较卡

打开 Host 预写的 `report.html`，只修改标题、一句任务和指标卡以下内容。先写关键差异，再写具体过程和可展开证据。保留三张卡的数字、单位和缺测文本。若没有实物，明确写缺测或示意，不制造视觉观察。

### Turn 4：审阅与交付

审阅首屏实际呈现：任务、模型、三张卡和关键差异是否一眼可见；指标是否与 facts 一致；关键差异是否被长文推下去；交付物和缺测是否诚实；链接是否稳定。若 Host 提供 rendered preview 或 screenshot，必须按实际画面检查；没有则不得声称完成视觉检查。只在有实际问题时修改，最后按现有 Comparison envelope 返回。

## 实施阶段

### 阶段 1：统一指标投影

1. 盘点历史 Codex JSONL、候选 runtime usage、cost 和时间事件的真实字段。
2. 为 baseline/candidate 实现同一套确定性聚合 helper。
3. 更新 `ComparisonReportFactsSchema`、`briefingComparisonContext`、TUI 投影和报告壳数据注入。
4. 增加测试：多轮累计、最后一轮不能代表全量、缺失值、cache 语义、baseline 无成本。

### 阶段 2：保留真实交付物

1. 在 cleanup 前捕获候选交付物和媒体 artifact。
2. 扩展 `comparisonLinks()` 为完整交付索引，保留 0 字节/cleared 状态。
3. 为 artifact 建立稳定 attempt-relative href，发布后仍可读取。
4. 增加 PPTX/PNG/HTML 清理前后和历史 cwd 不变场景测试。

### 阶段 3：固定报告壳

1. Host 在第三轮前生成三卡壳。
2. 只允许 Agent 修改 title/task/body slots；禁止改 `data-host="metrics"`。
3. 发布前解析或稳定检查三卡 DOM、数值和单位未被修改。
4. 将 `.local` 原型变成实现参考，不把 CSS 原样硬编码进业务逻辑。

### 阶段 4：Agent 资料与 Prompt

1. 首包只放任务、导航、Host facts 摘要和可观察入口。
2. 更新 System Prompt 和四轮 prompt，明确关键差异优先和缺测纪律。
3. 向第三轮提供壳路径和 slot 规则；向第四轮提供实际可用的 preview 能力或明确不可观察。
4. 保留一个 Session、四个固定委托和通用 Host loop。

### 阶段 5：审阅与发布

1. 若已有浏览器/渲染能力可复用，为第四轮提供 report 首屏 preview；不要为 Comparison 另造渲染平台。
2. Host 只检查 DOM 壳、指标一致、路径/证据归属、文件可读、报告存在和发布稳定性。
3. 不用固定章节、审美评分或模型自述替代真实事实。
4. 失败不覆盖旧成功报告；释放 Session 和 attempt 资源。

### 阶段 6：删除旧路径

删除或迁移：最后一次 usage 取值、TUI/Comparison 分裂计算、Controller satisfied 指标卡、仅索引终态文本的 links、cleanup 后才捕获媒体、强制逐轮配对和把全过程铺在首屏的 prompt。

## 测试与验收

- `reportFacts` 的 baseline/candidate 时间、token、费用由同一 helper 生成，TUI 与 HTML 数字一致。
- 三张卡固定存在，Agent 无法修改数字、单位或缺测文本。
- 首屏包含标题、一句任务、三张卡和关键差异；逐轮过程不占据关键差异之前的主要空间。
- 清理前的 PPTX/PNG/HTML 能被 Comparison 读取或明确标记为不可用；0 字节不被当作成品。
- 没有视觉媒体时报告使用缺测/示意，不声称视觉验证通过。
- `comparison-links.json` 包含实际交付物和稳定 href，不把大 host trace 作为默认分享素材。
- 第四轮只在收到实际渲染预览时声称检查首屏；没有预览则保留限制。
- 报告失败不覆盖旧成功报告，取消和资源清理仍有效。
- 真实模型 lane 与确定性合同测试分开；默认验证不产生外部费用。

修改源码后先 `npm run build`，测试读取 `dist/`；完成相关代码批次后运行 `npm run check`。纯文档修改运行 `npm run verify:docs`。

## 交付给实施 Agent 的检查顺序

先读本计划、`docs/.local/2026-09-10-comparison-report-visual-retro.md`、`src/agents/comparison-agent.ts`、`src/application/comparison-briefing.ts`、`src/application/comparison.ts`、`src/core/comparison-schema.ts` 和 cleanup/snapshot 代码；然后画出一次真实 attempt 的数据流。每阶段只做本阶段范围内的最小修改，完成条件必须有测试输出和 diff 证据。
