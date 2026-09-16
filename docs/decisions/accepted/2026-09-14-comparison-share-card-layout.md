# 决策：Comparison 可分享卡以模型对照为首屏

状态：accepted
日期：2026-09-14

## 问题

Host 把指标放在关键差异之前，列名写 Baseline / Candidate，标题写「对照」。Agent 被要求先写 2–4 条差异散文。读者看不到两个模型 ID，也容易把同一侧的 HTML 预览和 PPT 终稿当成两边。

## 决定

可分享卡阅读顺序为：任务类别一词与两个模型 ID 的标题、一句人话任务、Agent 对照区、一句差异（`data-agent-slot="headline"`）、卡底 Host 时间 / Token / 费用。价格口径、路径、媒体目录、运行诊断和过程默认折叠在卡下。

历史模型 ID 来自 `taskCase.sourceRuntimeEvidence.model`，写入 `reportFacts.models.baseline`；候选仍用 `models.candidate`。指标列名与标题使用同一套字符串；缺失时写「历史」或「候选」，不用 Pack / harness 名。

Agent 拥有 `data-agent-slot` 的 category、task、headline，以及既有 Agent 区域。headline 在对照区之前、标题之后。左右栏语义固定：左为历史终稿，右为候选终稿。成对页使用 `pair-pages` 原型。Host 不匹配截图。

Host 区域集合不变。DOM 中 `data-host-zone` 出现顺序仍为 style、header、metrics、cost-note、evidence、process。卡面 Agent 区与折叠审计区的划分见 [十秒比较卡](./2026-09-15-comparison-ten-second-card.md)。发布校验拒绝 metrics 回到关键差异之前。

## 备选方案

**保持指标在标题正下方。** 数字正确，但视觉任务的左右对照被挤出第一屏。

**Host 按文件名自动配对媒体。** 会把预览和终稿错配，且超出当前 Host 合同。

**用 Pack 名当比较对象。** 与真实模型 ID 冲突，无法区分同一 Pack 下的不同模型。

## 影响

本决定替代 [首屏清晰度与审阅改页](./2026-09-14-comparison-report-clarity-and-review.md) 中「指标在关键差异之前」和「headline 在 header 内」的范围；也替代 [指标壳](./2026-09-11-comparison-host-metrics-shell.md) 中「三张卡写 Baseline | Candidate」的可见文案。四轮单 Session、Host 数字、短引用、无可见 status 卡、关键差异条数不固定仍有效。

## 验证

`test/application/comparison-publication.test.ts`：header 后是对照区再是 headline 再是 metrics；旧顺序 `header < metrics < key-differences` 为假；把 metrics 插回 header 后则发布失败。`test/application/comparison-report.test.ts`：`models.baseline` 来自 `sourceRuntimeEvidence.model`；指标 `.who` 为模型 ID；compose 要求 pair-pages 与左右终稿，不再要求先写 2–4 个差异。`test/snapshots/comparison-system-prompt.txt` 含左右模型与终稿纪律。反向：metrics 回到关键差异之前仍能发布则红。`npm run check` 必须通过。
