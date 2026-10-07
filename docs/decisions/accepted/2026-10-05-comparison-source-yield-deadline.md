# 决策：Comparison 来源调查使用单次局部 deadline

状态：accepted

后继：严格三会话路径的来源查证与实时保存合并、非盲假设输入、完成边界及时间策略已有[有界审阅收敛](2026-10-06-comparison-bounded-review-convergence.md)作为后继，其他审计、错误优先和发布约束保留。

## 问题

完整 turn 后的 `shouldStopAfterTurn` 能阻止下一次生成，却不能限制已开始的 thinking。真实评估中，来源调查最后一次请求在累计 118887ms 开始，软额度只剩 1113ms；随后请求持续 111463ms，以 length 和纯 thinking 结束，来源调查累计 230353ms。hook 正常让出时，整体硬限前只剩约 30 秒，draft 没有完成 inspection 或 preview。此前首次 findings 检查点已走通，本次失败不能归因于没有保存。

## 决定

- Freeform Work 与 Provider append 新增可选 `yieldDeadline: { at, reason }`，at 是绝对毫秒时间。仅 Comparison 独立 source pass 使用，取既有累计 review 时间余额与整体保留收尾时间的较小者，不改 120 秒软预算、600 秒整体硬预算或模型参数。空资源 override 没有局部 deadline，旧 Provider 可忽略可选字段，但普通 timeout 仍失败。
- Pi 的本次 append 拥有局部 timer。到时只 abort 当前 SDK activeRun，使用本次合并信号约束 context compaction 和恢复调用；生成/压缩在等待请求审计后复核取消。已过期时不发模型请求。远期 at 用分段 timer 重新核绝对时间，避免 Node 大于 32 位延时的 timer 溢出。
- 已知本地 deadline 中止后，必须等待真实 prompt/tool 生命周期结束、SDK idle 和 usage 审计完成，恢复本次工具面并清 timer，然后返回已有 typed `yielded`，独立 reason 为 `bounded_source_timeout`。不得调用会永久关闭 Session 的 cancel，不在 Host 的 timeout race 返回之后伪装 idle。后续 draft 复用同一独立 review Session 的真实来源上下文。
- 局部 reason 不能吞错误。raw Provider terminal/error、同步 stream 抛错、compaction 错误、请求审计与工具错误独立记录；即使 SDK 因取消把最后消息标 aborted，真实错误仍优先失败。仅在异常对象等于本次合并信号 reason、主动 abort 的当前 SDK 信号 reason，或 cause 链明确引用这些对象时识别为已知取消；不凭 AbortError 名称认证，独立同名异常和未知异常保守失败。外部用户取消、整体 invocation timeout、共享硬保护与持久化错误均不能转成局部 yield。原自动 retry 行为不扩展。
- Provider terminal aborted 到达时若实际请求信号尚未取消，立即记录独立失败，后续 usage 审计等待越过 timer 也不能改写来源。可见 assistant 审计监听器同样保留原错误。工具、hooks 与 compaction completion 通过函数调用外层的 try/await/catch 捕获同步抛错和异步拒绝；SDK 将错误转换成工具结果或 aborted 消息不能抹去本次失败记录。
- Host 将实际 deadline 控制配置通过 core `Value.Check` 后记入 `agent.invocation_started.yieldDeadline`；终态仍记录 `agent.invocation_yielded` 与阶段真实统计，不写 invocation completed 或假造 assessment。deadline 是 Host 控制事实；模型可见输入仍按原 actual generation Context 快照恢复，不修改该协议。deadline-only 的 generic work 返回类型包含 yielded。
- `bounded_source_timeout` 表示可能在完整 turn 前中止，必须明确 source pass 未完成，即使没有可见 assessment 也不能补写成功观察。draft 只能使用真实保留的来源观察，未经检查的保证不能认证；inspection、当前 digest 预览、后续真实 generation 与所有发布门禁不放宽。正常安全 turn yield 保留原 reason。

## 备选方案

**缩短 Host timeout 并把 agent_timeout 映射成 yield。** Host abortable 会先返回失败，Provider 可能还未 idle 或 flush；失败也可能来自真实服务 timeout。该映射既混淆错误，又允许下一阶段与旧调用竞争。局部中止由 Provider 本次 append 明确拥有并完成清理。

**在 before-model 审计抛软预算异常。** SDK 会把异常当 error/aborted，不能认证安全让出；也无法限制已开始的长请求。保留完整 turn hook，并另提供有来源的局部 deadline。

## 影响

新增可选 Harness Session/Provider 契约和 invocation 控制审计，不增加 Runtime 产品端口、工具或费用。旧日志与 Provider 保持兼容；忽略 deadline 的 Provider 不获得中止认证。局部 timer 只作用于本次 append，错误记录不跨调用泄漏，后续 source→draft 不换 Session。真实停止和审计可能需要时间，整体硬限仍优先；不承诺网络供应商立即停止计费，也不承诺真实报告语义通过。

## 验证

原生免费测试覆盖 deadline-only Host 调用、零可见 assessment、真实 usage drain 前不得 yield 或下一生成、同一 Session 继续、控制审计配置、过期 deadline 零 upstream、正常安全 turn yield 与 timer 清理、远期 timer 溢出逆例、deadline 在请求审计 await 时零 upstream、未启用图片/工具权限不扩展。外部取消与整体 timeout 在 drain 期间优先；Provider 401、raw 工具错误、usage audit 错误与 SDK aborted 掩盖的原始错误均不得改成局部 yield。Comparison 消费者另覆盖 source-only 绑定、无可见 assessment 时的不完整范围、共享硬限、旧 Provider 普通 timeout 与正式 inspection/preview/generation 门禁。编译后运行定向 native/Comparison 测试与 `npm run check`；真实模型语义验收须另提供证据。
