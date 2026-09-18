# 决策：Recovery 模型的有界重试与 forensics fallback

状态：accepted

## 背景

最新真实 5+5 中仍出现 `agent_model_failed`。在此之前，Host 即使已经完成隔离 staging、事实收集、初始 hypothesis 和候选创建，只要 Recovery 模型请求失败，最终只会留下通用失败信息并丢弃可审查上下文。该行为既没有充分利用已经获得的安全证据，也没有区分“证据不足”和“模型暂时不可用”。

## 决定

`recoverCodexExperiment` 对 `agent_failure` 与 `agent_timeout` 进行一次有界重试；默认最多两次模型调用，调用方可通过 `maxModelAttempts` 降低或提高上限。取消、隐私阻断和输出协议错误不重试：前两者不应继续执行，协议错误已经由 Agent Host 的 envelope-only repair 处理。

每次重试记录脱敏的 `recovery.model_retry` 事件，只包含第几次尝试与失败类别，不保存模型错误文本、源路径、任务正文或凭据。所有重试共享同一隔离 candidate 和工具调用预算，避免以重试绕过工具预算或扩大写入边界。

若重试仍失败而 Host forensics 已完成，系统仍以 `agent_model_failed` 终态失败，不把它改写为 `insufficient_evidence`，也不自动接受任何 candidate。它额外记录 `recovery.model_fallback`，其中只包含 forensics 完成标志、hypothesis 数、candidate 数和模型尝试数。已持久化的调查 artifact 和候选诊断可供人工审查；源目录继续保持只读，staging 仍被丢弃。

## 后果

瞬态模型故障获得一次受审计的最大努力重试；不可恢复的模型故障仍可保留 Host 已完成的调查价值，而不会伪造恢复成功、泄露内容或扩大自动接受面。该策略不替代 checkpoint 的确定性恢复，也不增加默认路径的真实 Runtime 调用：真实调用仍必须显式 opt-in。

## 验证

`test/codex-experiment.test.ts` 覆盖连续两次模型失败：断言恰好执行两次、生成一次 `recovery.model_retry` 和一次 `recovery.model_fallback`，保留 `agent_model_failed` 失败层并给出可审查诊断提示。`npm run check` 继续覆盖构建、静态门禁和全量测试。
