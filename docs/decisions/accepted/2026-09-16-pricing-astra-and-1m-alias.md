# 决策：gpt-6-astra 单价与 `[1m]` 别名

状态：accepted
日期：2026-09-16

## 问题

N6 费用卡两侧均为「价格未配置」：Token 已采集，钉住目录没有 `gpt-6-astra`；候选 ID 清洗后是 `deepseek-flash`，目录只有 `deepseek-v4-flash`。`[1m]` 后缀表示同一模型的长上下文档，不是另一条 SKU。

## 决定

目录 `version` 为 `2026-09-16-models-dev-snapshot`。增加 `gpt-6-astra` 行：input 10、output 50、cacheRead 1、cacheCreation 12.50（USD / 百万 token）。禁止借用 `gpt-5.6-*` 或 `gpt-5` 单价。`deepseek-flash` 显式别名指向 `deepseek-v4-flash` 同一费率行。查找前仍去掉 `[1m]`，因此 `deepseek-flash[1m]` 与 `gpt-6-astra[1m]` 使用对应清洗后的行。无行时仍 `miss` / `pricing_unavailable`。已发布报告不重算。

## 备选方案

**把 astra 映射到 terra 或 sol。** 账单身份错误。

**把 `[1m]` 当独立 SKU 并写入长上下文翻倍价。** Host 四类单价不含超窗翻倍；与现有清洗规则冲突。

**只在操作者覆盖文件里补这两行。** 默认路径仍然无价格。

## 影响

补充 [价格快照与 ID 清洗](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md) 的目录内容；清洗规则、覆盖优先、同系列不互借仍有效。V4.1 与 V4 仍不得互借。

## 验证

`test/application/model-pricing.test.ts`：`gpt-6-astra` 命中且费率不等于 terra/sol；`deepseek-flash` 与 `deepseek-flash[1m]` 同费率；无 `gpt-6-luna` 仍 miss。反向：astra 使用 terra 单价、或 `[1m]` 找不到基价则红。`npm run check` 必须通过。
