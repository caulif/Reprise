# 决策：Comparison 报告形式由 Agent 自定，TUI 只用可选 headline

状态：accepted
日期：2026-09-02

## 问题

Comparison 已是 `report.html` 的唯一作者，但 System Prompt 要求在结论附近摊开全部 `reportFacts` 类别，等于用文字目录抵消 HTML 自由。TUI 结果页同时把 Controller `done/satisfied` 的理由当成对照摘要，跳过对照时仍可能让人以为看见了两边的差。

## 决定

System Prompt 的 `# The report` 约束判断纪律、缺测语义（未采集 / 不可判定，禁止用 0 或估价充数）和读者必须能回答的问题，不规定章节、组件或任务类型版式。Agent 按本次 baseline 与 candidate 的差发明形式。

薄信封增加可选 `headline`（1–280 字），供 Host TUI 原样显示一行差。Host 不解析成功 HTML。没有 `headline` 则省略该行。Controller `satisfied` 的 `rationale` 不作为对照结论。对照状态为 `skipped` 时不写「两边都…」，不提供打开报告的 `o`。

## 备选方案

**Host 固定报告壳或按任务类型皮肤。** 会与 Agent 创作 HTML 的决定冲突，且无法覆盖未预见到的交付物。

**从 `report.html` 抽第一句填 TUI。** 把 Host 绑在 Agent 的 DOM 上，报告一变摘要就碎。

**继续用 Controller 满意理由当结果页正文。** 那是停机原因，不是对照。

## 影响

`reportFacts` 仍进入 briefing，供 Agent 选用，不再是首屏必填目录。旧信封无 `headline` 仍合法。成功报告字节仍原样落盘。

## 验证

`test/snapshots/comparison-system-prompt.txt` 含「no required page skeleton」且不含「reportFacts categories」。`test/comparison-report.test.ts` 接受合法 `headline`、拒绝超长字段。`test/result-page.test.ts` 断言结果页显示 `headline`、隐藏 `satisfied` 理由、跳过对照不出现 Report 与两边句。
