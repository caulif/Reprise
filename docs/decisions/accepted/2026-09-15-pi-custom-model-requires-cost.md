# 决策：Pi 自定义模型必须带 cost

状态：accepted
日期：2026-09-15

替代 [操作者覆盖](../archive/accepted-2026-09/2026-09-14-comparison-operator-pricing-override.md) 中「自定义 Pi 模型不注册 `cost`」一条。该记录的操作者覆盖文件、全 0 须 `free: true`、以及 Comparison 不计 Pi 账单仍有效。

## 问题

Pi `@earendil-works/pi-ai` 0.84.1 的 `calculateCost` 执行 `model.cost.tiers`，`cost` 缺失时流式调用在首条可见回复后崩溃（`Cannot read properties of undefined (reading 'tiers')`）。省略该字段无法作为「未知价格」的运行时表示。

## 决定

自定义 openai-compatible 模型在 `modelsForConfig` 始终注册 `ModelCost` 四类费率。Reprise 没有面向 Pi 的标价时四类为 0，只满足 Pi 流式账单计算。Comparison 费用仍只走 Host 解析器，不把 Pi 的零 `cost` 当成已配置免费。

## 备选方案

**继续省略 `cost`。** 真实 Comparison 会话在第一轮工具之前崩溃。

**封装或分叉 `calculateCost`。** 与上游 Pi 行为分叉，每个小版本都要跟。

## 影响

Pi 内部 `usage.cost` 可能为 0。报告费用卡与 `pricingStatus` 仍由 Host 覆盖 / 快照决定。夹具里的 `cost: 0` 继续只服务测试。

## 验证

`test/application/pi-model-caller.test.ts`：注册模型带四类 0 费率；读取 `cost.tiers` 不抛错。省略 `cost` 则该用例失败。Comparison 不计 Pi 账单的既有用例仍通过。`npm run check` 必须通过。
