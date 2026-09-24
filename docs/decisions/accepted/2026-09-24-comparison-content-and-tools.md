# 决策：Comparison 内容文件、受管调查工具与预览收据

状态：accepted

## 问题

旧 Comparison 让 Agent 编辑完整 `report.html`，再从草稿抽取可发布区域。这个方式把页面所有权、模型可写范围和最终校验混在一起；预览后改稿也可能让先前的视觉检查失效。调查工具仅有文件、shell 与单次渲染，缺乏明确的能力探测、来源绑定和受控的页面观察。历史证据不完整或本机没有浏览器时，旧双图断言还会使整个对照失败。

## 决定

Agent 只写 `work/report/content.json`、`body.html` 和可选 `details.html`。`content.json` 版本 1 含标题、关键限制和证据短引用；Host 从当前 attempt 的任务、模型、指标、状态、证据与媒体重建整页。内容文件与预览收据是唯一 authoring 合同；`report-model.json` 仅接受当前 formatVersion 2 与当前槽位，不再读取缺版本、格式 1 或旧四区模型，也不自动迁移历史 attempt。已有 `report.html` 文件不被删除或改写。`report.html` 是 Host 输出，Agent 不可写。理解、调查阶段只可写工作笔记与 scratch；进入创作前若报告内容已出现，拒绝继续。创作和审阅阶段才允许文件工具写内容文件。shell 用于受控调查，不作为报告内容的发布入口。

`preview_report` 对当前内容、事实、catalog revision 和已交付图片计算指纹，运行与最终发布相同的校验，并在 attempt 内记录收据。创作和审阅共用一次内容修复额度；审阅后再改稿必须重新预览，过期收据不能发布。Host 校验后先关闭受管进程与浏览器，再复制登记的媒体和派生证据，最后替换实验根的报告；清理、hash 或引用失败不得覆盖上次成功报告。证据链接在预览与发布目录都必须指向可打开且字节与登记 hash 一致的文件。

能力清单由 Host 探测并写入 briefing。浏览器页面只从 Host 登记的冻结 `sourceRef` 打开；网络请求受限，操作与截图绑定来源、版本、URL 摘要和动作链。`fetch_url` 只接收受限 HTTPS 资源；搜索需要显式配置的 Brave endpoint 与环境变量凭据。CSV、JSON、PDF 和 OOXML 文本提取走有界子进程，保留来源位置与提取限制。可选 ffprobe、ffmpeg 与 Tesseract 分别通过 `reprise enhance inspect-media`、`extract-frame`、`ocr-text` 受控调用；版本检测仅证明可启动，单次操作仍需执行校验。LibreOffice 只探测版本，因禁宏、外链、profile 和输出隔离未建立，转换操作明确不支持。缺浏览器或截图失败写入限制，保留可用文本、原始文件和机械报告，不把工具能力缺口等同任务失败。`render_artifact` 暂保留给尚未由受管浏览器覆盖的冻结来源。

## 备选方案

**继续让 Agent 编辑完整 HTML，再由 Host 抽取区域。** 仍需处理 Host 区污染、页面结构歧义和预览后改稿；可见的 authoring 合同也比三个小文件更难约束。

**把所有调查能力统一交给 shell。** 无法可靠限定浏览器来源、页面隔离、网络目的或媒体发送授权，也难把工具结果与登记来源一一对应。

## 影响

- 已发布的 `report.html` 文件和事件日志仍保留；旧 `report-model.json` 若不满足当前 formatVersion 2 合同，读端明确拒绝，没有自动映射或迁移。新 attempt 不接受 Agent 写旧四区 HTML。回滚到旧版本不会理解新内容文件，保留原始 attempt，不能把新文件改写为旧格式。
- 新模型可见工具输出必须经过现有 Host 事件审计；注册的证据/媒体以 schema、来源和内容 hash 约束，`available` 不等于允许向模型发送二进制图片。
- 页面截图 `sampleTimeMs=0`，实际耗时另存；派生去重包括来源与动作但排除捕获时间。导航 URL 的 query/hash 在模型可见诊断中省略，不能据此声称完整复原。
- 没有真实 Runtime 或模型费用的默认测试；受管浏览器、网络和提取器使用离线 fixture 验证。Windows 11 是当前唯一真实使用验证平台。

## 验证

内容和预览回归位于 `comparison-report-content.test.ts`、`comparison-render-tools.test.ts`、`comparison-agent-phases.test.ts`；来源与发布边界由 `comparison-source-integrity.test.ts`、`comparison-evidence-publication-review.test.ts` 覆盖；工具边界由对应 process、fetch、extraction 和 browser 测试覆盖。源码修改收尾执行 `npm run check`。
