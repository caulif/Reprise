# 决策：对照报告由 Host 重建后发布

状态：accepted

## 问题

Comparison Agent 可以编辑预置的 `report.html`。此前 Host 区一旦被改动，Agent 还需自行恢复并未挂载在工作区的模板快照；恢复失败会阻止已有合法 Agent 内容发布。失败诊断也可能把未经发布校验的草稿正文展示为可信结论。

## 决定

正式发布只取草稿中唯一、完整的 `comparison`、`details` 区与 `headline`、`category` 槽。Host 使用 HTML 解析器确认这些标记的数量、边界和嵌套关系，包括 `<template>` 内容；不明确时拒绝。Agent 区是被动内容，拒绝脚本、`<style>` 与内联 `style` 属性、原生浮层（`dialog` / popover）、SVG/MathML、嵌入文档、事件处理属性和危险 URL。即使不加载外部资源，定位和层叠规则、浏览器原生顶层浮层或 SVG 绘制区域也能遮盖 Host 可信事实；Agent 只能使用 Host 模板提供的 CSS，矢量内容须作为已登记媒体进入报告。任务原文、模型身份、指标、标题、CSS、证据目录、媒体目录及其余 Host 区由本次 attempt 的事实重新生成。Agent 对 Host 区的改动不再消耗模型修复轮，也不会进入正式报告。

重建后的整页仍经过结构、证据、媒体、模型实际可见图片、外部资源与发布校验；任一项失败则本次报告未发布。失败页保留原任务和可读原因，技术详情及未发布草稿路径可供排查。未经完整发布校验的草稿正文不进入结果页或诊断正文。实验根部已有的成功报告及资产只在新报告完成校验后替换。

## 备选方案

**让 Agent 恢复 Host 模板。** 模板快照不在模型工作区，增加一次回合仍无法可靠恢复，也可能遗漏事实区。

**只忽略 Host 指标改动。** 标题、任务、CSS 与证据区仍可被改写，发布边界不完整。

## 影响

- 草稿可自由调整合法 Agent 内容，但不能通过改写 Host HTML 改变确定性事实。
- 缺失、重复、嵌套或无法可靠解析的槽需要修改草稿；Host 不猜测哪一份才是最终内容。
- 故障时保留 attempt 草稿作为本地排查材料，不能将其视作正式比较结论。
- `parse5` 是运行时依赖，用于 HTML 结构提取；不得用正则表达式代替槽边界判断。

## 验证

`test/application/comparison-host-rebuild.test.ts` 覆盖 Host 改写后的重建、非法槽、外部资源、无效引用、大小写/实体/无引号属性及模板内容反例；`test/application/comparison-agent-phases.test.ts` 覆盖不再触发模型恢复轮；报告发布与失败生命周期沿用 `test/application/comparison-publication.test.ts` 及实验回归。
