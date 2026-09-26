# 决策：对比阶段出口与草稿预检

状态：accepted

## 问题

一次真实 Comparison 的 `understand` 轮持续近十分钟，已写报告并多次预览，后续调查、创作与审阅又重复相似工作。草稿把必需的 `data-agent-slot` 改成 `data-slot`；`preview_report` 仍返回可渲染的 `ok`，最终发布才以 `report_incomplete` 失败。单纯缩短预算会截断复杂任务，却不能告诉 Agent 何时证据已足够。

## 决定

- 保留同一 Session 的理解、调查、创作、审阅四轮。理解轮定位最终交付物和会改变用户取舍的问题；调查轮在下一项检查不可能改变推荐、置信度或重要限制时停止。没有新的墙钟、模型请求或预览次数上限。
- 生产 Comparison 在理解轮拒绝 `shell_exec`、`render_artifact`、`register_evidence`；在创作轮前拒绝经 `write`/`edit` 修改 `report.html`；在审阅轮前拒绝 `preview_report`。工具返回明确的 `phase_not_ready`，Agent 可在正确阶段继续。此限制是工作流程边界，不改变候选 Runtime 的预算或用户取消语义。
- 创作结束后，以及审阅可能改稿并返回信封后，用正式发布使用的 `agentContentFromDraft` 预检草稿的 HTML 结构、Agent 槽位及被动内容边界。错误在同一 Session 反馈并允许修稿、重审；相同草稿 digest 与相同错误再次出现时判为无进展，保留可诊断的失败，不按固定重试次数截断有效修复。
- `preview_report` 在截图前运行相同预检。结构无效返回 `invalid_report` 和具体错误，不花费渲染；成功反馈里的 `publicationStructure=valid` 只表示 Agent 结构可提取，不承诺完整发布成功。证据、媒体、模型实际收到的图片、最终信封和 Host 重建校验仍由正式发布把关。Host 不自动猜测或迁移缺失的 Agent 槽，也不把草稿当作可信结论。
- 阶段提示明确现有报告壳和停止判据。生产装配提供同进程预检函数；修复提示通过现有 Agent Session 事件审计进入模型输入，可从事件重放。

## 备选方案

**缩短模型调用或墙钟预算。** 这只能在固定时点截断对比，无法判断是否已找到决定性证据，也不能提前发现草稿结构错误。

**只加强 Prompt。** 本次 `understand` 轮已越过提示中的阶段目标，单靠措辞不足以阻止提前写报告和重复预览。

**让预览 `ok` 代表完整可发布。** 最终信封和图片实际交付状态在预览时尚不确定，过早承诺会制造新的错误信号。

## 影响

本次只约束已识别的工具入口，不把任意 shell 文本解析成文件写入策略；Comparison 现有 shell 只读挂载和写入约束继续生效。长任务仍可在调查轮进行必要检查。若后续记录显示单凭阶段提示仍长期空转，再考虑结构化阶段检查点；若报告反复被整页重写，再考虑由 Host 接收结构化 Agent 槽内容，而不是放宽提取规则。

## 验证

`comparison-agent-phases.test.ts` 以越界工具调用反例证明理解轮无法提前执行深度调查、写报告或预览；以坏草稿反例证明结构错误在审阅前得到修正，原地打转会退出。`comparison-render-tools.test.ts` 用 `data-slot` 替代 `data-agent-slot` 的真实失败形式证明预览在渲染前拒绝。`comparison-host-rebuild.test.ts` 继续证明 Host 外壳缺失或修改可重建，而 Agent 槽缺失、重复、嵌套和危险内容不能发布。代码变更须通过 `npm run check`；真实 Runtime 只在显式 opt-in 时运行。
