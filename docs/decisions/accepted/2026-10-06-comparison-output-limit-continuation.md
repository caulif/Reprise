# 决策：Comparison 输出截断采用同阶段有界续写

状态：accepted

## 问题

真实 Comparison 可以在纯 reasoning 或已执行工具之后达到 Provider 输出上限。将 `length` 当正常完成，会让尚未完成的调查或审计进入后续阶段；仅重启整个审阅又会重复检查、重置审计 epoch 并浪费原预算。另一次真实草稿在 Host 已修复 Runtime 价格口径后仍沿用“基线更便宜”的旧结论，说明正确指标必须在当前决策输入中可见。

## 决定

- Pi 自由调用仅在显式 opt-in 的 `yieldAfterTurn` 路径，将 `length` 返回为 `yielded/output_limit`，不视为正常完成。已有工具错误、硬限、取消和 Provider 错误优先，普通调用行为不因此改变。
- Comparison 在一个实际 work/phase/pass 内仅允许一次输出截断续写。首次 `output_limit` 后，以同 Session、同工具范围、同审计 epoch 发起真实下一次调用；不是将截断正文拼成已完成结果。第二次仍截断则返回 `failed/invalid_output/protocol`，不进入 compose 或 preview。
- 续写短提示只要求完成当前范围的剩余必要动作、保留未检关系、核对逐侧实际 Host 指标，不重启调查或完整审计，也不假定口头计划或已成功的工具证明审计已结束。已交付当前 inspection 仍需真实后续非截断完成回合，才能进入既有 preview closure。
- 两次调用复用首次计算的绝对 investigation/source deadline，不延长局部预算；整体剩余 timeout 与硬限按当时资源重算，lane、effort、maxTokens、工具与资源阈值均不变。错误、取消、硬限及其它资源 yield 不触发本续写；原 findings-only/source-timeout 收束规则保持。
- compose/review 的每次真实工作输入补充紧凑的 Host-owned 双侧指标：现有 elapsedMs、totalTokens、costUsd、usageStatus、pricingStatus、pricingSource、pricingVersion。缺失明确 `unknown`，零保持零；不产生赢家、总账或新的估算。提醒逐侧核方向，不能从运行时长推断费用或继承历史报告价格断言。调查与 findings-only 输入不新增此对照，不改变工具范围。
- 指标对照和续写提示均经原 `agent.message_appended` 与真实 generation 输入记录，可复原；phase outcome 聚合本 work 中实际请求与工具计数。续写不再次调用 `onDraftAuditStarted`，不另造接受稿、审计账本或持久化协议。可见指标提高输入可靠性，不认证模型语义正确或真实账单。

## 备选方案

**提高输出上限或预算。** 不能保证纯 reasoning 及时完成，且改变评测参数。

**无限续写或重新启动审计。** 前者重复消耗并削弱阶段边界；后者可能丢失源检查和当前 inspection 的因果绑定。

## 影响

选择同阶段一次真实续写，保留正常工具执行、输入审计、发布校验和全部失败边界。单次 model request 的 Provider maxTokens 不变，第二次请求计入原全局账本。

## 验证

原生 Pi 消费者逆例覆盖纯 reasoning 截断后真实 inspection/action、length 中被 SDK 拒绝的截断 inspection 不得产生副作用或直接 preview、续轮真实 inspection 后才进入 closure、double length 明确失败、同 review Session 与 audit-start 一次、费用方向对照实际进入模型输入和事件、取消/费用硬限优先。Provider 另验证先前完整 toolUse 的副作用在后续截断时保留且不会重放；不虚构 length 中的截断工具已经成功。另验证两类局部 deadline 的续写绝对时间不变、未知与零区分、普通错误与其它资源 yield 不续写。统一 build 后运行 phase-yield、Provider 针对测试及全门禁；自动化通过不作为真实 Comparison 语义或用户阅读验收。
