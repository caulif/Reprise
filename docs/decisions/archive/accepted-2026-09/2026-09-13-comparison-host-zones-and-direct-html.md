# 决策：Comparison 直接编辑 HTML 与 Host 区域保护

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-13

## 问题

若把 `report-model.json` 当作发布真源、由 Host 再渲染整页，Agent 不再是报告内容作者；若仍允许改写整页，模型改 metrics、证据 ID 或最终 JSON 又会毁掉一次比较。需要在同一 Session、四轮委托内收紧 Host 边界，而不引入 ReportDraft、额外 Agent 或 HTML AST。

## 决定

Agent 继续直接编辑 Host 预写的 `report.html`。模板用 `data-host-zone`（style、header、status、metrics、cost-note、evidence、process）与 `data-agent-zone`（key-differences、visual-evidence、delivery、limitations）划分所有权。Agent 只填写 Agent 区域；不得删除、移动或修改 Host 区域。

Host 写模板时保存 Host 区域快照。compose 后 Host 用与发布相同的区域抽取比较；若 Host 区域变化，同一 Session 追加一次修正委托；仍不一致则失败码 `host_zone_modified`，不把该失败写成模型分析错误。最后一轮禁用工具，只交薄信封。发布成功页就是 Agent 写完并由 Host 改写短引用后的 HTML，不用 Report Model 覆盖页面。`report-model.json` 只作审计摘录。

证据与媒体使用 briefing 短名 `ev-01`、`media-01`。HTML 用 `data-evidence-ref` / `data-media-ref`。发布时 Host 换成可访问 href/src。未知引用去掉链接或破图，保留文字，并在 Host 证据区标记「证据未解析」；单个坏引用不让整次比较失败。仅当正文声称已核验且相关证据全部无效时才用 `evidence_unresolved`。

Agent 审阅信封只有 `status`、`evidenceRefs`（短名）、可选 `headline`。Host 固定补 `reportPath: "report.html"`。JSON 无法解析时保留已写页面，只要求再交合法对象；仍失败则 `invalid_envelope`，不丢稿。其他失败码：`media_unavailable`、`report_incomplete`、`publication_failed`。529 仍是 Provider，不进入本协议。可见 status 卡与审阅轮禁用工具的范围见 [首屏清晰度与审阅改页](./2026-09-14-comparison-report-clarity-and-review.md)。

## 备选方案

**Host 按 Report Model 重渲染后再发布。** 审阅稿与读者页不一致，并否定 Agent 对关键差异版式的作者身份。

**新增 ReportDraft、渲染 Agent 或 HTML AST。** 超过当前四轮单 Session 的复杂度，且不能消除模型写坏 Host 事实的问题。

**未知引用或 invalid JSON 直接 `invalid_output` 并丢页。** 把协议噪音变成整次比较失败。

## 影响

本决定替代 [报告模型与 Host 模板](../superseded/2026-09-13-comparison-report-model-and-host-template.md) 中「核心协议是 Host 确定性再渲染、破图或未知引用即不发布」的范围。指标投影、媒体 catalog、`session-usage.ts` 费用与共用诊断外壳仍有效。薄信封不再要求 Agent 提交 `reportPath` 或 `mediaRefs`。指标壳见 [usage 三态](./2026-09-12-comparison-usage-status.md) 与 [指标壳](./2026-09-11-comparison-host-metrics-shell.md)。

## 验证

`test/application/comparison-publication.test.ts`：Host 区域删除、移动、改值失败；未知 evidence/media 降级发布；破图被去掉而不作为成功破图页。`test/application/comparison-report.test.ts`：invalid JSON 保留已写 `report.html`。`test/snapshots/comparison-system-prompt.txt` 含 `data-host-zone` / `data-agent-zone`。`npm run check` 必须通过。反向：改 Host metrics 仍不得作为成功报告发布。
