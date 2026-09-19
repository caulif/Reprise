# 决策：Comparison 十秒卡面与写卡算子身份

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-15

## 问题

可分享卡已经把模型 ID 放进标题，但仍把 delivery / limitations 铺在 `.share` 内，headline 落在对照长文之后。读者十秒内得不到结论。持久化重比时 `models.comparison` 抄自 Candidate Run 的旧 Comparison 配置，页上又不显示写卡算子，读者会把 vs 行里的候选当成当前 Harness。

## 决定

vs 标题与指标列名只使用历史模型与候选模型。本次 Comparison Session 的 Harness 模型写入 `reportFacts.models.comparison`，由 Host 在 header 印一行「本卡由 {model} 写出」；缺 ID 则省略。该字段取当前 `agentConfig` / `comparisonAgentConfig`，不读 RunRecord `manifest.comparison`。

可分享卡 DOM 顺序为：header（含算子行）→ headline → `key-differences` → `visual-evidence` → metrics。`delivery` 与 `limitations` 只出现在卡下折叠的 `.audit` 内。任务句允许换行。发布失败：headline 位于对照之后，或 delivery / limitations 出现在 metrics 之前。

历史成品图只从实验目录内已封存路径（`environment/baselines`、`controller-briefing/history`）拷进 attempt `history/media/`，进入 `media.json` 的 baseline 侧。对照过程不打开实验外活 cwd。媒体文件名若已含扩展名则不再拼接。

## 备选方案

**继续从 RunRecord 读取 comparison 模型。** 持久化重比后页上的写卡身份永远过期。

**把写卡算子写进 vs 行。** 读者会以为 DeepSeek 替换了候选。

**Host 按审美限制字数。** 超出当前 Host 合同；卡面密度由骨架校验与 prompt 约束。

## 影响

本决定替代 [可分享卡版式](./2026-09-14-comparison-share-card-layout.md) 中「四个 Agent 区平铺在 header 与 metrics 之间」和「headline 在对照区之后」的范围。Host 数字、短引用、无可见 status 卡、失败不覆盖成功报告仍有效。`gpt-5.6-sol` 进入钉住价格目录，不得借用 terra 单价。

## 验证

`test/application/comparison-publication.test.ts`：header < headline < key-differences < metrics；delivery 插回 header 后发布失败；`comparisonModel: deepseek-flash` 出现在算子行且不进入 vs。`test/application/comparison-tracks.test.ts`：封存 baseline PNG 进入 media 且 href 无 `.png.png`。`test/application/model-pricing.test.ts`：`gpt-5.6-sol` 命中且费率不等于 terra；`gpt-5.6-luna` 仍 miss。反向：旧顺序或 share 内 delivery 仍能发布则红。`npm run check` 必须通过。
