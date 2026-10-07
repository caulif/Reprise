# 决策：严格 Comparison 作者阶段只创作报告

状态：accepted

## 问题

同一作者会话保留调查工具，报告创作阶段可以继续 shell、渲染、注册新证据及重写 findings，挤占独立审阅和发布预算。原例实际出现长创作、完整 findings 的措辞压缩及稿件长度修复；这些观察不能证明所有完整更新都无必要：调查截止时已保存的 findings 可能为空，作者确需新增已收到证据支持的条目。

## 决定

仅当 `getSubmittedResult` 和 `enforcePhaseBoundaries` 同时启用，compose 使用独立的工具边界。模型请求只公开 `read`、`quote_evidence`、`write`、`edit`、`submit_comparison_draft` 和 `update_comparison_findings`。执行包装同样拒绝其他工具及其完成回调，防止忽略 allowedToolNames 的 adapter 产生新调查、注册、检查或预览效果。

报告作者使用已经收到的源材料、观察和 findings。真实必要的纠错与新增保留原完整更新及绑定差量，不设次数配额、不伪造更新、不改 Schema 或持久化。已有 binding 优先 delta；完整输入继续用于新增 ID。长度拒绝优先缩短报告字段；Host 渲染的支持范围也可改为含义等价的简短措辞，但不能为字数改变任务标准含义、原始观察、证据事实、finding/question identity 或问题历史，不得遗漏决定性的反证和未知边界。未知仍须限制结论，不能以阶段收窄为成功证据。

helper 读取当前 phase，调查阶段及 fresh independent review 的原工具能力完整保留。已接受作者稿仍仅触发独立审阅，不认证 findings、语义、预览或发布。模型可见阶段说明沿现有 prompt/event 输入审计进入日志；集成不得只改变提示或 UI 隐藏。

## 备选方案

**完全禁用作者 findings 更新。** 调查截止后可能尚无已验证 finding，新增 ID 需要完整输入；禁止会迫使作者捏造已有依据或失去正确纠错路径，拒绝。

**给 findings 更新次数配额或自动忽略重复输入。** 可能截断必要修复、隐含接受未执行更新，且不能保证语义，拒绝。

**只强调提示或过滤模型工具列表。** adapter 仍可能调用被隐藏工具，必须同时使用执行 guard。

## 影响

收窄的是严格生产报告创作能力，不增加阶段、预算、外部依赖或任务专用规则。正文依赖已注册引用；作者不能为新检查注册证据，已有 quote 仍读取真实注册源。无法完成的调查交由独立 review 或报告的条件边界，不自动降格成成功。

缺少任一严格选项的 legacy 调用透传原工具、回调与提示行为。新 helper 不持有 findings 状态机，不裁决输入语义，不减少完整审阅、新正式 inspect、后续 generation 与 matching preview 的发布要求。

## 验证

独立逆例覆盖忽略模型工具列表后强行调用 shell/render/register/inspect/preview/未知扩展：实际效果和完成回调均不得执行。另覆盖原完整与 delta 参数原样转发、真实 accepted 回执原样保留、必要更新无配额、调查到创作再到独立 review 的工具恢复、两种严格选项缺失的 legacy 兼容、取消和工具失败传播。

主任务集成后统一 build、focused 和完整门禁，并通过生产模型输入测试验证 compose 允许列表及阶段说明的真实交付。真实耗时与语义稳定性需要独立验收；工具边界通过不能当作原例或通用校准通过。
