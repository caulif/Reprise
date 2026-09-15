# Comparison 可分享卡：模型对照与首屏版式

本文是下一步实施的目标计划。当前规则仍以 [Comparison 架构](../architecture/comparison.md) 与 [首屏清晰度](../decisions/accepted/2026-09-14-comparison-report-clarity-and-review.md) 为准。可执行 prompt 仍只在 [`src/agents/comparison-agent.ts`](../../src/agents/comparison-agent.ts)；落地后更新该文件与 `test/snapshots/comparison-system-prompt.txt`，不另维护逐字副本。

指标投影、价格三态、Host 区域保护、短引用、四轮单 Session、失败不覆盖成功报告：**不重做**。旧稿 [visual-refactor](./comparison-report-visual-refactor.md) 里已落地的事实层不再列入本计划。

## 问题

Comparison 的职责是同一任务上 **历史模型对回放模型**：左栏原会话交付，右栏候选交付。读者要在约十秒内看出任务、两边是谁、差在哪。

当前壳与 prompt 把这张卡做成调查笔记首页：

- Host 标题写死「对照」，指标列名写 `Baseline` / `Candidate`，`reportFacts.models` 只有候选 / Controller / Comparison，没有历史模型名。读者看到的是角色名，不是 `gpt-5.6-terra` 对 `MiniMax-M3`。
- 首屏顺序被 ADR 钉成：任务 → headline → **指标** → 关键差异。视觉对照被挤到指标下面的 `visual-evidence`，且组件原型 `media-compare` 是单张 figure，没有「左历史 / 右候选」成对标签。
- compose prompt 要求先写 2–4 条差异散文，再考虑媒体。模型容易把同一次历史会话里的 HTML 预览和 PPT 成品当成两边，或把 Pack 名（Codex / Claude Code）当成比较对象。
- 分享区与审计区同页平铺：`cost-note`、证据目录、过程区抢第一屏。

目标卡（产品形态，不是某份本机 HTML 的逐像素复制）：一张纸上的一张卡。标题是 **任务类别一词 + 原模型 + 现模型 + 对比**；下一句是人话任务（无本机路径）；中间按任务放对照（有页就逐页左右看）；一句人话点出差在哪；**时间 / Token / 费用贴在卡底**。不解释排版。

## 目标规则

实施时同批新增 ADR，替代 [首屏清晰度](../decisions/accepted/2026-09-14-comparison-report-clarity-and-review.md) 中「指标在关键差异之前」的范围；Host 保护、审阅改页、无可见 status 卡、关键差异条数不固定仍有效。

1. **比较对象是模型 ID，不是 Pack / Runtime / harness 名。** 历史侧用 `taskCase.sourceRuntimeEvidence.model`（缺失则「历史模型未记录」），候选侧用现有 `reportFacts.models.candidate`。指标卡 `.who` 与标题里的模型名同一套字符串。
2. **可分享卡阅读顺序**：标题 → 一句任务 → Agent 对照区 → 一句差异 → Host 三指标。审计材料（价格口径、路径、媒体目录、运行诊断、过程）一律在卡下 `<details>`，默认折叠。
3. **左右栏语义固定。** 左 = `replayScope.historical` 的用户可见交付；右 = `replayScope.candidate`。禁止把同一侧的中间稿（例如 HTML 预览）和终稿（例如 PPT 导出）标成两个模型。没有可靠成对媒体时，不假装完成视觉对照。
4. **Agent 仍只改 Agent 区域与声明的插槽。** Host 继续写 CSS、指标数字、模型名、证据目录。不把样例 CSS 当成审美门禁。
5. **headline 信封保留。** 页面上一句人话差异与信封 `headline` 同一句；插槽从 header 挪到对照区下方、指标上方，仍是 `data-agent-slot="headline"`。

## 壳与事实

### `reportFacts.models`

在 [`ComparisonReportFacts`](../../src/agents/comparison-agent.ts) 增加 `baseline?: string`。由 [`buildReportFacts`](../../src/application/comparison.ts) 写入 `sourceRuntimeEvidence.model`。briefing `facts/context.json` 带上该字段。无模型名时指标列名用「历史」/「候选」，不得发明 Codex/Claude 等产品名。

### `renderComparisonReportShell`

[`comparison-report-shell.ts`](../../src/application/comparison-report-shell.ts) 与 [`comparison-html.ts`](../../src/core/comparison-html.ts)：

- 外层一张 `.share` 卡；卡内顺序为 header → Agent 区 → metrics。`HOST_ZONES` 顺序改为 `style, header, metrics, cost-note, evidence, process` 仍可保留数组定义，但 **HTML 出现顺序** 必须变成 header 之后先出现全部 `data-agent-zone`，再出现 `metrics`。`hostZoneIntegrityError` 今日按数组顺序校验 DOM 中 host-zone 出现序，实施时改为：校验集合与内容，不把「metrics 紧跟 header」当作不变量；或把 `HOST_ZONES` 拆成「集合 + 允许的相对位置」。反向用例：再断言 `header < metrics < key-differences` 必须失败。
- header：去掉 kicker `Comparison`。`h1` 由 Host 写成 `{category} · {baselineModel} vs {candidateModel} 对比`。类别一词用 `data-agent-slot="category"`，缺省「对照」。任务句用 `data-agent-slot="task"`（或保留现 `data-slot="task"` 改为 agent 插槽），Host 初值可放 `task.summary` 的单行截断，Agent 改成无路径人话。headline 插槽移出 header，避免结论压在图前。
- 指标卡 `.who` 用模型名，不再写 Baseline/Candidate。`cost-note` 移入证据 `<details>`，不占卡面。
- 组件原型增加成对媒体，替换单张 `media-compare` 的默认用法：

```html
<template data-component-template="pair-pages">
  <div data-component="page-row">
    <div class="cell"><div class="who"></div><img data-media-ref="" alt=""></div>
    <div class="cell"><div class="who"></div><img data-media-ref="" alt=""></div>
  </div>
</template>
```

`.who` 填模型名；`data-media-ref` 必须一侧 history、一侧 candidate。无图任务继续用 `split-compare` / 短段落，省略 `pair-pages`。

- CSS 向样例靠：暖纸、衬线、圆角卡、页行网格、图 `object-fit: contain`、指标三卡在底。具体色值以壳内 CSS 为唯一源，不从本机草图拷贝验收。

### 媒体配对（最小 Host 帮助）

不在 Host 做视觉匹配算法。`facts/media.json` 已有 `side`。调查轮 prompt 要求按 **同类交付** 配对（同页码、同文件角色）。若索引同时出现 HTML 截图与 PPT 截图，工作笔记必须写明何为用户终稿；compose 只用终稿对终稿，或明确「一侧缺终稿」。

不把「HTML 预览 vs 自己的 PPT」写成模型差异。

## Prompt 修改

只改 `COMPARISON_SYSTEM_PROMPT`、`COMPARISON_TURN_PROMPTS`、必要时 `HOST_ZONE_REPAIR_PROMPT`。篇幅短于现状调查纪律段；不把指标公式或 CSS 写进 prompt。

### System Prompt（替换「首屏写给用户」到「组件原型」那几段）

保留：职责、观察/推断、replayScope 四类差异、workspace 路径、短引用、离线、VISIBLE_PROCESS。

写入：

- 你比较的是两个 **模型** 在同一用户任务上的交付。左边永远是历史会话那个模型，右边永远是这次回放那个模型。标题、图注、指标列名都用 `reportFacts.models` 里的模型 ID。禁止用产品名、CLI 名、harness 名代替模型。
- 可分享卡不是调查笔记。读者先看到：类别与两个模型、一句任务、对照、一句差异、卡底三个数。不要解释为什么这样排。不要把路径、runId、attemptId、Pack 名放进卡面。
- 有用户可见成品（页、图、界面）时，对照区优先成对展示，且两边必须是 **同一类终稿**。历史侧的过程稿（设计稿、HTML 预览、未采用导出）不能冒充候选，也不能和历史终稿拆成「两个模型」。看不见的媒体不要写「已看过」。
- 复制 `pair-pages` / `split-compare` 等原型填 Agent 区；不要新建顶层 zone，不要改 Host 区与整页 CSS。

删去或压缩：鼓励「先结论再 2–4 条差异卡片」作为唯一默认；那会把 PPT 页对照挤出第一屏。

### Turn 1 `understand`

在现有「读完用户输入、不评价」之后加：

- 用几个字概括任务类别（例如 PPT、页面、脚本、文档），供标题插槽。写出用户要的 **终稿形态**，并记下过程稿（预览、草稿、未采用导出）不要拿去当对家。
- 拟一句无路径的任务句。本轮仍不写 `report.html`。

### Turn 2 `investigate`

在现有 briefing 入口之后加：

- 从 `facts/media.json` 按 `side` 列出双方可用图。视觉任务：按页或按文件角色配对，写入 `work/comparison-plan.md`：左 ref、右 ref、是否同类终稿、缺哪一侧。
- 计划里写死将填进标题的两个模型 ID（来自 `facts/context.json`）。对不上 ID 就写「未记录」，不要用 Pack 名顶上。
- 候选结论改成一句人话差异（将作为 headline），不要先写四条并列散文大纲。

### Turn 3 `compose`

整段替换目标如下（实施时落成源码字符串）：

```text
打开 Host 已生成的 report.html。

在 category 插槽填任务类别一词。任务插槽改成一句人话，去掉本机路径。
对照区：有成对终稿媒体就复制 pair-pages，左历史模型、右候选模型，逐页或逐个关键画面。
不要把同一模型的预览和终稿左右对放。没有成对图就用短对照或 split-compare，不要空图。
headline 插槽写一句人话差异，放在图下、指标上。不要解释版式，不要把 2–4 条差异卡当作必须填写的骨架。
详细路径和限制放进下方 Host 已提供的 details，不要铺到卡面。

只改 data-agent-zone 与允许的插槽。引用用 data-evidence-ref / data-media-ref。将完整 HTML 写回 report.html。
```

### Turn 4 `review`

检查改成：

- 十秒测试：能否说出任务、左谁右谁、差在哪。
- 左右是否标反、是否拿过程稿冒充对家、是否出现 Pack/harness 名。
- 指标数字未改；模型列名与标题一致。
- 有图则图能加载且 ref 属于正确一侧；无图则正文不得声称看过。
- 卡面没有本机路径。最后一条消息仍只交薄 JSON。

### Host 区域修复

`HOST_ZONE_REPAIR_PROMPT`：说明 headline/category/task 插槽允许保留；metrics 可能位于 Agent 区之后，不要把指标块搬回标题下。

## 文档与测试

同一次变更：

- ADR：首屏顺序、模型列名、headline 位置、成对媒体纪律。
- [`docs/architecture/comparison.md`](../architecture/comparison.md) 首屏顺序与「模型 ID 入壳」各改一句，链到新 ADR。
- 快照：`test/snapshots/comparison-system-prompt.txt`。
- `test/application/comparison-report.test.ts`：compose/review 文案含左右模型与终稿配对；不再要求「先写 2–4 个差异」。
- `test/application/comparison-publication.test.ts`：去掉 `header < metrics < key-differences`；改为 Agent 区在 metrics 之前；指标 `.who` 为模型名；空 category 可用缺省；空 headline / 空对照区仍失败。
- `test/application/comparison.ts` 或 briefing 测试：`models.baseline` 来自 `sourceRuntimeEvidence.model`。
- 反向：把 metrics 插回关键差异之前且测试仍绿，则门禁不够。

审美与真实模型出卡质量不进确定性门禁。改源码后 `npm run build`，相关测试走 `dist/`，批次结束 `npm run check`。只改文档则 `npm run verify:docs`。

## 实施顺序

1. `reportFacts.models.baseline` + 指标列名 + 标题里的模型名（无 prompt 也能先让壳说人话）。
2. 壳 DOM 顺序、`.share` 卡、插槽搬家、`pair-pages` 原型、`HOST_ZONES` 校验语义、更新 publication 测试。
3. 按上文替换四轮 prompt 与 system 段，更新快照与 report 测试。
4. ADR + `comparison.md` 一句同步。

## 不做

- 不增加 Session 或第五轮。
- 不按 Report Model 重渲染整页。
- 不在 Host 做截图匹配或强制三页 PPT 骨架。
- 不把样例页当 CI 像素基线。
- 不改 TUI 实验状态机；TUI 仍只打开已发布 HTML。
- 不重做价格目录与 token 聚合。
