# 决策：Comparison Agent 直接创作自由 HTML 报告

状态：accepted
日期：2026-08-15

## 背景

此前 Comparison 写入 `comparison.md`，Host 以安全 Markdown renderer 和固定 `report.html` 外壳重组页面。这个路径让 Host 与 Agent 共同成为报告作者，限制了任务特定的布局、SVG、交互和证据呈现。

## 决定

Comparison Agent 通过 `write_comparison_report({ html })` 原样写入实验根目录的 `report.html`。HTML、CSS、SVG 与本地 JavaScript 都由 Agent 选择；Host 不清洗、转义、解析或重排成功报告，也不检查固定 DOM、标题或指标卡。

Host 仍校验薄交付协议：结构化结果信封通过 schema、其 `reportPath` 固定为 `report.html`、文件可读且位于实验目录内。Host 将确定性运行事实以 `reportFacts` 提供给 Agent。首屏是否摊开哪些事实由 [自由报告形式](./2026-09-02-comparison-free-report-form.md) 约束，缺项不构成 Host 内容门禁。

Comparison 调用失败时，Host 写入独立的 `comparison-failure.html` 导航页，不覆盖已存在的 Agent 报告，也不改变 CandidateRun 结果。

## 后果

- 删除 Host Markdown 主路径和固定成功报告模板。
- 报告默认离线可读；Prompt 禁止静默远程加载、网络写操作、表单提交与凭据泄露。
- `comparison-failure.html` 是降级导航，不是成功报告模板。
- 旧的“第一屏由 Host 叙述/题头”决策仅适用于已移除的 Markdown 路径。

## 验证

`test/comparison-report.test.ts` 覆盖 HTML 原样写入、薄信封固定路径、事实投影的缺失语义和证据引用边界；`test/codex-experiment.test.ts` 覆盖成功报告与失败降级页生命周期。
