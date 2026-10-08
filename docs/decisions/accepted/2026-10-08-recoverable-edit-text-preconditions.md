# 决策：精确文本编辑未命中与歧义属于可纠正前置条件

状态：accepted

## 问题

Recovery 编辑临时笔记时，`oldText` 未命中会抛出普通异常。模型虽然能收到错误、重新读取文件并成功纠正，Host 仍会将先前异常锁存为致命 `AgentToolFailure`，从而拒绝整轮结论。共享 broker 的多次命中检查存在同一问题。

## 决定

扩展同进程 `ToolPreconditionRejected` 的理由为 `edit_text_mismatch`。该类型表达可信 Host 的确定性前置条件拒绝，不局限于写策略；已有 `read_only_mount`、`host_write_policy` 和 `invalid_path` 理由继续有效。这补充了[Host 前置条件决策](2026-10-06-recoverable-host-tool-preconditions.md)的允许范围。

只有共享 workspace `edit` 在权限、symlink 和 regular-file 检查以及实际读取成功之后发现 `oldText` 未命中或不唯一，才使用新理由。此时尚未执行 journal 或文件修改，错误提示模型重新读取文件并提供唯一精确文本。实际读取错误、写入失败、内容大小限制、symlink 和其它未知异常维持原致命路径。既有只读 mount 与 Host 写策略仍先于文本匹配检查，不扩大权限。

复用 instrument 与 Pi adapter 现有的实例分类，继续生成 `agent.tool_failed` 和 native `isError=true`，不按错误消息或名称豁免，也不返回假成功。审计、完成回调和 native hook 即使抛出此类型仍按原边界失败；取消与硬限不降级。模型纠正后可完成或正常让出，并不自动证明 Recovery baseline 可接受，后续机械验证保持不变。

该分类只在原始 execute 内抛出；不新增事件字段、外部 JSON 或 on-disk schema，不改变 failed 事件含义。共享 broker 的 Recovery 和 Comparison 使用相同语义，避免在产品或应用层特判角色。

## 备选方案

**忽略全部 `AgentToolFailure`。** 会隐藏真实执行和审计失败，拒绝。

**按 `oldText` 错误文本分类或只在 Recovery 收尾放宽检查。** 前者会混淆未知异常，后者造成共享工具语义不一致，均拒绝。

## 影响

模型可依据错误读取当前文件并纠正精确文本，再完成结构化 Recovery 结论或普通工作。未纠正的工具调用仍是失败事件；是否接受起点继续由原机械检查决定。权限、事件格式及真实致命错误处理不变。

## 验证

`test/application/tool-precondition-rejected.test.ts` 使用真实 workspace broker 检查未命中和多次命中拒绝时文件不变、零 journal；经实际 Pi adapter 的无费用模型 fixture 验证 Recovery 与 Comparison 均能收到错误，重新读取并成功纠正后 completed。逆例覆盖拒绝失败事件的 typed 审计错误、后续 edit journal 失败和真实文件读取失败，均不得完成。现有逆例继续覆盖未知 execute、回调、native hook、取消和硬限失败。fixture 不替代真实模型验收。
