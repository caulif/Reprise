# 决策：Comparison 价格快照与模型 ID 清洗

状态：accepted
日期：2026-09-14

## 问题

对照报告能采集 Token，但费用卡对 `gpt-5.5`、`gpt-5.6-terra`、`MiniMax-M3` 一类真实 ID 显示「价格未配置」。查找只做完整字符串精确命中，且手写表只有少数 gpt-5 / Claude 行。9-14 只拆开空态文案，不重做目录。

## 决定

费用仍由 Host 用四类 Token 分项计算。查找前用与 cc-switch `clean_model_id_for_pricing` 相同的规则清洗模型 ID：取最后一个 `/` 之后、丢掉 `:` 后缀、`@` 换成 `-`、转小写、去掉 `[1m]`。再查显式别名，最后查仓库内钉住的 `pricing-catalog.json`。目录 version 写入 `MODEL_PRICING_TABLE_VERSION` 与有费用侧的 `pricingVersion`。命中时投影 `pricingModelId` 与 `pricingSource`。打开已发布报告不重算。对照运行不访问网络，不读本机 cc-switch 数据库。Claude Code 网关角色映射不参与计价。禁止把同系列 SKU 互相借用（`gpt-5.5` 不得使用 `gpt-5` 单价，`MiniMax-M3` 不得使用 Sonnet 单价）。日期后缀未单独登记则保持无价格。非法费率记 `pricingStatus=unknown`。费用卡缺失文案不折行。

## 备选方案

**继续只做精确字符串命中。** 真实网关 ID 永远对不上目录。

**运行时读 `~/.cc-switch` 或 models.dev。** 报告不可复现，且本机覆盖文件经常是空数组。

**用 Claude 角色槽给 MiniMax 定价。** 把网关路由当成账单身份。

## 影响

替代 [指标壳](./2026-09-11-comparison-host-metrics-shell.md) 中「内嵌少数单价行、精确键查找」的范围；Token 聚合、三态空文案、Agent 不改 Host 指标仍有效。目录更新是显式动作：改 JSON、改 version、补测试。操作者覆盖、证据区费率与 Pi 未知价格不写零见 [操作者覆盖](./2026-09-14-comparison-operator-pricing-override.md)。

## 验证

`test/application/model-pricing.test.ts`：清洗规则；`gpt-5.5` 不等于 `gpt-5`；`MiniMax-M3` 不是 Sonnet；带厂商前缀的 `deepseek-v4-flash` 命中；`deepseek-v4.1-flash` 与带日期的 Sonnet ID 无价格；N7/N1 分项能算出金额；费用卡 CSS `nowrap`。`test/application/session-usage.test.ts`：未知模型仍无费用。反向：把 `gpt-5.5` 映射到 `gpt-5`、把 MiniMax 映射到 Sonnet、对照运行读 `~/.cc-switch` 则红。`npm run check` 必须通过。
