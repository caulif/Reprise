# 决策：Recovery 使用进展感知重试与已验证来源简报

状态：accepted

## 问题

共享 Pi adapter 的一次 `continue()` 可能包含多个成功响应和已执行工具，也可能在后续请求再次遇到瞬时故障。按整轮 continue 次数限重试会让相隔成功工作的网络失败耗尽同一预算。短于一秒的退避也不适合上游网络恢复。

Recovery 已经探测 source Git，但文本 briefing 只提供历史线索，容易重复检查；提示词未清楚区分文件工具的 observations 虚拟挂载与 shell cwd。工具拒绝合法尾斜杠和 preflight 拒绝含 `/` 的模型名又造成额外失败。

## 决定

- Pi adapter 只在成功模型 turn 后重置连续失败预算。错误响应、部分失败文本、错误消息数量增长和压缩均不算成功进展。连续瞬时网络/上游故障最多三次请求，两个重试前分别等 2 秒、4 秒；原 Session 历史保留已完成工具结果，继续而不重放原 prompt 或工具。context overflow 仍仅允许一次真正缩减输入的恢复。
- 每次恢复循环重新检查原取消与致命工具/审计状态。整体截止不重置，致命回调和工具失败不能借重试降级为成功，也不因先前成功 turn 获得新 deadline。普通调用中已被模型处理的可恢复工具错误仍按既有语义完成；原生工具错误锁存仅在尝试网络恢复或让出时阻止隐藏失败，不改变普通成功返回。此为共享 Provider 语义，对使用它的各角色一致。
- Recovery briefing 直接投影既有 source forensics 中的 repository、HEAD、historical commit object presence 和 status availability。未成功取得的值保持 unknown，不把线索、历史任务前边界或工作副本当前状态说成已验证。复用 `recovery.model_input` artifact 和模型请求审计保存新增输入，完整历史仍在 observations，按任务相关疑问读取。
- observations 只经文件工具读取，不新增 shell env 映射或外部写权限。source 继续使用既有只读保护及 shell env。合法相对目录路径允许一个尾斜杠，仍拒绝空中间段、`..` 与绝对路径。
- preflight 的 modelId 与模型请求等现有 schema 一样使用非空文本，不把供应商模型名称当文件 ID。旧记录保持有效，无版本迁移；新含 `/` 记录回滚至旧代码时可能被旧验证器拒绝。
- failure.message 复用共享凭据脱敏，并补 URL userinfo 脱敏；在非 TUI 失败边界去除 ANSI 终端序列并将其余控制字符替换为空格。Recovery 瞬时错误的一行解释保留有界 HTTP/TLS 原因，而非仅持久化通用展示 key。完整安全原因仍在 recovery.json。解释仍受既有 240 字符 schema 限制，旧展示 key 仍兼容。

## 备选方案

**跨会话全局 provider 冷却。** 单任务也会遇到相同上游故障，缺少证明全局协调收益的证据；新增共享状态、取消和 provider 身份契约会扩大本次范围，暂缓。

**新增 observations shell 挂载。** 命令文本检查不是任意脚本的只读沙箱；没有相同文件系统保护时不新增映射。

## 影响

成功工作之间的瞬时故障不再提前耗尽重试预算；没有成功进展时仍有明确上限。重试不修复上游 TLS、DNS 或代理，持续失败应如实终止。briefing 帮助模型先使用已有事实，不硬编码特定历史任务的恢复策略。工具写权限、机械验证与整体时间边界保持原语义。

## 验证

无费用 Pi fixtures 覆盖间隔成功工具的三次网络失败可以继续、已完成工具只执行一次、部分失败文本不重置预算、连续失败保持三次上限及 2/4 秒退避、退避取消和 overflow 失败。现有工具前置条件、审计、取消及 yield 测试继续约束终止边界。

workspace 工具回归覆盖 source/workspace/observations 单尾斜杠及越界、绝对路径和空中间段逆例；preflight 持久化回归覆盖含 `/` 模型名和空名拒绝。briefing 测试区分 false 与 unknown；Recovery 集成测试验证脱敏 HTTP/TLS 解释及 recovery.json 不泄漏凭据。以上不替代真实网络可用性或真实模型恢复质量验收。

架构检查仅豁免 `isRepo: facts.git.isRepo` 的直接事实投影；注入按 `facts.git.isRepo` 决定 ready 的反向样例必须仍失败，既有候选选择禁令继续有效。普通完成的 recoverable 工具错误用例保持通过；含 ANSI 清屏/颜色序列、响铃及换行的失败文本在保存的一行解释和 recovery.json 中不得保留这些控制字符。
