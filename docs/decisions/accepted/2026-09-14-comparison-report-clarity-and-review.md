# 决策：Comparison 报告首屏清晰度与审阅轮改页

状态：accepted
日期：2026-09-14

## 问题

Host 模板把历史证据状态、候选 outcome 和 Controller 终止码放在首屏，费用把 Token 缺失与价格缺失都写成「未采集」，组件只有 CSS 选择器，审阅轮不能读改 `report.html`。读者看到的是调查材料，而不是任务、结论、指标和关键差异。

## 决定

同一 Comparison Session 仍是理解、调查、创作、审阅四轮。Host 模板首屏顺序为任务、`data-agent-slot="headline"`、时间 / Token / 费用、`data-agent-zone="key-differences"`。双方运行状态写入 `report-model.json`、`comparison.json` 和详细证据区，不渲染可见 status 卡。`data-host-zone` 为 style、header、metrics、cost-note、evidence、process。header 内 headline 插槽由 Agent 填写，Host 区域快照忽略该插槽正文。

Host 在 `report.html` 放置隐藏 `<template data-component-template>` 原型。Agent 复制后填入 Agent 区域；不适用的组件省略。关键差异的数量与形式由 Agent 决定，Host 不固定三条。

费用卡消费 `pricingStatus`：无 Token 为「未采集」，有 Token 无价格为「价格未配置」，口径冲突为「不可计算」，已计算则显示金额。价格来源仍由 Host 投影，不在本决定重做目录。

审阅轮允许读取并修改 `report.html` 的 Agent 区域与 headline 插槽，最后一条消息只交薄信封：`status`、`headline`、短名 `evidenceRefs`。JSON 无法解析时保留已写页面，再进行一次禁用工具的 JSON 补救；仍失败则 `invalid_envelope`。Host 在发布前检查 Host 区域、指标、headline 与关键差异是否存在、证据/媒体引用、首屏是否泄漏内部运行标识，以及无可用媒体时不得声称已完成视觉检查。

## 备选方案

**继续在首屏展示 status 卡。** 把 `apparently_completed` 和历史证据不足误读成任务结论或能力强弱。

**审阅轮继续禁用工具、只交 JSON。** 无法压缩页面、修复破图或组件。

**Host 固定三条差异或固定表格。** 与任务无关的空组件会再次把笔记填满首屏。

## 影响

本决定替代 [Host 区域与直接 HTML](./2026-09-13-comparison-host-zones-and-direct-html.md) 中「可见 status 区」和「最后一轮禁用工具」的范围；短引用、直接 HTML 发布和 `report-model.json` 只作审计仍有效。费用展示语义补充 [usage 三态](./2026-09-12-comparison-usage-status.md)；价格目录见 [价格快照与 ID 清洗](./2026-09-14-comparison-pricing-snapshot-and-id-cleaning.md)。仍只有一个 Comparison Session 和四个 turn。可分享卡阅读顺序、模型列名与 headline 位置见[可分享卡版式](./2026-09-14-comparison-share-card-layout.md)；本决定中「指标在关键差异之前」和「headline 在 header 内」不再作为当前规则。

## 验证

`test/application/comparison-publication.test.ts`：无可见 status 卡；headline 不破坏 Host 快照；空 headline / 空关键差异失败；九轮过程进首屏失败；无媒体却声称看过 PPT 失败。`test/application/comparison-report.test.ts`：compose/review Prompt；费用三态文案；invalid JSON 保留页面。`test/application/comparison-agent-phases.test.ts`：审阅轮可读写 `report.html`。`test/snapshots/comparison-system-prompt.txt` 含组件原型原则与审阅改页。反向：改 Host metrics、删除组件原型、审阅 Prompt 再写「已禁用工具」则红。`npm run check` 必须通过。
