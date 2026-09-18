# 决策：Comparison 报告模型、Host 模板与发布校验

状态：superseded
日期：2026-09-13

替代：[直接编辑 HTML 与 Host 区域](../accepted-2026-09/2026-09-13-comparison-host-zones-and-direct-html.md)

## 问题

对照报告若只固定指标卡、把其余页面交给 Agent 整段发明，首屏无法稳定呈现任务、状态、指标和差异；费用可能在投影中丢失；输入图片会在发布复制后破图；失败页只有一句 Comparison unavailable。HTML 不应成为核心协议。

## 决定

继续一次比较一个 Comparison Session、同一 attempt 内顺序四轮（理解、调查、创作、审阅）。不新增分析、渲染或媒体 Agent。

核心协议是可复原的比较事实、Agent 对差异的判断，以及 Host 对最终报告的确定性渲染。Host 在创作轮前写入完整 `report.html` 模板：固定首屏顺序为任务、`data-host="status"`、`data-host="metrics"`、`data-slot="key-differences"`，并提供 delivery、limitations、evidence、process、visual-evidence 插槽与组件 CSS。Agent 只填充插槽，不重写整页 CSS，不修改 status/metrics。关键差异的数量、排序和组件组合由 Agent 根据证据决定，不固定为三条。

同一 attempt 产出 `report-model.json`（schemaVersion 1）：任务说明、双方状态、插槽 HTML、交付判断、限制、evidence refs、media refs、可选 headline。Host 按该模型与 `reportFacts` 重新渲染后再发布，因此同一组比较事实可以重新得到一致报告。Agent 改文字不能改变 Host 指标和状态；改过则 attempt 失败，不发布。

费用继续用 `session-usage.ts` 与 cc-switch 语义从 Token 分项计算，不为 Comparison 另维护 usage 字段。有完整 Token 和可识别模型就必须有费用；「未采集」只表示上游没有 Token。费用不含工具调用成本，并记录价格表版本。

Host 注册媒体，写入 `briefing/facts/media.json`，把可用图片复制到 attempt `media/`，发布时复制到实验根 `media/`。Agent 只能引用已提供的 `reportHref`。创作/审阅轮检查引用；发布前若图片无法访问，不得发布成功报告。Comparison 在存在已注册可用图片时允许 `read(format=image)`，不新增截图工具。

成功页与诊断页共用同一视觉外壳。失败必须区分类别：provider（含 529）、protocol（invalid JSON）、evidence（unknown evidence ref）、metrics（Host 指标或状态被改）、media（破图或未注册引用）、publication、cancelled。诊断页说明候选任务是否完成、Comparison 失败阶段，以及 trace / artifact / 草稿入口。

## 备选方案

**继续只固定指标卡、Agent 发明卡下整页。** 无法保证首屏结构、媒体闭合和失败分类。

**发布时静默改回指标而不失败。** 审阅轮看到的页面与读者不一致。

**为 PPT/网页增加截图 Agent。** 当前工具已能读已物化预览；缺预览时不假装看过。等真实任务反复缺预览再评估 Host 预览能力。

## 影响

薄信封仍含 `status`、`reportPath: "report.html"`、`evidenceRefs`、可选 `headline` / `limitationCodes`，并增加可选 `mediaRefs`。失败仍不覆盖已发布成功 `report.html`。指标算法仍见 [usage 三态](../accepted-2026-09/2026-09-12-comparison-usage-status.md) 与 [指标壳](../accepted-2026-09/2026-09-11-comparison-host-metrics-shell.md)；本决定替代指标壳中「Agent 在卡下追加整页正文、Host 不解析页面结构」的范围。

## 验证

`test/application/comparison-report.test.ts` 与 `test/application/comparison-publication.test.ts`：模板含固定插槽；改 metrics/status 失败；破图不发布；同一模型两次渲染一致；失败分类可区分 provider / protocol / evidence / metrics / media。`test/snapshots/comparison-system-prompt.txt` 含模板原则与摘要隐私引导。`npm run check` 必须通过。反向：缺少 `data-slot="key-differences"` 或 `img` 指向未注册路径不得作为成功报告发布。
