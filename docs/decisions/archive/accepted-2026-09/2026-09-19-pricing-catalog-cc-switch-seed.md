# 决策：价格目录同步 cc-switch 种子表

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-19

## 问题

钉住的 `pricing-catalog.json` 只有约 13 行（`2026-09-16-models-dev-snapshot`）。对照报告对主流网关 ID（尤其 `deepseek/deepseek-v4.1-flash`）显示价格未配置。V4.1 与 V4 不得互借单价，因此不能靠别名把 v4.1 接到 `deepseek-v4-flash`。

## 决定

目录 `version` 为 `2026-09-19-cc-switch-seed`。内容复制 [cc-switch](https://github.com/farion1231/cc-switch) `main` 上 `src-tauri/src/database/schema.rs` 的 `seed_model_pricing`（2026-09-19 拉取），`source` 为 `cc-switch-seed`。对照运行仍不访问网络、不读本机 `~/.cc-switch`。

另登记网关常用裸 ID，费率取自同一张种子表的对应行，不发明单价：`deepseek-v4.1-flash`（与种子表 `deepseek-flash` 的 V4.1 Flash **高峰档** 0.3 / 1.2 / 0.006 / 0 相同，因为官方价页写明 V4.1 Flash 按该档计费；cc-switch 明确录高峰档而非 models.dev 空闲档）、`claude-sonnet-4-5`、`claude-haiku-4-5`、`claude-opus-4-5`、`claude-opus-4-1`、`claude-opus-4`、`claude-sonnet-4`。`deepseek-v4.1-flash` 是独立行，不是 `deepseek-v4-flash` 的别名。已登记的日期后缀行可以命中；未登记日期后缀仍 `miss`。`deepseek-flash` → `deepseek-v4-flash` 的既有别名保留。

## 备选方案

**继续 13 行 models.dev 快照。** 网关 ID 大量 miss，用户痛点不消失。

**把 `deepseek-v4.1-flash` 别名到 `deepseek-v4-flash`。** 与 [2026-09-14 价格快照](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md) 冲突；V4.1 与 V4 不得互借。

**运行时读 `~/.cc-switch` 或 models.dev。** 报告不可复现；本机覆盖常为空。

**按 models.dev 空闲档改 DeepSeek 费率。** 与 cc-switch 种子表口径不一致（高峰档是其挂牌基准）。

## 影响

补充 [2026-09-14 价格快照](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md) 与 [2026-09-16 astra](./2026-09-16-pricing-astra-and-1m-alias.md) 的目录内容；清洗规则、覆盖优先、同系列不互借、不联网仍有效。已发布报告不重算。现行查找语义见对照专题。

## 验证

`test/application/model-pricing.test.ts`：目录 version 为 `2026-09-19-cc-switch-seed`；行数远大于 13；`deepseek/deepseek-v4.1-flash` 命中且 `pricingModelId` 为 `deepseek-v4.1-flash`；费率等于种子表 V4.1 Flash 高峰档且不经 v4 别名；`gpt-5.6-luna`、已登记的 `claude-sonnet-4-5-20250929` 命中；未登记日期与未知 ID 仍 miss。反向：v4.1 借用 v4 行或目录缩回十余行则红。`npm run check` 必须通过。
