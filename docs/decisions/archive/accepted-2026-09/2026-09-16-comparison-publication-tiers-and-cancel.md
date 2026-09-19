# 决策：Comparison 发布合同/版式分级与 cancel(attemptId)

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-16

## 问题

发布校验把版式、措辞与合同混成同一条 fail-closed：缺 headline、词表「已核验」、单侧图、分享卡 `<strong>` 都拒发。读者拿不到对照卡，写卡模型也不知道 Host 其实能修。`ComparisonAgentPort.cancel` 可省略 `attemptId` 并取消全部 Session，与「一次 attempt 一个 Session」冲突，也无法在不承诺双实验产品测试的前提下隔离取消。

## 决定

发布分成两级。合同失败才拒发并写 `comparison-failure.html`；版式/措辞由 Host 确定修则修，修不了则在已有 `data-agent-zone="limitations"` 内追加 `data-host-limitation`，**仍发布**成功 `report.html`。Host limitations 文案只从 [`comparison-report-strings.ts`](../../../../src/application/comparison-report-strings.ts) 取。

**合同拒发：** `hostZonesMismatch` / `hostMetricsMismatch`；`missingComparisonSlots`（含壳必填 slot、组件模板、分享卡 DOM 顺序、delivery/limitations 出现在 metrics 之前）；未知 `data-agent-zone`；`data-claim="verified"` 无任何可解析 `data-evidence-ref`；`data-claim="visual"` 无任何可用 `data-media-ref`；`rewritePublishableHtml` 剥外链后 `hasExternalNetwork` 仍为真。

**自修或 limitations 仍发布：** 缺 headline（有信封则写入 slot，否则 limitations「主要结论缺失」）；空 `key-differences` 写入「无法判断」；首屏内部 id/路径能剥则剥，剥不掉或「第 N 轮」过多则 limitations；分享卡 `<strong>` / 下划线 / `<u>` / 价格摘要 / 本卡由 / 历史侧·候选侧 / 缺 Host 标签能修则修，否则 limitations；词表「已核验 / verified」三条降级 limitations（合同只认 `data-claim`）；词表声称视觉检查而无媒体 → limitations；引用媒体全部 unresolved → 已有 Host 未解析标记再写 limitations；首屏图未成对 → 去掉不成对 `<img>` 并写 limitations。

`ComparisonAgentPort.cancel(attemptId)` 必填。无 `attemptId` 不得取消全部 Session；空字符串抛错。实验 `cancel()` 只对已登记的本次 attempt 调用。不承诺单进程双实验产品测试。

替代 [卡面图片必须成对](./2026-09-16-comparison-paired-visual-only.md) 中「发布时不成对则 `report_incomplete`」的条款；Agent 仍须不成对则 `visual-evidence` 留空。词表兜底不再拒发，见 [提示词分层与 data-claim](./2026-09-15-comparison-prompt-layers-and-data-claim.md) 的合同属性检查仍有效。

## 备选方案

**全部 fail-closed。** 版式噪音变成对照失败，已有成功报告无法被这次 attempt 更新，读者只看到失败页。

**Host 静默自修且不写 limitations。** 写卡模型看不到规则被改写，下次继续贴单侧图或写「已核验」。

**保留 cancel-all。** 无法按 attempt 隔离，且暗示 Host 同时跑多个 Comparison Session。

## 影响

[`verifyAndRenderComparisonReport`](../../../../src/application/comparison-publication.ts)、[`ComparisonAgentPort`](../../../../src/agents/comparison-agent.ts)、[对照模块](../../../architecture/evidence-and-comparison.md)。不改 Comparison resume，不改四轮模型语义，不做双实验并发产品测试。

## 验证

`test/application/comparison-publication-tiers.test.ts`：任一条版式单独失败仍返回成功 html（可含 `data-host-limitation`）；合同失败（Host 区被改、未知 zone、`data-claim` 无引用、剥外链后仍有外链）返回 failure。`test/application/comparison-publication.test.ts`：空 headline/对照、过程复述、词表视觉、分享卡版式、单侧图改为仍发布。空 `cancel("")` 抛错；`cancel("attempt-a")` 不取消 `attempt-b`。`npm run check` 必须通过。反向：版式失败仍拒发则红；合同失败仍发布则红；无 attemptId 的取消全部入口不得存在。
