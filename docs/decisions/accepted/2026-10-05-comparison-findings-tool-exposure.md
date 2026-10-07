# 决策：Comparison findings 收束调用只暴露发现更新工具

状态：accepted

## 问题

findings 收束调用已经通过执行门禁禁止继续调查，但模型请求仍展示完整工具集。模型只能在尝试调用后才知道工具被禁止，暴露面与本轮实际允许的工作不一致。真实评估的首个收束请求还出现 `stopReason=length`、16384 个输出 token 全部为 thinking、没有可见正文或工具调用，消耗约 122 秒。这个结果证明收束没有及时完成，不证明完整工具集是其唯一原因。

## 决定

- `FreeformWorkRequest` 与 `ProviderSession.append` 新增可选 `allowedToolNames`。它只限制本次调用中模型可见的既有工具，不注册新工具、不扩大执行权，也不改变其他阶段的默认工具或预算。
- Comparison 仅在 findings 收束调用传 `['update_comparison_findings']`；调查、compose、sources review 与 draft review 保持默认值。两次允许的实际收束调用使用同一限制，实际接受的 ready findings 才允许进入下一阶段。
- Pi 在 append 内设置本次可见工具集。结束时先等待在途生成和工具空闲、完成 usage 审计，再在 `finally` 恢复原工具集；内部工具重试和多轮生成继续使用本次限制。不能在外层超时或取消返回时提前恢复工具，让尚未停止的生成看到下一阶段工具。空列表表示不暴露工具，`undefined` 表示本次使用原工具集；未知名称不创建权限。
- generation 与 compaction 的请求包装层在输入审计前及等待审计后复核原取消信号；SDK 在工具取消后再次进入生成入口，也不能因此继续调用 upstream。审计已提交的请求快照不表示网络发送或供应商接受。恢复工具列表仍等待真实 idle 和 usage 审计，不用提前恢复掩盖取消窗口。
- 原 `closure_only` 执行门禁保持不变。旧第三方 Provider 可忽略新可选字段，继续按原端口运行，但其尝试调用调查工具仍被执行门禁拒绝。不能仅凭传参或提示词声称该 Provider 已隐藏工具。
- 可见工具集的证据来自实际 generation Context 的 `tools` 快照，按[实际上下文快照契约](2026-10-05-generation-context-snapshot.md)保存和重建；Session 注册工具列表及旧事件投影不能代替这项证据。快照只证明已记录的模型输入，不证明供应商接受、模型一定调用工具或发现语义正确。
- 不调整 Comparison lane、effort、maxTokens、轮数、时间、请求或费用保护。白名单使请求面与执行许可一致，不能承诺消除 thinking 截止、时限失败或遗漏反例；这些仍需实际评估、独立语义审阅和明确的失败状态。

## 备选方案

**只重复收束提示词或取消执行门禁。** 前者不能修正模型实际看到的工具集；后者扩大执行权并允许继续消耗调查资源。保留执行门禁，使用既有 Provider 工具配置限制本次暴露面。

**修改全局 Session 工具或在 Host 超时返回后立即恢复。** 前者会影响下一阶段，后者可能与在途生成竞争。工具切换和恢复归属于实际执行 append 的 Provider 生命周期。

## 影响

新增字段是可选的同进程调用契约，不改变 Runtime、持久化 findings 格式或 CandidateRun 状态。内置 Pi 实现可见工具限制，旧 Provider 保持兼容且不获得额外认证。generation 快照保存真实当前工具集；历史报告和请求记录不迁移。

## 验证

Comparison 调用逆例检查旧 Provider 忽略白名单后，调查工具仍返回 `closure_only` 且不发生副作用；只在 findings 调用传白名单，其余阶段不传。native Pi 测试检查实际收束请求只含发现工具、非法工具不能调用、接受后 compose/review 恢复完整工具集，重试、无工具口头承诺、硬保护和取消仍保持原边界。Provider 生命周期另覆盖成功、异常、超时与取消的空闲等待和恢复，不通过释放在途执行来掩盖失败。运行编译测试和 `npm run check`；测试通过不代替真实模型收束与报告语义验收。
