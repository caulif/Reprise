# 决策：Comparison 操作者价格覆盖、证据费率与 Pi 零价

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-14

「自定义 Pi 模型不注册 `cost`」由 [Pi 自定义模型必须带 cost](../../accepted/2026-09-15-pi-custom-model-requires-cost.md) 替代。操作者覆盖与 Comparison 不计 Pi 账单仍有效。

## 问题

钉住的仓库快照不能覆盖本机私有或免费模型。详细证据只写清洗 ID、来源和 version，读者看不到四类单价。自定义 openai-compatible 在 Pi 注册时写入 `cost: 0`，看起来像已配置免费。

## 决定

操作者覆盖文件为 `{dataDir}/model-pricing.override.json`，Git 忽略（落在 `.reprise*/`）。对照运行优先于仓库快照读取该文件：先 `(productId, 清洗后 modelId)`，再单独清洗 ID。密钥不得进入该文件。文件不存在则只用快照。文件损坏或 schema 失败时 Runner 不崩溃，该次查找记 `pricingStatus=unknown`。覆盖行四类费率全为 0 且未声明 `free: true` 时视为未配置价格，不回落到快照，也不显示 `$0.00`。只有 `free: true` 才允许零费率账单。

命中时 Host 把四类单价写入 `pricingRates`，详细证据列出 input / output / cacheRead / cacheCreation。费用卡仍只显示金额或空态。打开已发布报告不重算。

自定义 Pi 模型向 Pi 注册 `cost` 的契约见 [Pi 自定义模型必须带 cost](../../accepted/2026-09-15-pi-custom-model-requires-cost.md)。Comparison 费用只走 Host 解析器，不读 Pi usage cost。夹具里的 `cost: 0` 仍只服务测试。

## 备选方案

**覆盖失败时静默回落快照。** 操作者无法发现坏文件。选择损坏即 unknown。

**全 0 覆盖当成免费。** 与「未知价格不是 $0.00」冲突。选择显式 `free`。

**继续给 Pi 写零价以满足类型。** 运行时账单会把未知模型显示为免费。选择不写该字段。

## 影响

补充 [价格快照与 ID 清洗](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md)。清洗规则、快照、禁止同系列借用、不读 cc-switch、不联网仍有效。

## 验证

`test/application/model-pricing.test.ts`：覆盖压过快照；`(productId, id)` 优先于裸 id；全 0 且无 `free` 无费用且不借用快照；`free: true` 允许 0；损坏文件为 unreadable。`test/application/comparison-report.test.ts`：证据区含四类费率。自定义模型的 Pi `cost` 字段见 [Pi 自定义模型必须带 cost](../../accepted/2026-09-15-pi-custom-model-requires-cost.md)。反向：未声明免费的 0 显示 `$0.00` 则红。`npm run check` 必须通过。
