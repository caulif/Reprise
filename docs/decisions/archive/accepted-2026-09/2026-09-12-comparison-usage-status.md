# 决策：Comparison usage 三态与价格表出处

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-12

## 问题

对照指标在缺测时省略 `usageStatus`，报告读者无法区分「未采集」与「采集了但无法合计」。费用数字也没有固定价格表版本，工具调用成本是否计入不明确。

## 决定

`reportFacts.metrics` 双侧始终投影。`usageStatus` 为 `collected`（可合计 token）、`not_collected`（无 `tokenUsage` 也无 `costUsd`）、`unknown`（出现了 usage 或费用对象但无法得到 token 合计，含「有费用无 token」）。缺失数字仍不写成 0。本轮仍由 Host 从 inspection 形状推断，不要求 Provider 另报采集状态。

有费用数字时写 `pricingVersion`，取值 `MODEL_PRICING_TABLE_VERSION`。`toolCostsIncluded` 固定为 `false`：当前算法只含模型 token 单价，不含工具调用成本。`provider` 为来源/候选 `productId`。采集时间能从历史事件时间戳或 `RunRecord.attempt.createdAt` 得到时写入 `collectedAt`。

Host 指标壳在数字卡外注明费用不含工具成本及价格表版本。卡上缺测仍显示「未采集」。

## 备选方案

**缺测就省略整个 metrics 侧。** 无法表达三态。

**缺测写成 0。** 与指标壳「不用 0 填缺测」冲突。

## 影响

`MetricSideSchema` 增加可选 `provider` 与 `toolCostsIncluded`。旧报告没有这些字段仍可按 schema 读取。费用卡把价格缺失显示成「价格未配置」的范围见 [首屏清晰度与审阅改页](./2026-09-14-comparison-report-clarity-and-review.md)。

## 验证

`test/application/comparison-report.test.ts`：无 usage 为 `not_collected`；空 `tokenUsage` 或仅有 `costUsd` 为 `unknown`；有合计为 `collected` 且 `toolCostsIncluded=false`；指标壳含价格表版本与「费用不含工具调用成本」。反向：缺测不得再断言整个 `metrics` 为 `undefined`。
