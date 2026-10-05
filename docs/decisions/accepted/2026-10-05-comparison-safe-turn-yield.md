# 决策：Comparison 在完整 Provider turn 边界让出阶段

状态：accepted

## 问题

调查软额度此前只让工具返回收尾提示，无法停止 Provider 内部的多轮生成。模型仍可能反复调用已拒绝工具，或在 preview 成功后继续生成直到共享硬时限结束。直接 abort、把 SDK 的最后一条 tool-call assistant 当成 completed，都会混淆中断与完成；提前返回预览结果还可能跳过完整 inspection 真正进入下一次模型请求的门禁。

## 决定

- Freeform 调用可提供 Host 的 `yieldAfterTurn` 控制函数。Pi 使用现有 `shouldStopAfterTurn`：当前 assistant 与整批工具实际结束、usage 汇报后，在下一次生成前判断；不添加模型工具或任意 JavaScript 控制入口。
- 返回显式 `yielded`，记录 `agent.invocation_yielded`，不写 `agent.invocation_completed` 或伪造最终文本。Provider 必须真正 idle；Host 等待受原 invocation 信号和超时限制。外部取消、Provider 错误、持久化错误和共享硬额度失败优先，不能转成 yield。
- 调查与独立 source pass 的软限制在安全 turn 边界机械让出，允许正在运行的请求/工具完成；它不是精确抢占计时器。原硬时限仍约束当前调用，不增加额度。阶段统计记录实际 outcome、pass 与 yieldReason。
- 调查让出后，最多沿用已有两次无进展修复边界，使用单个 Provider turn 收尾 findings；不能重新调查，未知问题必须保持可见并正确说明不可用。历史问题与所有发布门禁保留。
- 独立 source pass 让出后可进入同一 fresh Session 的 draft 审查，但明确 source pass 不完整，未检查的成功保证不能因此认证。
- draft review 仅通过 Host 原 `getSubmittedResult` 判断可发布；该 getter 必须同时满足当前 receipt、preview 和正式 generation 实际包含完整绑定 inspection 的验证。inspect+preview 同批工具结束时还没有下一次 generation，不能立即作为 report_ready。
- draft 收尾不因累计 review 软额度在每个内部工具 batch 后让出；历史问题修复、重提、正式 inspection、preview 及后续真实 generation 可在同次调用内完成，避免把内部修复拆成无进展阶段退出。扩展调查的 read/render/register 等仍受原工具软限制拒绝；共享硬限制、外部取消与已有 Host 无进展边界保留。可发布时才正常 report_ready yield，不增加默认额度。
- structured 调用与未提供 yield policy 的调用保持普通成功/失败语义。事件输入重建将 yielded 视作 invocation 终端，保留实际 tool results 供下一轮重建；TUI 清理当前活动，不把它标成业务完成。

## 备选方案

**继续只靠工具反馈和 Prompt。** 能提醒模型收尾，却不能阻止 Provider 在拒绝结果后继续请求，因而仍可能耗尽共享预算。改为在 SDK 已有完整 turn 边界执行 Host 决策，保留模型实际观察与工具配对。

**软额度到时立即 abort 或把最后一条 assistant 当成 completed。** 前者可能截断副作用或未收齐的工具结果，并产生下一阶段与旧调用并发的风险；后者会把带 tool calls 的 assistant 误作阶段完成。选择显式 yielded、等待 idle，并保留原硬截止作为在途请求的失败保护。软额度允许当前 turn 超出软时间，但不能借此绕过整体硬额度。

**新增调度服务、独立完成状态或扩大预算。** 当前 Session、资源 tracker、Pi stop hook 和恢复输入认证已能承担职责；新的独立状态容易与真实事件和绑定分叉。复用原发布 getter 与恢复检查，不新增评分、完成凭证、费用额度或第二份事实源。

**在 draft 每个内部 batch 后按累计 review 软限制让出。** 真实校准显示 source 用尽软额度后，draft 的 stale inspection、历史问题修复与重提会连续触发 yield；Host 无进展计数先耗尽，正式 inspection 和后续 generation 尚未完成，仍有共享额度却无法交付。机械让出限定调查/source，draft 允许已有收尾工具链在同一调用内推进；调查扩展继续被拒绝，硬保护保持原值。

## 影响

Freeform Session/Provider 端口新增可选 yield 控制和显式结果；无 policy 与 structured 调用保持原语义。`agent.invocation_yielded` 的 payload 经过 core schema 校验，输入重建、评估后缀检查和 TUI 认识该终端事件；它表示一次 invocation 让出，不表示实验或业务完成。既有日志仍可读取，旧历史成功和失败不重写。

Comparison 共享额度、attempt 身份及来源/问题历史门禁保持原约束。调查和 source 审阅可能以不完整状态让出，后续内容须收窄支持范围；机械让出并不认证这些自然语言判断。正式发布使用既有恢复绑定核对真实 generation 输入，可能拒绝此前仅凭 inspection/preview 回执判定成功的路径。真实 Provider 错误、硬失败及取消仍失败或取消，不因已经保存草稿而发布。

等待 idle 和最终输入重建会产生本地时间开销，受原 invocation/attempt 截止保护。软时间是安全边界上的收敛目标，不能保证在途模型响应或工具在该毫秒精确停止；此限制须保留于实际审计，不通过增加额度掩盖。

## 验证

`agent-session-yield.test.ts` 覆盖 idle 等待、原 Session 继续、整批副作用不重放、真实错误/取消/硬失败优先；`comparison-phase-yield.test.ts` 覆盖调查收尾、source 不完整范围、generation 未收到 inspection 时不得发布及共享请求上限。native Pi 逆例在 source 软额度已耗尽时，需要七个 draft 内部 generation/tool turn 才完成 stale inspection 修复、历史问题重提、正式 inspection、preview 和真实后续输入；验证扩展调查仍被拒绝、硬耗尽与取消仍不发布。生产 generation 认证复用既有恢复检查，没有新增独立认证状态。
